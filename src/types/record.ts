/**
 * 本地记录的数据模型。
 *
 * 存储分层原则（对应说明书 5.3 / 5.7）：
 * - 证书元信息（certificates）与私钥材料（keys）分开存放，互不污染；
 * - 私钥只以 AES-256-GCM 密文形式落盘，明文仅在需要时短暂存在于内存；
 * - 不存放任何密码（P12 导出密码、备份密码一律不落盘）。
 */
import type { CertificateInfo, CertificatePurpose, CertificateStatus, CsrInfo, RsaKeyBits } from '@/types/certificate'
import type { SealedBytes } from '@/services/crypto/encryption-service'

/** IndexedDB 中的证书记录 */
export interface CertificateRecord {
  id: string
  name: string
  purpose: CertificatePurpose
  status: CertificateStatus
  /** 关联的私钥记录 id；删除私钥材料后置为 null */
  keyId: string | null
  /** CSR 相关（csr-created 之后存在） */
  csrPem?: string
  csrDerBase64?: string
  csrInfo?: CsrInfo
  csrCreatedAt?: string
  /** 导入的 Apple 证书（CER） */
  cerPem?: string
  cerDerBase64?: string
  cerInfo?: CertificateInfo
  cerImportedAt?: string
  cerFileName?: string
  /** P12 导出记录（不保存密码） */
  p12ExportedAt?: string
  p12Algorithm?: string
  p12FriendlyName?: string
  p12ChainLength?: number
  note?: string
  /** 最近一次真实失败原因（供界面展示，不用“操作失败”这种笼统提示） */
  lastError?: string
  createdAt: string
  updatedAt: string
}

/** IndexedDB 中的私钥记录 */
export interface KeyRecord {
  id: string
  certificateId: string
  algorithm: 'RSA'
  bits: RsaKeyBits
  /** 已用本地主密钥封装的 PKCS#8 私钥（AES-256-GCM） */
  sealedPrivateKey: SealedBytes
  /** SPKI 公钥 PEM，公钥不属于敏感材料 */
  publicKeyPem: string
  modulusHex: string
  createdAt: string
  updatedAt: string
}

/** 本地主密钥记录（单例） */
export interface VaultRecord {
  id: 'vault'
  version: number
  /**
   * 不可导出的 AES-GCM 主密钥。
   * 直接以 CryptoKey 对象存入 IndexedDB（结构化克隆），无法被导出为原始字节。
   */
  key: CryptoKey
  /** 自检值：用主密钥加密的固定字符串，用于确认主密钥与其密文匹配 */
  check: SealedBytes
  createdAt: string
}

/** 数据库元信息（结构版本、迁移记录） */
export interface MetaRecord {
  key: string
  value: unknown
  updatedAt: string
}

export const VAULT_RECORD_ID = 'vault'
export const SCHEMA_VERSION_KEY = 'schemaVersion'
