/**
 * 本地加密服务（Web Crypto API）。
 *
 * 用途：
 * 1) 备份文件加密：PBKDF2-SHA256 派生密钥 + AES-256-GCM；
 * 2) IndexedDB 中私钥材料的封装：使用不可导出的随机主密钥（vault key）。
 *
 * 安全说明（必须在界面中向用户说明）：
 * - 浏览器无法保证内存中的密钥被彻底擦除；
 * - 若页面被恶意脚本注入，密钥仍可能被窃取；
 * - 主密钥保存在浏览器配置文件内，清除浏览器数据会一并丢失。
 */
import { base64ToBytes, bytesToBase64, bytesEqual, randomBytes } from '@/utils/encoding'

export const BACKUP_FORMAT = 'ioscert-backup'
export const BACKUP_VERSION = 1
export const BACKUP_DATA_VERSION = 1
export const DEFAULT_PBKDF2_ITERATIONS = 600_000
const PBKDF2_HASH = 'SHA-256'
const AES_KEY_LENGTH = 256
const GCM_IV_BYTES = 12
const GCM_TAG_BITS = 128

/** 备份文件的附加认证数据，绑定格式与版本，防止头部被篡改 */
const AAD_PREFIX = `${BACKUP_FORMAT}|v${BACKUP_VERSION}`

export interface BackupKdfHeader {
  name: 'PBKDF2'
  hash: 'SHA-256'
  iterations: number
  /** base64 */
  salt: string
}

export interface BackupCipherHeader {
  name: 'AES-GCM'
  keyLength: 256
  /** base64，12 字节随机 nonce */
  iv: string
  tagLength: 128
}

export interface BackupEnvelope<T = unknown> {
  format: typeof BACKUP_FORMAT
  version: number
  /** 明文数据结构版本 */
  dataVersion: number
  createdAt: string
  kdf: BackupKdfHeader
  cipher: BackupCipherHeader
  /** base64 密文（含 GCM tag） */
  ciphertext: string
  /** 供用户确认的备注，不参与加密 */
  note?: string
  /** T 仅用于类型标注，运行时不存在 */
  __payloadType?: T
}

export type DecryptionFailureReason =
  'invalid-format' | 'unsupported-version' | 'wrong-password-or-corrupted' | 'invalid-payload'

export class DecryptionError extends Error {
  readonly reason: DecryptionFailureReason

  constructor(reason: DecryptionFailureReason, message: string) {
    super(message)
    this.name = 'DecryptionError'
    this.reason = reason
  }
}

/** PBKDF2 派生 AES-GCM 密钥（不可导出） */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  if (iterations < 10_000) throw new Error('PBKDF2 迭代次数过低，拒绝使用')
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey'
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH },
    material,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )
}

/** 生成用于封装本地私钥的主密钥（不可导出，可存入 IndexedDB） */
export async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: AES_KEY_LENGTH }, false, ['encrypt', 'decrypt'])
}

export interface SealedBytes {
  /** base64 nonce */
  iv: string
  /** base64 密文（含 tag） */
  data: string
}

/** 用给定的 AES-GCM 密钥加密字节 */
export async function sealBytes(plain: Uint8Array, key: CryptoKey, aad?: string): Promise<SealedBytes> {
  const iv = randomBytes(GCM_IV_BYTES)
  const params: AesGcmParams = { name: 'AES-GCM', iv, tagLength: GCM_TAG_BITS }
  if (aad) params.additionalData = new TextEncoder().encode(aad)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(params, key, plain))
  return { iv: bytesToBase64(iv), data: bytesToBase64(ciphertext) }
}

