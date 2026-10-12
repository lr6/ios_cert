/**
 * CSR（PKCS#10）服务。
 *
 * 设计说明：
 * - RSA 密钥对用 Web Crypto 原生实现生成（快、随机源可信）。
 * - 生成的密钥必须可导出：私钥导出为 PKCS#8 PEM，公钥导出为 SPKI PEM。
 *   可导出是后续加密备份、CSR 生成与 PKCS#12 打包的前提。
 * - CSR 的 ASN.1 编码交给 node-forge；subject 字段显式指定 valueTagClass，
 *   否则含中文（非 ASCII）的证书名会生成非法 DER（OpenSSL 会直接拒收）。
 *   该问题由 tests/integration/openssl-compat.test.ts 独立验证。
 */
import forge from 'node-forge'
import type { CsrArtifact, CsrInfo, CsrSubjectInfo, RsaKeyBits } from '@/types/certificate'
import { bytesToBase64, bytesToPem, pemToBytes } from '@/utils/encoding'
import { decodeAsn1Text, encodeAsn1Text } from '@/utils/asn1-text'

export const DEFAULT_RSA_BITS: RsaKeyBits = 2048
export const RSA_PUBLIC_EXPONENT = new Uint8Array([0x01, 0x00, 0x01]) // 65537

export interface KeyPairMaterial {
  /** PKCS#8 (PRIVATE KEY) PEM */
  privateKeyPem: string
  /** SPKI (PUBLIC KEY) PEM */
  publicKeyPem: string
  /** 私钥材料是否可导出（必须为 true，否则无法备份） */
  extractable: boolean
  bits: RsaKeyBits
  /** 公钥模数 hex，用于与证书快速比对 */
  modulusHex: string
}

export interface CreateCsrOptions extends CsrSubjectInfo {
  /** 签名摘要算法，Apple 要求 SHA-256 及以上 */
  digest?: 'sha256' | 'sha384' | 'sha512'
}

/** 生成 RSA 密钥对，返回可导出的 PEM 材料 */
export async function generateRsaKeyPair(bits: RsaKeyBits = DEFAULT_RSA_BITS): Promise<KeyPairMaterial> {
  assertSupportedBits(bits)
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: bits,
      publicExponent: RSA_PUBLIC_EXPONENT,
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))

  const privateKeyPem = bytesToPem(pkcs8, 'PRIVATE KEY')
  const publicKeyPem = bytesToPem(spki, 'PUBLIC KEY')

  const forgePublicKey = forge.pki.publicKeyFromPem(publicKeyPem) as forge.pki.rsa.PublicKey
  const modulusHex = forgePublicKey.n.toString(16)

  return { privateKeyPem, publicKeyPem, extractable: true, bits, modulusHex }
}

/** 由已导出的 PKCS#8 私钥重新计算公钥材料（恢复备份时使用） */
export function publicKeyPemFromPrivateKey(privateKeyPem: string): string {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem) as forge.pki.rsa.PrivateKey
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e)
  return forge.pki.publicKeyToPem(publicKey)
}

/** 生成真实的 PKCS#10 CSR，并做一次内部验签 */
export function createCsr(privateKeyPem: string, publicKeyPem: string, options: CreateCsrOptions): CsrArtifact {
  const commonName = options.commonName?.trim()
  if (!commonName) throw new Error('证书名称（commonName）不能为空')

  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem) as forge.pki.rsa.PrivateKey
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem) as forge.pki.rsa.PublicKey

  if (privateKey.n.toString(16) !== publicKey.n.toString(16)) {
    throw new Error('私钥与公钥不匹配，无法生成 CSR')
  }

  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = publicKey

  const attributes: forge.pki.CertificateField[] = [
    { name: 'commonName', ...encodeAsn1Text(commonName) } as forge.pki.CertificateField
  ]
  if (options.organization && options.organization.trim()) {
    attributes.push({
      name: 'organizationName',
      ...encodeAsn1Text(options.organization.trim())
    } as forge.pki.CertificateField)
  }
  if (options.country && options.country.trim()) {
    attributes.push({
      name: 'countryName',
      ...encodeAsn1Text(options.country.trim())
    } as forge.pki.CertificateField)
  }
  csr.setSubject(attributes)

  const digest = options.digest ?? 'sha256'
  csr.sign(privateKey, forge.md[digest].create())

  const pem = forge.pki.certificationRequestToPem(csr)
  const der = pemToBytes(pem)

  return { pem, derBase64: bytesToBase64(der), info: extractCsrInfo(csr) }
}

