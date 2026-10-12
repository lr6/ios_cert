/**
 * X.509 证书（Apple 下载的 .cer，DER 编码）解析与校验。
 *
 * 说明：
 * - Apple Developer 下载的 .cer 是 DER 编码的 X.509 证书；也兼容 PEM 输入。
 * - 解析失败必须抛错，绝不返回“看起来成功”的空数据。
 * - 与私钥的匹配基于 RSA 模数/指数，不依赖证书名称。
 */
import forge from 'node-forge'
import type { CertificateArtifact, CertificateInfo } from '@/types/certificate'
import { bytesToBase64, bytesToColonHex, bytesToBinaryString, bytesToPem, isPem, pemToBytes } from '@/utils/encoding'
import { decodeAsn1Text } from '@/utils/asn1-text'

const MAX_CERTIFICATE_BYTES = 256 * 1024

export interface CertificateParseInput {
  /** 原始文件字节（.cer / .pem） */
  data: Uint8Array
  /** 用于错误提示的文件名 */
  fileName?: string
}

export class CertificateParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CertificateParseError'
  }
}

/** 解析证书；输入为原始文件字节，返回 PEM + DER + 真实字段 */
export function parseCertificate(input: CertificateParseInput): CertificateArtifact {
  const { data, fileName } = input
  const label = fileName ? `文件「${fileName}」` : '所选文件'

  if (data.length === 0) throw new CertificateParseError(`${label} 内容为空`)
  if (data.length > MAX_CERTIFICATE_BYTES) {
    throw new CertificateParseError(`${label} 过大（${data.length} 字节），已超过 ${MAX_CERTIFICATE_BYTES} 字节上限`)
  }

  const text = tryDecodeText(data)
  let certificate: forge.pki.Certificate
  let der: Uint8Array

  if (text && isPem(text)) {
    if (!/-----BEGIN CERTIFICATE-----/.test(text)) {
      throw new CertificateParseError(`${label} 不是证书 PEM（缺少 BEGIN CERTIFICATE 标记）`)
    }
    try {
      certificate = forge.pki.certificateFromPem(text)
    } catch (error) {
      throw new CertificateParseError(`${label} PEM 解析失败：${describe(error)}`)
    }
    der = pemToBytes(text)
  } else {
    der = data
    try {
      const asn1 = forge.asn1.fromDer(bytesToBinaryString(data), false)
      certificate = forge.pki.certificateFromAsn1(asn1)
    } catch (error) {
      throw new CertificateParseError(`${label} 不是可识别的 X.509 证书（DER 解析失败：${describe(error)}）`)
    }
  }

  return {
    pem: bytesToPem(der, 'CERTIFICATE'),
    derBase64: bytesToBase64(der),
    info: extractCertificateInfo(certificate, der)
  }
}

/** 由 PEM 文本解析证书（内部/测试使用） */
export function parseCertificatePem(pem: string): CertificateArtifact {
  return parseCertificate({ data: pemToBytes(pem), fileName: 'certificate.pem' })
}

export interface KeyMatchResult {
  matches: boolean
  reason: string
}

/**
 * 校验证书公钥与私钥是否匹配。
 * 只比较真实密钥参数，不做证书名称或时间等无关判断。
 */
export function certificateMatchesPrivateKey(
  certPemOrArtifact: string | CertificateArtifact,
  privateKeyPem: string
): KeyMatchResult {
  let certPem: string
  if (typeof certPemOrArtifact === 'string') {
    certPem = certPemOrArtifact
  } else {
    certPem = certPemOrArtifact.pem
  }

  let certificate: forge.pki.Certificate
  try {
    certificate = forge.pki.certificateFromPem(certPem)
  } catch (error) {
    return { matches: false, reason: `证书解析失败：${describe(error)}` }
  }

  let privateKey: forge.pki.rsa.PrivateKey
  try {
    privateKey = forge.pki.privateKeyFromPem(privateKeyPem) as forge.pki.rsa.PrivateKey
  } catch (error) {
    return { matches: false, reason: `私钥解析失败：${describe(error)}` }
  }

  const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey & {
    n?: forge.jsbn.BigInteger
    e?: forge.jsbn.BigInteger
  }
  if (!publicKey || !publicKey.n) {
    return {
      matches: false,
      reason: '证书公钥不是受支持的 RSA 公钥（当前版本仅支持 RSA 证书与私钥的匹配校验）'
    }
  }

  if (publicKey.n.toString(16) !== privateKey.n.toString(16)) {
    return { matches: false, reason: '证书公钥与私钥不匹配：该证书不属于此密钥对' }
  }
  if (publicKey.e.toString(16) !== privateKey.e.toString(16)) {
    return { matches: false, reason: '证书公钥指数与私钥不匹配' }
  }

  return { matches: true, reason: '证书公钥与私钥一致' }
}

/** 证书是否在有效期内 */
export function certificateValidity(
  info: CertificateInfo,
  now: Date = new Date()
): 'valid' | 'expired' | 'not-yet-valid' {
  const notAfter = new Date(info.notAfter)
  const notBefore = new Date(info.notBefore)
  if (now > notAfter) return 'expired'
  if (now < notBefore) return 'not-yet-valid'
  return 'valid'
}

