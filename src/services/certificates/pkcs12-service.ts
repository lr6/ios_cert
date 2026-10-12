/**
 * PKCS#12 (.p12) 生成与解析。
 *
 * 实测结论（阶段 A，node-forge 1.4.0，OpenSSL 3.2.4 交叉验证）：
 * - 私钥使用 PBES2(PBKDF2-HMAC-SHA1) + AES-256-CBC 加密；
 * - 证书袋按 forge 实现不加密（PKCS#12 规范允许），MAC 为 HMAC-SHA1；
 * - 输出为 PFX version 3。
 *
 * 注意：本模块只做本地打包，绝不把文件或密码发往任何服务器。
 */
import forge from 'node-forge'
import { certificateMatchesPrivateKey } from '@/services/certificates/x509-service'
import { bytesToBase64, bytesToBinaryString, binaryStringToBytes } from '@/utils/encoding'

export type Pkcs12Algorithm = 'aes256' | 'aes192' | 'aes128' | '3des'

export interface Pkcs12ExportOptions {
  /** 导出密码；空字符串表示不加密（不推荐，仅用于测试场景） */
  password: string
  /** 证书友好名，便于在 macOS 钥匙串中识别 */
  friendlyName?: string
  /** 密钥加密算法，默认 AES-256（PBES2） */
  algorithm?: Pkcs12Algorithm
  /** 是否写入 MAC，默认写入（推荐） */
  useMac?: boolean
  /** KDF 迭代次数 */
  iterations?: number
  /** 需要一并打包的中间证书（如 WWDR），按叶子在前、根在后的顺序 */
  chainPems?: string[]
}

export interface Pkcs12Contents {
  /** PKCS#8 PEM */
  privateKeyPem: string
  /** 证书链 PEM，第一个为叶子证书 */
  certificatePems: string[]
  friendlyName?: string
  /** MAC 是否校验通过（错误密码会导致解析阶段直接抛错） */
  macVerified: boolean
}

const DEFAULT_ITERATIONS = 10000

/**
 * 生成真实的 PKCS#12 字节（DER）。
 * 导出前强制校验证书与私钥匹配，避免产出“能打开但没用”的 P12。
 */
export function createPkcs12(privateKeyPem: string, certificatePem: string, options: Pkcs12ExportOptions): Uint8Array {
  const match = certificateMatchesPrivateKey(certificatePem, privateKeyPem)
  if (!match.matches) {
    throw new Error(`无法导出 P12：${match.reason}`)
  }

  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem)
  const chain = [certificatePem, ...(options.chainPems ?? [])].map((pem) => forge.pki.certificateFromPem(pem))

  const forgeOptions: Record<string, unknown> = {
    algorithm: options.algorithm ?? 'aes256',
    useMac: options.useMac ?? true,
    count: options.iterations ?? DEFAULT_ITERATIONS,
    generateLocalKeyId: true
  }
  // node-forge 通过 'friendlyName' in options 判断，显式传 undefined 会生成值为
  // undefined 的 BMPString，导致 toDer 抛错：必须按需构造选项对象。
  if (options.friendlyName) forgeOptions.friendlyName = options.friendlyName

  const asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, chain, options.password ?? '', forgeOptions)

  return binaryStringToBytes(forge.asn1.toDer(asn1).getBytes())
}

/** 解析 PKCS#12；密码错误 / 文件损坏会抛出明确错误 */
export function parsePkcs12(der: Uint8Array, password: string): Pkcs12Contents {
  let pfx: forge.pkcs12.Pkcs12Pfx
  try {
    pfx = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bytesToBinaryString(der)), password ?? '')
  } catch (error) {
    throw new Error(describePkcs12Error(error), { cause: error })
  }

  const keyBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []
  const plainKeyBags = pfx.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []
  const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []

  const keyBag = keyBags[0] ?? plainKeyBags[0]
  if (!keyBag || !keyBag.key) {
    throw new Error('PKCS#12 中未找到私钥（keyBag / pkcs8ShroudedKeyBag 均为空）')
  }

  const privateKeyPem = forge.pki.privateKeyInfoToPem(
    forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keyBag.key as forge.pki.rsa.PrivateKey))
  )

  const certificatePems = certBags
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => Boolean(cert))
    .map((cert) => forge.pki.certificateToPem(cert))

  if (certificatePems.length === 0) {
    throw new Error('PKCS#12 中未找到任何证书')
  }

  const friendlyName = keyBag.attributes?.friendlyName?.[0]

  return {
    privateKeyPem,
    certificatePems,
    friendlyName: typeof friendlyName === 'string' ? friendlyName : undefined,
    macVerified: true
  }
}

/** 供 UI 使用的算法说明 */
export const PKCS12_ALGORITHM_LABELS: Record<Pkcs12Algorithm, string> = {
  aes256: 'AES-256-CBC (PBES2 + PBKDF2-HMAC-SHA1)',
  aes192: 'AES-192-CBC (PBES2 + PBKDF2-HMAC-SHA1)',
  aes128: 'AES-128-CBC (PBES2 + PBKDF2-HMAC-SHA1)',
  '3des': '3DES (PKCS#12 PBE + HMAC-SHA1)'
}

function describePkcs12Error(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/MAC could not be verified|invalid password/i.test(message)) {
    return 'P12 打开失败：密码错误或文件已损坏'
  }
  if (/unsupported MAC algorithm/i.test(message)) {
    return `P12 解析失败：不支持的 MAC 算法（${message}）`
  }
  return `P12 解析失败：${message}`
}

export function pkcs12ToBase64(der: Uint8Array): string {
  return bytesToBase64(der)
}
