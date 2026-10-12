/**
 * 证书业务编排。
 *
 * 负责把「密钥生成 / CSR / CER 校验 / P12 导出 / 存储」串成完整流程，
 * 并根据真实执行结果更新业务状态（绝不因为点了按钮就直接标记成功）。
 */
import type { CertificatePurpose, CertificateStatus, RsaKeyBits } from '@/types/certificate'
import type { CertificateRecord, KeyRecord } from '@/types/record'
import { DEFAULT_RSA_BITS, createCsr, generateRsaKeyPair } from '@/services/certificates/csr-service'
import { certificateMatchesPrivateKey, parseCertificate } from '@/services/certificates/x509-service'
import {
  PKCS12_PROFILE_OPTIONS,
  createPkcs12,
  parsePkcs12,
  type Pkcs12ExportOptions,
  type Pkcs12Profile
} from '@/services/certificates/pkcs12-service'
import { sealPrivateKey, unsealPrivateKey } from '@/services/crypto/key-management-service'
import {
  generateId,
  requireCertificate,
  saveCertificateWithKey,
  updateCertificate
} from '@/services/storage/certificate-repository'
import { getKeyByCertificateId } from '@/services/storage/key-repository'
import { sanitizeFileName, validateCertificateName, validateP12Password } from '@/utils/validation'

export interface CreateCertificateInput {
  name: string
  purpose: CertificatePurpose
  bits?: RsaKeyBits
  note?: string
  organization?: string
  country?: string
}

/** 状态机：只允许真实业务结果对应的流转 */
const ALLOWED_TRANSITIONS: Record<CertificateStatus, CertificateStatus[]> = {
  draft: ['csr-created', 'error'],
  'csr-created': ['cer-imported', 'ready', 'error'],
  'cer-imported': ['ready', 'error'],
  ready: ['ready', 'error', 'csr-created'],
  error: ['draft', 'csr-created', 'cer-imported', 'ready', 'error']
}