/** 解密 SealedBytes；失败时抛 DecryptionError */
export async function openBytes(sealed: SealedBytes, key: CryptoKey, aad?: string): Promise<Uint8Array> {
  const iv = base64ToBytes(sealed.iv)
  const data = base64ToBytes(sealed.data)
  const params: AesGcmParams = { name: 'AES-GCM', iv, tagLength: GCM_TAG_BITS }
  if (aad) params.additionalData = new TextEncoder().encode(aad)
  try {
    return new Uint8Array(await crypto.subtle.decrypt(params, key, data))
  } catch {
    throw new DecryptionError('wrong-password-or-corrupted', '解密失败：密码错误或数据已损坏')
  }
}

/** 用口令加密任意可序列化对象，输出备份信封 */
export async function encryptWithPassword<T>(
  payload: T,
  password: string,
  options: { iterations?: number; note?: string; dataVersion?: number } = {}
): Promise<BackupEnvelope<T>> {
  if (!password) throw new Error('备份密码不能为空')
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS
  const salt = randomBytes(16)
  const key = await deriveKeyFromPassword(password, salt, iterations)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const sealed = await sealBytes(plaintext, key, AAD_PREFIX)
  plaintext.fill(0)

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    dataVersion: options.dataVersion ?? BACKUP_DATA_VERSION,
    createdAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: PBKDF2_HASH, iterations, salt: bytesToBase64(salt) },
    cipher: { name: 'AES-GCM', keyLength: AES_KEY_LENGTH, iv: sealed.iv, tagLength: GCM_TAG_BITS },
    ciphertext: sealed.data,
    note: options.note
  }
}

/** 校验备份信封结构，返回规范化后的信封 */
export function validateBackupEnvelope(input: unknown): BackupEnvelope {
  if (typeof input !== 'object' || input === null) {
    throw new DecryptionError('invalid-format', '备份文件格式错误：不是合法的 JSON 对象')
  }
  const envelope = input as Partial<BackupEnvelope>
  if (envelope.format !== BACKUP_FORMAT) {
    throw new DecryptionError('invalid-format', '备份文件格式错误：缺少 ioscert-backup 标识')
  }
  if (typeof envelope.version !== 'number') {
    throw new DecryptionError('invalid-format', '备份文件格式错误：缺少版本号')
  }
  if (envelope.version > BACKUP_VERSION) {
    throw new DecryptionError(
      'unsupported-version',
      `备份文件版本 ${envelope.version} 高于当前支持的版本 ${BACKUP_VERSION}，请升级网站后再恢复`
    )
  }
  const kdf = envelope.kdf
  const cipher = envelope.cipher
  if (!kdf || kdf.name !== 'PBKDF2' || kdf.hash !== PBKDF2_HASH || typeof kdf.iterations !== 'number') {
    throw new DecryptionError('unsupported-version', '备份文件使用了不支持的密钥派生算法')
  }
  if (!cipher || cipher.name !== 'AES-GCM' || cipher.keyLength !== AES_KEY_LENGTH) {
    throw new DecryptionError('unsupported-version', '备份文件使用了不支持的加密算法')
  }
  if (typeof envelope.ciphertext !== 'string' || !envelope.ciphertext) {
    throw new DecryptionError('invalid-format', '备份文件内容为空')
  }
  return envelope as BackupEnvelope
}

/** 用口令解密备份信封 */
export async function decryptWithPassword<T>(input: unknown, password: string): Promise<T> {
  const envelope = validateBackupEnvelope(input)
  if (!password) throw new DecryptionError('wrong-password-or-corrupted', '请输入备份密码')

  const key = await deriveKeyFromPassword(password, base64ToBytes(envelope.kdf.salt), envelope.kdf.iterations)
  const plaintext = await openBytes(
    { iv: envelope.cipher.iv, data: envelope.ciphertext },
    key,
    `${BACKUP_FORMAT}|v${envelope.version}`
  )

  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  } catch {
    throw new DecryptionError('invalid-payload', '解密成功但内容不是合法 JSON，备份文件可能已损坏')
  } finally {
    plaintext.fill(0)
  }
}

/** 判断两个字节序列是否相等（用于自检脚本） */
export const bytesAreEqual = bytesEqual