function extractCertificateInfo(certificate: forge.pki.Certificate, der: Uint8Array): CertificateInfo {
  const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey & {
    n?: forge.jsbn.BigInteger
    e?: forge.jsbn.BigInteger
  }
  const isRsa = Boolean(publicKey && 'n' in publicKey && publicKey.n)

  const sigOid = certificate.siginfo?.algorithmOid ?? ''
  const sigName = Object.entries(forge.pki.oids).find(([, oid]) => oid === sigOid)?.[0] ?? sigOid

  const keyUsageExt = certificate.getExtension('keyUsage') as (Record<string, boolean> & { name?: string }) | undefined
  const extKeyUsageExt = certificate.getExtension('extKeyUsage') as
    (Record<string, boolean> & { name?: string }) | undefined

  const keyUsage = keyUsageExt
    ? Object.entries(keyUsageExt)
        .filter(([key, value]) => key !== 'name' && value === true)
        .map(([key]) => key)
    : undefined

  const extendedKeyUsage = extKeyUsageExt
    ? Object.entries(extKeyUsageExt)
        .filter(([key, value]) => key !== 'name' && value === true)
        .map(([key]) => key)
    : undefined

  const now = new Date()
  const cnField = certificate.subject.getField('CN')
  const issuerCnField = certificate.issuer.getField('CN')

  return {
    subject: formatDistinguishedName(certificate.subject),
    subjectCommonName: decodeAsn1Text(cnField?.value, cnField?.valueTagClass),
    issuer: formatDistinguishedName(certificate.issuer),
    issuerCommonName: decodeAsn1Text(issuerCnField?.value, issuerCnField?.valueTagClass),
    serialNumber: formatSerial(certificate.serialNumber),
    notBefore: certificate.validity.notBefore.toISOString(),
    notAfter: certificate.validity.notAfter.toISOString(),
    publicKeyAlgorithm: isRsa
      ? `RSA (${(publicKey.n as forge.jsbn.BigInteger).bitLength()} bit)`
      : 'RSA 之外的公钥算法（暂不支持匹配校验）',
    publicKeyBits: isRsa ? (publicKey.n as forge.jsbn.BigInteger).bitLength() : 0,
    publicKeyModulusHex: isRsa ? (publicKey.n as forge.jsbn.BigInteger).toString(16) : '',
    publicKeyExponent: isRsa ? `0x${(publicKey.e as forge.jsbn.BigInteger).toString(16)}` : '',
    signatureAlgorithm: normalizeSignatureName(sigName),
    sha256Fingerprint: bytesToColonHex(sha256(der)),
    sha1Fingerprint: bytesToColonHex(sha1(der)),
    expired: now > certificate.validity.notAfter,
    notYetValid: now < certificate.validity.notBefore,
    keyUsage,
    extendedKeyUsage
  }
}

function formatDistinguishedName(dn: forge.pki.Certificate['subject']): string {
  const parts: string[] = []
  for (const field of dn.attributes as forge.pki.CertificateField[]) {
    if (field.value === undefined || field.value === null) continue
    const name = String(field.shortName ?? field.name ?? '')
    parts.push(`${name}=${decodeAsn1Text(field.value, (field as { valueTagClass?: number }).valueTagClass)}`)
  }
  return parts.join(', ')
}

function formatSerial(serial: string | undefined): string {
  if (!serial) return ''
  // forge 返回的 serialNumber 是 hex 且可能带前导 0；去掉前导 0 更接近常规展示
  const trimmed = serial.replace(/^0+/, '') || '0'
  return trimmed.toUpperCase()
}

function normalizeSignatureName(oidName: string): string {
  const key = oidName.toLowerCase()
  if (key.includes('sha256withrsaencryption')) return 'SHA256withRSA'
  if (key.includes('sha384withrsaencryption')) return 'SHA384withRSA'
  if (key.includes('sha512withrsaencryption')) return 'SHA512withRSA'
  if (key.includes('sha1withrsaencryption')) return 'SHA1withRSA'
  if (key.includes('sha256withrsaandmgf1')) return 'RSASSA-PSS-SHA256'
  if (key.includes('ecdsa')) return oidName
  return oidName
}

function sha256(bytes: Uint8Array): Uint8Array {
  const md = forge.md.sha256.create()
  md.update(bytesToBinaryString(bytes))
  return forge.util.binary.raw.decode(md.digest().getBytes()) as unknown as Uint8Array
}

function sha1(bytes: Uint8Array): Uint8Array {
  const md = forge.md.sha1.create()
  md.update(bytesToBinaryString(bytes))
  return forge.util.binary.raw.decode(md.digest().getBytes()) as unknown as Uint8Array
}

function tryDecodeText(data: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data)
    // 二进制 DER 解码后通常包含大量不可打印字符；这里只用于判断是否 PEM
    return isPem(text) ? text : null
  } catch {
    return null
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