export function canTransition(from: CertificateStatus, to: CertificateStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function assertTransition(from: CertificateStatus, to: CertificateStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法的状态流转：${from} → ${to}`)
  }
}

/** 1) 新建证书：生成 RSA 密钥 → 生成 CSR → 加密保存私钥 → 落库 */
export async function createCertificateWithCsr(input: CreateCertificateInput): Promise<CertificateRecord> {
  const nameError = validateCertificateName(input.name)
  if (nameError) throw new Error(nameError)

  const bits = input.bits ?? DEFAULT_RSA_BITS
  const material = await generateRsaKeyPair(bits)
  const csr = createCsr(material.privateKeyPem, material.publicKeyPem, {
    commonName: input.name.trim(),
    organization: input.organization,
    country: input.country,
    digest: 'sha256'
  })

  // CSR 内部验签没通过就不要落库（避免留下无用记录）
  if (!csr.info.selfVerified) {
    throw new Error('CSR 自校验失败，已中止保存，请重试或更换浏览器')
  }

  const certificateId = generateId()
  const now = new Date().toISOString()
  const keyId = generateId()

  // 只保存密文；明文私钥不落盘、不进日志
  const sealedPrivateKey = await sealPrivateKey(certificateId, material.privateKeyPem)

  const keyRecord: KeyRecord = {
    id: keyId,
    certificateId,
    algorithm: 'RSA',
    bits,
    sealedPrivateKey,
    publicKeyPem: material.publicKeyPem,
    modulusHex: material.modulusHex,
    createdAt: now,
    updatedAt: now
  }

  const certificate: CertificateRecord = {
    id: certificateId,
    name: input.name.trim(),
    purpose: input.purpose,
    status: 'csr-created',
    keyId,
    csrPem: csr.pem,
    csrDerBase64: csr.derBase64,
    csrInfo: csr.info,
    csrCreatedAt: now,
    note: input.note?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  }

  await saveCertificateWithKey(certificate, keyRecord)
  return certificate
}

export interface CerImportResult {
  record: CertificateRecord
  matchesPrivateKey: boolean
  message: string
}

/** 2) 导入 CER：解析 → 与私钥匹配 → 更新状态（失败时写入真实错误原因） */
export async function importCer(
  certificateId: string,
  file: { data: Uint8Array; fileName?: string }
): Promise<CerImportResult> {
  const current = await requireCertificate(certificateId)
  const artifact = parseCertificate({ data: file.data, fileName: file.fileName })

  const keyRecord = await getKeyRecord(certificateId)

  if (!keyRecord) {
    const message = '找不到该证书对应的私钥材料，无法校验证书是否匹配（请确认是否清理过本地数据）'
    const record = await updateCertificate(certificateId, {
      status: canTransition(current.status, 'error') ? 'error' : current.status,
      cerPem: artifact.pem,
      cerDerBase64: artifact.derBase64,
      cerInfo: artifact.info,
      cerImportedAt: new Date().toISOString(),
      cerFileName: file.fileName,
      lastError: message
    })
    return { record, matchesPrivateKey: false, message }
  }

  const privateKeyPem = await unsealPrivateKey(keyRecord)
  const match = certificateMatchesPrivateKey(artifact, privateKeyPem)

  const now = new Date().toISOString()
  const nextStatus: CertificateStatus = match.matches ? 'ready' : 'error'
  assertTransition(current.status, nextStatus)

  const record = await updateCertificate(certificateId, {
    status: nextStatus,
    cerPem: artifact.pem,
    cerDerBase64: artifact.derBase64,
    cerInfo: artifact.info,
    cerImportedAt: now,
    cerFileName: file.fileName,
    lastError: match.matches ? undefined : match.reason
  })

  return { record, matchesPrivateKey: match.matches, message: match.reason }
}

export interface P12ExportRequest {
  password: string
  friendlyName?: string
  /** 导出配置档（默认 modern：AES-256） */
  profile?: Pkcs12Profile
  /** 是否把证书链一并打包（如 Apple WWDR 中间证书） */
  chainPems?: string[]
}

export interface P12ExportResult {
  command: 'download-ready'
  fileName: string
  der: Uint8Array
  certificate: CertificateRecord
}

/** 3) 导出 P12：解封私钥 → 再次校验匹配 → 打包 → 自检 → 记录导出时间 */
export async function exportP12(certificateId: string, request: P12ExportRequest): Promise<P12ExportResult> {
  const passwordError = validateP12Password(request.password)
  if (passwordError) throw new Error(passwordError)

  const record = await requireCertificate(certificateId)
  if (!record.cerPem || !record.cerInfo) {
    throw new Error('尚未导入 CER 证书，无法导出 P12')
  }

  const keyRecord = await getKeyByCertificateId(certificateId)
  if (!keyRecord) {
    throw new Error('该证书对应的私钥材料已被删除，无法导出 P12')
  }

  const privateKeyPem = await unsealPrivateKey(keyRecord)
  const match = certificateMatchesPrivateKey(record.cerPem, privateKeyPem)
  if (!match.matches) {
    await updateCertificate(certificateId, { status: 'error', lastError: match.reason })
    throw new Error(`证书与私钥不匹配，已中止导出：${match.reason}`)
  }

  const profile: Pkcs12Profile = request.profile ?? 'modern'
  const options: Pkcs12ExportOptions = {
    password: request.password,
    friendlyName: request.friendlyName ?? record.name,
    ...PKCS12_PROFILE_OPTIONS[profile],
    chainPems: request.chainPems
  }
  const der = createPkcs12(privateKeyPem, record.cerPem, options)

  // 自检：用同一密码重新打开，确认私钥/证书确实在包里且匹配。
  // 注意：这是本地自检，不能替代独立工具（OpenSSL）验证，见 npm run verify:crypto
  try {
    const contents = parsePkcs12(der, request.password)
    const verifyMatch = certificateMatchesPrivateKey(contents.certificatePems[0], contents.privateKeyPem)
    if (!verifyMatch.matches) {
      throw new Error('P12 自检失败：包内证书与私钥不匹配')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateCertificate(certificateId, { status: 'error', lastError: `P12 自检失败：${message}` })
    throw new Error(`P12 自检失败，已中止导出：${message}`, { cause: error })
  }

  const updated = await updateCertificate(certificateId, {
    status: 'ready',
    p12ExportedAt: new Date().toISOString(),
    p12Algorithm: profile,
    p12FriendlyName: options.friendlyName,
    p12ChainLength: 1 + (request.chainPems?.length ?? 0),
    lastError: undefined
  })

  return {
    command: 'download-ready',
    fileName: `${sanitizeFileName(record.name)}.p12`,
    der,
    certificate: updated
  }
}

export async function renameCertificate(certificateId: string, name: string): Promise<CertificateRecord> {
  const nameError = validateCertificateName(name)
  if (nameError) throw new Error(nameError)
  return updateCertificate(certificateId, { name: name.trim() })
}

export interface CertificateDetail {
  record: CertificateRecord
  /** 本地是否还有可用的私钥材料 */
  hasPrivateKey: boolean
  /** 是否可以尝试导出 P12（证书 + 私钥 + 匹配性都满足） */
  canExportP12: boolean
  /** 阻塞导出的原因（用于界面明确提示） */
  blocker?: string
}

export async function getCertificateDetail(certificateId: string): Promise<CertificateDetail> {
  const record = await requireCertificate(certificateId)
  const keyRecord = await getKeyByCertificateId(certificateId)
  const hasPrivateKey = Boolean(keyRecord)

  if (!record.cerPem) {
    return { record, hasPrivateKey, canExportP12: false, blocker: '尚未导入 Apple 颁发的 CER 证书' }
  }
  if (!hasPrivateKey) {
    return { record, hasPrivateKey, canExportP12: false, blocker: '私钥材料已被删除，无法导出 P12' }
  }

  const privateKeyPem = await unsealPrivateKey(keyRecord!)
  const match = certificateMatchesPrivateKey(record.cerPem, privateKeyPem)
  return {
    record,
    hasPrivateKey,
    canExportP12: match.matches,
    blocker: match.matches ? undefined : match.reason
  }
}

/** 便于备份模块复用：读取私钥密文记录 */
export async function getKeyRecord(certificateId: string): Promise<KeyRecord | undefined> {
  return getKeyByCertificateId(certificateId)
}