/** 解析 CSR，返回真实字段（解析失败会抛错，不会返回假数据） */
export function parseCsr(pem: string): CsrInfo {
  return extractCsrInfo(loadCsr(pem))
}

/** forge 内部验签。注意：这只是快速自检，独立验证请用 OpenSSL（npm run verify:crypto） */
export function verifyCsrPem(pem: string): boolean {
  try {
    return loadCsr(pem).verify()
  } catch {
    return false
  }
}

/** 返回 CSR 中的公钥（SPKI PEM），用于与私钥做匹配校验 */
export function publicKeyPemFromCsr(csrPem: string): string {
  const csr = loadCsr(csrPem)
  return forge.pki.publicKeyToPem(csr.publicKey as forge.pki.rsa.PublicKey)
}

function loadCsr(pem: string): forge.pki.CertificateSigningRequest {
  if (!/-----BEGIN ([A-Z ]*)?CERTIFICATE REQUEST-----/.test(pem)) {
    throw new Error('不是有效的 PKCS#10 CSR PEM 文件')
  }
  // 用 DER 解析而不是 forge 的 PEM 解码，避免换行符差异导致的解析问题
  const der = pemToBytes(pem)
  const binary = Array.from(der, (byte) => String.fromCharCode(byte)).join('')
  return forge.pki.certificationRequestFromAsn1(forge.asn1.fromDer(binary, false))
}

function extractCsrInfo(csr: forge.pki.CertificateSigningRequest): CsrInfo {
  const cn = csr.subject.getField('CN')
  const org = csr.subject.getField('O')
  const country = csr.subject.getField('C')

  const subject: CsrSubjectInfo = { commonName: dnText(cn) }
  if (org && org.value) subject.organization = dnText(org)
  if (country && country.value) subject.country = dnText(country)

  const publicKey = csr.publicKey as forge.pki.rsa.PublicKey & { n?: forge.jsbn.BigInteger }
  const isRsa = Boolean(publicKey && 'n' in publicKey && publicKey.n)
  const sigOid = csr.siginfo?.algorithmOid ?? ''
  const sigName = Object.entries(forge.pki.oids).find(([, oid]) => oid === sigOid)?.[0] ?? sigOid

  // 验签失败时 forge 会抛错，这里统一按“未通过”处理
  let selfVerified = false
  try {
    selfVerified = csr.verify()
  } catch {
    // selfVerified 保持 false
  }

  return {
    subject,
    publicKeyAlgorithm: isRsa ? 'RSA' : 'unknown',
    publicKeyBits: isRsa ? (publicKey.n as forge.jsbn.BigInteger).bitLength() : 0,
    signatureAlgorithm: normalizeSignatureName(sigName),
    selfVerified
  }
}

/** 读取 DN 字段文本（UTF8String 需要解码，否则中文会变乱码） */
function dnText(field: forge.pki.CertificateField | undefined | null): string {
  if (!field) return ''
  return decodeAsn1Text(field.value ?? undefined, (field as { valueTagClass?: number }).valueTagClass)
}

function normalizeSignatureName(oidName: string): string {
  const key = oidName.toLowerCase()
  if (key.includes('sha256withrsaencryption')) return 'SHA256withRSA'
  if (key.includes('sha384withrsaencryption')) return 'SHA384withRSA'
  if (key.includes('sha512withrsaencryption')) return 'SHA512withRSA'
  if (key.includes('sha1withrsaencryption')) return 'SHA1withRSA'
  return oidName
}

function assertSupportedBits(bits: number): asserts bits is RsaKeyBits {
  if (bits !== 2048 && bits !== 3072 && bits !== 4096) {
    throw new Error(`不支持的 RSA 密钥长度：${bits}`)
  }
}
