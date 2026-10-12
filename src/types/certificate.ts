/** 证书用途（首版只支持这两类，不代表覆盖 Apple 全部证书类型） */
export type CertificatePurpose = 'development' | 'distribution'

/** 业务状态，必须依据真实处理结果流转 */
export type CertificateStatus = 'draft' | 'csr-created' | 'cer-imported' | 'ready' | 'error'

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  draft: '草稿',
  'csr-created': 'CSR 已生成',
  'cer-imported': 'CER 已导入',
  ready: '可导出 P12',
  error: '处理失败'
}

export const CERTIFICATE_PURPOSE_LABELS: Record<CertificatePurpose, string> = {
  development: 'Development',
  distribution: 'Distribution'
}

/** RSA 密钥长度。默认 2048，其他长度需实测浏览器兼容性后再启用。 */
export type RsaKeyBits = 2048 | 3072 | 4096

export interface CsrSubjectInfo {
  commonName: string
  organization?: string
  country?: string
}

export interface CsrInfo {
  subject: CsrSubjectInfo
  publicKeyAlgorithm: 'RSA' | 'unknown'
  publicKeyBits: number
  signatureAlgorithm: string
  /** 自校验（forge 内部验签）结果，仅作快速检查，不代替独立验证 */
  selfVerified: boolean
}

export interface CsrArtifact {
  /** PEM 文本，可直接下载 */
  pem: string
  /** DER 的 base64，便于存储 */
  derBase64: string
  info: CsrInfo
}

export interface CertificateInfo {
  subject: string
  subjectCommonName: string
  issuer: string
  issuerCommonName: string
  serialNumber: string
  notBefore: string
  notAfter: string
  publicKeyAlgorithm: string
  publicKeyBits: number
  /** RSA 模数（hex），用于与私钥匹配 */
  publicKeyModulusHex: string
  publicKeyExponent: string
  signatureAlgorithm: string
  sha256Fingerprint: string
  sha1Fingerprint: string
  /** 已过期 */
  expired: boolean
  /** 尚未生效 */
  notYetValid: boolean
  keyUsage?: string[]
  extendedKeyUsage?: string[]
}

export interface CertificateArtifact {
  /** PEM 文本 */
  pem: string
  /** DER 的 base64 */
  derBase64: string
  info: CertificateInfo
}
