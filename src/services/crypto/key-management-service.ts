/**
 * 本地主密钥（vault）与私钥封装。
 *
 * 安全模型（必须在界面中如实向用户说明，不得宣称“绝对安全”）：
 * 1) 私钥以 AES-256-GCM 密文保存在 IndexedDB，明文只在需要时短暂存在于内存；
 * 2) 封装私钥用的主密钥是一个不可导出的 CryptoKey，直接存放在 IndexedDB 中；
 *    - 好处：无法被导出成原始字节带走；
 *    - 限制：同一个浏览器配置里的恶意脚本仍然可以调用它解密私钥；
 * 3) 因此本地存储只能防御“数据文件被随手翻看/误传”这类风险，
 *    真正的跨设备保护依赖密码加密的备份文件（见 backup-service）。
 * 4) 主密钥与浏览器配置绑定：清除浏览器数据会一并丢失，必须提醒用户先导出备份。
 */
import type { KeyRecord, VaultRecord } from '@/types/record'
import { VAULT_RECORD_ID } from '@/types/record'
import { getDatabase } from '@/services/storage/database'
import {
  DecryptionError,
  generateVaultKey,
  openBytes,
  sealBytes,
  type SealedBytes
} from '@/services/crypto/encryption-service'
import { randomBytes } from '@/utils/encoding'

const VAULT_VERSION = 1
/** 自检明文：用于确认主密钥与其密文匹配 */
const VAULT_CHECK_PLAINTEXT = 'ioscert-vault-check-v1'
const VAULT_CHECK_AAD = 'ioscert-vault'
/** 私钥密文的附加认证数据，绑定所属证书，防止密文互换 */
const keyAad = (certificateId: string): string => `ioscert-key|${certificateId}`

export type VaultErrorReason = 'vault-missing' | 'vault-unavailable' | 'unsupported-browser'

export class VaultError extends Error {
  readonly reason: VaultErrorReason

  constructor(reason: VaultErrorReason, message: string) {
    super(message)
    this.name = 'VaultError'
    this.reason = reason
  }
}

/** 是否已存在主密钥 */
export async function hasVault(): Promise<boolean> {
  const db = await getDatabase()
  const record = await db.get('vault', VAULT_RECORD_ID)
  return Boolean(record)
}

/**
 * 取得（必要时创建）本地主密钥。
 * 注意：如果主密钥已丢失但私钥密文仍存在，这里会明确报错，而不是偷偷新建一个密钥
 * （新建会让已有私钥永久无法解密）。
 */
export async function getVaultKey(options: { createIfMissing?: boolean } = {}): Promise<CryptoKey> {
  const db = await getDatabase()
  const record = await db.get('vault', VAULT_RECORD_ID)

  if (!record) {
    if (options.createIfMissing === false) {
      throw new VaultError('vault-missing', '本地主密钥不存在：无法解密已保存的私钥材料')
    }
    const keyCount = await db.count('keys')
    if (keyCount > 0) {
      throw new VaultError(
        'vault-unavailable',
        '本地存在私钥材料，但主密钥已丢失（可能是浏览器数据被清理）。请先通过备份恢复，不要继续新建证书。'
      )
    }
    const key = await createVaultKey()
    return key
  }

  if (!isUsableKey(record.key)) {
    throw new VaultError(
      'unsupported-browser',
      '当前浏览器无法从 IndexedDB 读取主密钥对象（可能是浏览器不支持或数据被清理）。请使用最新版 Chrome / Edge / Safari / Firefox，或通过备份恢复。'
    )
  }

  try {
    const check = await openBytes(record.check, record.key, VAULT_CHECK_AAD)
    if (new TextDecoder().decode(check) !== VAULT_CHECK_PLAINTEXT) {
      throw new Error('自检失败')
    }
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw new VaultError('vault-unavailable', '主密钥自检失败：本地主密钥与已保存数据不匹配，请通过备份恢复')
    }
    throw error
  }

  return record.key
}

/** 用主密钥封装私钥（PKCS#8 PEM） */
export async function sealPrivateKey(certificateId: string, privateKeyPem: string): Promise<SealedBytes> {
  const key = await getVaultKey()
  return sealBytes(new TextEncoder().encode(privateKeyPem), key, keyAad(certificateId))
}

/** 解封私钥，得到 PKCS#8 PEM 明文（调用方应尽快释放引用，不要写入日志） */
export async function unsealPrivateKey(record: KeyRecord): Promise<string> {
  const key = await getVaultKey({ createIfMissing: false })
  const bytes = await openBytes(record.sealedPrivateKey, key, keyAad(record.certificateId))
  try {
    return new TextDecoder().decode(bytes)
  } finally {
    bytes.fill(0)
  }
}

/**
 * 丢弃主密钥（危险操作）。
 * 调用后所有已保存的私钥密文都无法再解密，界面必须先二次确认并提示先导出备份。
 */
export async function destroyVault(): Promise<void> {
  const db = await getDatabase()
  await db.delete('vault', VAULT_RECORD_ID)
}

async function createVaultKey(): Promise<CryptoKey> {
  const key = await generateVaultKey()
  const check = await sealBytes(new TextEncoder().encode(VAULT_CHECK_PLAINTEXT), key, VAULT_CHECK_AAD)
  const record: VaultRecord = {
    id: VAULT_RECORD_ID,
    version: VAULT_VERSION,
    key,
    check,
    createdAt: new Date().toISOString()
  }
  const db = await getDatabase()
  await db.put('vault', record)
  // 生成一条随机数据做一次加解密自检，确保主密钥确实可用
  const probe = randomBytes(16)
  const sealed = await sealBytes(probe, key, 'ioscert-vault-probe')
  const opened = await openBytes(sealed, key, 'ioscert-vault-probe')
  if (!opened.every((byte, index) => byte === probe[index])) {
    await db.delete('vault', VAULT_RECORD_ID)
    throw new VaultError('unsupported-browser', '主密钥创建后自检失败，已回滚，请更换浏览器重试')
  }
  return key
}

function isUsableKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== 'object') return false
  const candidate = value as CryptoKey
  return candidate.algorithm?.name === 'AES-GCM' && candidate.extractable === false
}
