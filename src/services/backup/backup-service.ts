/**
 * 加密备份与恢复服务。
 *
 * 设计要点：
 * 1) 备份文件 = AES-256-GCM 加密信封，密钥由用户备份密码经 PBKDF2-SHA256 派生；
 * 2) 负载内包含私钥明文（PKCS#8 PEM），但整个负载是密文，未持有密码无法解出；
 * 3) 备份不依赖本机主密钥，因此可以在**另一台设备/另一个浏览器**恢复；
 * 4) 恢复时私钥会用**当前设备的主密钥**重新封装后再入库，明文不做持久化；
 * 5) 恢复失败（密码错误 / 文件损坏 / 版本不支持 / 结构非法）时不得破坏原有数据：
 *    所有写入都放在解密与校验成功之后的单个 IDB 事务里。
 */
import type { BackupKeyEntry, BackupPayload, BackupSummary, RestoreMode, RestoreResult } from '@/types/backup'
import { BACKUP_APP_ID, BACKUP_PAYLOAD_VERSION, MAX_BACKUP_RECORDS } from '@/types/backup'
import type { CertificateRecord, KeyRecord } from '@/types/record'
import { DB_VERSION, getDatabase } from '@/services/storage/database'
import { listAllCertificates } from '@/services/storage/certificate-repository'
import { getKeyByCertificateId } from '@/services/storage/key-repository'
import { sealPrivateKey, unsealPrivateKey } from '@/services/crypto/key-management-service'
import {
  BACKUP_DATA_VERSION,
  DecryptionError,
  decryptWithPassword,
  encryptWithPassword,
  validateBackupEnvelope
} from '@/services/crypto/encryption-service'

export interface CreateBackupResult {
  fileName: string
  /** 备份文件内容（JSON 文本） */
  content: string
  summary: BackupSummary
}

/** 生成备份文件内容（返回文本，由调用方负责下载） */
export async function createBackup(
  password: string,
  options: { iterations?: number; note?: string } = {}
): Promise<CreateBackupResult> {
  const certificates = await listAllCertificates()
  const keys: BackupKeyEntry[] = []

  for (const certificate of certificates) {
    if (!certificate.keyId) continue
    const keyRecord = await getKeyByCertificateId(certificate.id)
    if (!keyRecord) continue
    // 解封为明文 PEM，随后写进加密负载；解封结果不做任何持久化
    const privateKeyPem = await unsealPrivateKey(keyRecord)
    keys.push({ ...toBackupKeyEntry(keyRecord), privateKeyPem })
  }

  const payload: BackupPayload = {
    app: BACKUP_APP_ID,
    payloadVersion: BACKUP_PAYLOAD_VERSION,
    createdAt: new Date().toISOString(),
    schemaVersion: DB_VERSION,
    certificates,
    keys
  }

  const envelope = await encryptWithPassword(payload, password, {
    iterations: options.iterations,
    note: options.note,
    dataVersion: BACKUP_DATA_VERSION
  })

  const stamp = payload.createdAt.replace(/[:.]/g, '-')
  return {
    fileName: `ioscert-backup-${stamp}.json`,
    content: JSON.stringify(envelope),
    summary: summarize(envelope.version, payload)
  }
}

/** 解析并解密备份文件，返回预览信息（不写入任何数据） */
export async function inspectBackup(content: string, password: string): Promise<BackupSummary> {
  const { envelope, payload } = await readBackup(content, password)
  return summarize(envelope.version, payload)
}

/**
 * 从备份文件恢复数据。
 * mode = 'merge'：保留现有记录，只新增备份中不存在（按 id）的记录；
 * mode = 'replace'：先清空本地证书与私钥，再写入备份内容。
 */
export async function restoreBackup(content: string, password: string, mode: RestoreMode): Promise<RestoreResult> {
  const { payload } = await readBackup(content, password)
  const db = await getDatabase()
  const existing = new Set((await db.getAll('certificates')).map((record) => record.id))

  const certificates = payload.certificates
  const keysByCertificateId = new Map(payload.keys.map((key) => [key.certificateId, key]))

  // 先重新封装所有私钥（异步操作不能放在 IDB 事务里，因此放在事务之前完成）
  const rebuiltKeys: KeyRecord[] = []
  for (const key of payload.keys) {
    const sealedPrivateKey = await sealPrivateKey(key.certificateId, key.privateKeyPem)
    rebuiltKeys.push({
      id: key.id,
      certificateId: key.certificateId,
      algorithm: key.algorithm,
      bits: key.bits,
      sealedPrivateKey,
      publicKeyPem: key.publicKeyPem,
      modulusHex: key.modulusHex,
      createdAt: key.createdAt,
      updatedAt: new Date().toISOString()
    })
  }

  let added = 0
  let skipped = 0
  let removed = 0

  const tx = db.transaction(['certificates', 'keys'], 'readwrite')
  const certificateStore = tx.objectStore('certificates')
  const keyStore = tx.objectStore('keys')

  if (mode === 'replace') {
    removed = await certificateStore.count()
    await certificateStore.clear()
    await keyStore.clear()
  }

  const keysToWrite: KeyRecord[] = []
  for (const certificate of certificates) {
    if (mode === 'merge' && existing.has(certificate.id)) {
      skipped += 1
      continue
    }
    const backupKey = keysByCertificateId.get(certificate.id)
    // 备份里没有私钥（例如导出前已删除）时，避免留下指向不存在私钥的引用
    const normalized: CertificateRecord = {
      ...certificate,
      keyId: backupKey ? certificate.keyId : null
    }
    await certificateStore.put(normalized)
    added += 1
    const rebuilt = rebuiltKeys.find((key) => key.certificateId === certificate.id)
    if (rebuilt && backupKey) keysToWrite.push(rebuilt)
  }

  for (const key of keysToWrite) {
    await keyStore.put(key)
  }

  await tx.done

  return { mode, added, skipped, removed, keyCount: keysToWrite.length }
}

