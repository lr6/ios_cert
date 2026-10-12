/**
 * 备份文件的数据结构定义。
 *
 * 备份文件 = 加密信封（见 encryption-service.BackupEnvelope）+ 明文负载（本文件定义）。
 * 负载整体被 AES-256-GCM 加密，因此其中的私钥 PEM 在备份文件中是密文的一部分，
 * 只有用正确备份密码才能解出；备份文件本身不包含任何本机主密钥信息，可跨设备恢复。
 */
import type { CertificateRecord, KeyRecord } from '@/types/record'

export const BACKUP_APP_ID = 'ios-certificate-manager'
/** 备份负载结构版本（与加密信封版本分开管理） */
export const BACKUP_PAYLOAD_VERSION = 1
/** 单份备份允许的最大记录数，避免异常文件导致内存问题 */
export const MAX_BACKUP_RECORDS = 5000

/** 备份中的私钥条目：私钥以 PKCS#8 PEM 形式放在加密负载内 */
export interface BackupKeyEntry extends Omit<KeyRecord, 'sealedPrivateKey'> {
  privateKeyPem: string
}

export interface BackupPayload {
  app: typeof BACKUP_APP_ID
  payloadVersion: number
  createdAt: string
  /** 导出时本机的数据结构版本，便于日后迁移 */
  schemaVersion: number
  certificates: CertificateRecord[]
  keys: BackupKeyEntry[]
}

/** 仅用于预览，不写入任何数据 */
export interface BackupSummary {
  envelopeVersion: number
  payloadVersion: number
  createdAt: string
  certificateCount: number
  privateKeyCount: number
  withCerCount: number
  withCsrCount: number
  inErrorCount: number
  sampleNames: string[]
}

export type RestoreMode = 'merge' | 'replace'

export interface RestoreResult {
  mode: RestoreMode
  added: number
  skipped: number
  removed: number
  keyCount: number
}
