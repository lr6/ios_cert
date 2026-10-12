/**
 * 字节 / Base64 / PEM 编码工具。
 * 浏览器与 Node (测试环境) 均可使用，不依赖 Buffer。
 */

const CHUNK = 0x8000

/** Uint8Array -> base64 字符串 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + CHUNK) as unknown as number[]))
  }
  return btoa(binary)
}

/** base64 字符串 -> Uint8Array */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Uint8Array -> 二进制字符串 (node-forge 需要的 "binary string") */
export function bytesToBinaryString(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + CHUNK) as unknown as number[]))
  }
  return binary
}

/** 二进制字符串 -> Uint8Array */
export function binaryStringToBytes(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff
  return out
}

/** 按 PEM 规范折行并包装 */
export function bytesToPem(bytes: Uint8Array, label: string, lineLength = 64): string {
  const base64 = bytesToBase64(bytes)
  const lines: string[] = []
  for (let i = 0; i < base64.length; i += lineLength) lines.push(base64.slice(i, i + lineLength))
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/** 去掉 PEM 头尾并解码，得到 DER 字节 */
export function pemToBytes(pem: string): Uint8Array {
  const match = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/.exec(pem)
  const body = match ? match[1] : pem
  return base64ToBytes(body)
}

export function isPem(text: string): boolean {
  return /-----BEGIN [^-]+-----/.test(text)
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** SHA-256 指纹，格式：AA:BB:CC...（大写） */
export function bytesToColonHex(bytes: Uint8Array, upperCase = true): string {
  const hex = bytesToHex(bytes)
  const parts = hex.match(/.{2}/g) ?? []
  const joined = parts.join(':')
  return upperCase ? joined.toUpperCase() : joined
}

/** 恒定时间比较，避免明显的时序差异 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Web Crypto 随机字节 */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}