async function readBackup(
  content: string,
  password: string
): Promise<{ envelope: { version: number }; payload: BackupPayload }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new DecryptionError('invalid-format', '备份文件格式错误：内容不是合法 JSON')
  }

  const envelope = validateBackupEnvelope(parsed)
  const payload = validateBackupPayload(await decryptWithPassword<unknown>(envelope, password))
  return { envelope, payload }
}

/** 严格校验备份负载结构，任何不符合预期的内容都直接拒绝 */
export function validateBackupPayload(input: unknown): BackupPayload {
  if (typeof input !== 'object' || input === null) {
    throw new DecryptionError('invalid-payload', '备份内容结构错误：不是对象')
  }
  const payload = input as Partial<BackupPayload>
  if (payload.app !== BACKUP_APP_ID) {
    throw new DecryptionError('invalid-payload', '备份内容结构错误：不是本工具生成的备份')
  }
  if (typeof payload.payloadVersion !== 'number') {
    throw new DecryptionError('invalid-payload', '备份内容结构错误：缺少 payloadVersion')
  }
  if (payload.payloadVersion > BACKUP_PAYLOAD_VERSION) {
    throw new DecryptionError(
      'unsupported-version',
      `备份内容版本 ${payload.payloadVersion} 高于当前支持的版本 ${BACKUP_PAYLOAD_VERSION}，请先升级网站`
    )
  }
  if (!Array.isArray(payload.certificates) || !Array.isArray(payload.keys)) {
    throw new DecryptionError('invalid-payload', '备份内容结构错误：缺少 certificates 或 keys 列表')
  }
  if (payload.certificates.length > MAX_BACKUP_RECORDS || payload.keys.length > MAX_BACKUP_RECORDS) {
    throw new DecryptionError('invalid-payload', `备份记录数超过上限（${MAX_BACKUP_RECORDS} 条），已拒绝载入`)
  }

  for (const certificate of payload.certificates) {
    if (!certificate || typeof certificate.id !== 'string' || !certificate.id) {
      throw new DecryptionError('invalid-payload', '备份内容结构错误：存在缺少 id 的证书记录')
    }
    if (typeof certificate.name !== 'string') {
      throw new DecryptionError('invalid-payload', `备份内容结构错误：证书 ${certificate.id} 缺少名称`)
    }
    if (certificate.purpose !== 'development' && certificate.purpose !== 'distribution') {
      throw new DecryptionError(
        'invalid-payload',
        `备份内容结构错误：证书 ${certificate.id} 的用途取值非法（${String(certificate.purpose)}）`
      )
    }
    if (typeof certificate.status !== 'string') {
      throw new DecryptionError('invalid-payload', `备份内容结构错误：证书 ${certificate.id} 缺少状态`)
    }
  }

  for (const key of payload.keys) {
    if (!key || typeof key.id !== 'string' || typeof key.certificateId !== 'string') {
      throw new DecryptionError('invalid-payload', '备份内容结构错误：存在缺少 id 的私钥记录')
    }
    if (typeof key.privateKeyPem !== 'string' || !key.privateKeyPem.includes('PRIVATE KEY')) {
      throw new DecryptionError('invalid-payload', `备份内容结构错误：私钥记录 ${key.id} 缺少有效的 PKCS#8 私钥内容`)
    }
  }

  return payload as BackupPayload
}

function summarize(envelopeVersion: number, payload: BackupPayload): BackupSummary {
  return {
    envelopeVersion,
    payloadVersion: payload.payloadVersion,
    createdAt: payload.createdAt,
    certificateCount: payload.certificates.length,
    privateKeyCount: payload.keys.length,
    withCerCount: payload.certificates.filter((record) => Boolean(record.cerPem)).length,
    withCsrCount: payload.certificates.filter((record) => Boolean(record.csrPem)).length,
    inErrorCount: payload.certificates.filter((record) => record.status === 'error').length,
    sampleNames: payload.certificates.slice(0, 5).map((record) => record.name)
  }
}

function toBackupKeyEntry(record: KeyRecord): Omit<BackupKeyEntry, 'privateKeyPem'> {
  const { sealedPrivateKey: _sealedPrivateKey, ...rest } = record
  return rest
}
