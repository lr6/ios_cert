/**
 * ASN.1 文本值（DN 字段等）编码/解码辅助。
 *
 * 背景（阶段 A 实测发现，已被 OpenSSL 验证）：
 * node-forge 在构造 subject 时，如果字段值含非 ASCII 字符且未显式指定 valueTagClass，
 * 会产出非法 DER —— OpenSSL 直接报 "wrong tag" 拒绝解析。
 * 因此本模块强制：纯可打印 ASCII 用 PrintableString，其余一律用 UTF8String；
 * 解析时对 UTF8String 做 decodeUtf8（forge 返回的是原始字节，不解码会变乱码）。
 */
import forge from 'node-forge'

export interface Asn1TextValue {
  value: string
  valueTagClass: number
}

/** 是否为可安全放入 PrintableString 的字符集 */
export function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value)
}

/** 把用户输入编码为合法的 ASN.1 文本值 */
export function encodeAsn1Text(value: string): Asn1TextValue {
  if (isPrintableAscii(value)) {
    return { value, valueTagClass: forge.asn1.Type.PRINTABLESTRING }
  }
  return { value, valueTagClass: forge.asn1.Type.UTF8 }
}

/** 把解析得到的 ASN.1 文本值还原为可读字符串 */
export function decodeAsn1Text(value: unknown, valueTagClass?: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return String(value)

  switch (valueTagClass) {
    case forge.asn1.Type.UTF8:
      try {
        return forge.util.decodeUtf8(value)
      } catch {
        return value
      }
    case forge.asn1.Type.BMPSTRING:
      // fromDer 已把 UTF-16 转成 JS 字符串，无需再解码
      return value
    default:
      return value
  }
}
