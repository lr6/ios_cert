/**
 * PKCS#12 (.p12) 生成与解析。
 *
 * 实测结论（node-forge 1.4.0 + OpenSSL 3.2.4 交叉验证）：
 * - 私钥袋：PBES2(PBKDF2-HMAC-SHA1)+AES-256-CBC，或 3DES（PKCS#12 PBE）；
 * - 证书袋：默认也加密（3DES 模式下用 pbeWithSHAAnd3-KeyTripleDES-CBC），
 *   与 OpenSSL 1.x / Apple 钥匙串导出的传统产物结构一致；
 *   node-forge 自身不加密证书袋，这里做了 ASN.1 后处理并重算 MAC；
 * - MAC 为 HMAC-SHA1；输出为 PFX version 3。
 *
 * 为什么要在意证书袋加密：部分 Java 系工具链（如各类云打包后台）对未加密的
 * 证书袋兼容性较差，会报 "certificate file(p12) import failed"。
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
  /** 是否加密证书袋，默认 true（与 OpenSSL/Apple 传统产物一致；设为 false 仅为排查兼容性问题） */
  encryptCertificateBags?: boolean
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
 * node-forge 运行时提供、但 @types/node-forge 未声明的成员。
 * 这里集中声明一次，避免到处写 `as any`（这些 API 已在阶段 A 实测确认存在）。
 */
interface ForgeRuntime {
  util: {
    createBuffer(input?: string): forge.util.ByteStringBuffer
  }
  des: {
    createEncryptionCipher(key: string): ForgeCipher
  }
  aes: {
    createEncryptionCipher(key: string): ForgeCipher
  }
  pki: {
    pbe: {
      generatePkcs12Key(
        password: string,
        salt: forge.util.ByteStringBuffer,
        id: number,
        iterations: number,
        keySize: number,
        md?: forge.md.MessageDigest
      ): string
    }
  }
}

interface ForgeCipher {
  start(iv: string): void
  update(input: string | forge.util.ByteStringBuffer): void
  finish(): boolean
  output: { getBytes(): string }
}

const forgeRuntime = forge as unknown as ForgeRuntime

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

  // node-forge 不加密证书袋，这里做 ASN.1 后处理并重算 MAC，
  // 使产物与 OpenSSL / Apple 导出的传统 PKCS#12 结构一致。
  if ((options.encryptCertificateBags ?? true) && (options.password ?? '').length > 0) {
    encryptCertificateSafeContents(asn1, options.password ?? '', {
      algorithm: options.algorithm ?? 'aes256',
      iterations: options.iterations ?? DEFAULT_ITERATIONS,
      saltSize: 8
    })
  }

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

interface SafeContentsEncryptionOptions {
  algorithm: Pkcs12Algorithm
  iterations: number
  /** PKCS#12 PBE 的盐长度（OpenSSL 传统产物为 8 字节） */
  saltSize: number
}

/**
 * 把 SafeContents 加密为 PKCS#7 EncryptedData。
 * 结构与 node-forge 加密私钥袋时一致（PBES2+AES 或 PKCS#12 PBE 3DES）。
 */
function encryptSafeContents(
  safeContentsDer: string,
  password: string,
  options: SafeContentsEncryptionOptions
): forge.asn1.Asn1 {
  const asn1 = forge.asn1
  const count = options.iterations
  const countBytes = asn1.integerToDer(count)
  const salt = forge.random.getBytesSync(options.saltSize)

  let encryptionAlgorithm: forge.asn1.Asn1
  let encrypted: string

  if (options.algorithm === '3des') {
    const saltBuffer = forgeRuntime.util.createBuffer(salt)
    const key = forgeRuntime.pki.pbe.generatePkcs12Key(password, saltBuffer, 1, count, 24)
    const iv = forgeRuntime.pki.pbe.generatePkcs12Key(password, saltBuffer, 2, count, 24)
    const cipher = forgeRuntime.des.createEncryptionCipher(key)
    cipher.start(iv)
    cipher.update(forge.util.createBuffer(safeContentsDer))
    cipher.finish()
    encrypted = cipher.output.getBytes()

    encryptionAlgorithm = sequence([
      oid(forge.pki.oids['pbeWithSHAAnd3-KeyTripleDES-CBC']),
      sequence([octetString(salt), integer(countBytes.getBytes())])
    ])
  } else {
    const keyLength = options.algorithm === 'aes128' ? 16 : options.algorithm === 'aes192' ? 24 : 32
    const cipherOid = forge.pki.oids[`${options.algorithm}-CBC`]
    const digest = forge.md.sha1.create()
    const key = forge.pkcs5.pbkdf2(password, salt, count, keyLength, digest)
    const iv = forge.random.getBytesSync(16)
    const cipher = forgeRuntime.aes.createEncryptionCipher(key)
    cipher.start(iv)
    cipher.update(forge.util.createBuffer(safeContentsDer))
    cipher.finish()
    encrypted = cipher.output.getBytes()

    encryptionAlgorithm = sequence([
      oid(forge.pki.oids.pkcs5PBES2),
      sequence([
        sequence([oid(forge.pki.oids.pkcs5PBKDF2), sequence([octetString(salt), integer(countBytes.getBytes())])]),
        sequence([oid(cipherOid), octetString(iv)])
      ])
    ])
  }

  return sequence([
    integer(asn1.integerToDer(0).getBytes()),
    sequence([oid(forge.pki.oids.data), encryptionAlgorithm, contextSpecific(octetString(encrypted))])
  ])
}

/**
 * 就地修改由 node-forge 生成的 PFX：
 * - 把证书 SafeContents 换成加密后的 PKCS#7 EncryptedData；
 * - 重新编码 AuthenticatedSafe 并用新的盐重算 MAC。
 */
function encryptCertificateSafeContents(
  pfx: forge.asn1.Asn1,
  password: string,
  options: SafeContentsEncryptionOptions
): void {
  const asn1 = forge.asn1
  const outerOctet = asn1Child(asn1Child(asn1Child(pfx, 1), 1), 0)
  const authenticatedSafe = asn1.fromDer(asn1String(outerOctet))

  for (const contentInfo of asn1Children(authenticatedSafe)) {
    if (asn1.derToOid(asn1String(asn1Child(contentInfo, 0))) !== forge.pki.oids.data) continue

    const contentsOctet = asn1Child(asn1Child(contentInfo, 1), 0)
    const safeContentsDer = asn1String(contentsOctet)
    const safeContents = asn1.fromDer(safeContentsDer)
    const containsCertificateBag = asn1Children(safeContents).some(
      (bag) => asn1.derToOid(asn1String(asn1Child(bag, 0))) === forge.pki.oids.certBag
    )
    if (!containsCertificateBag) continue

    const encryptedData = encryptSafeContents(safeContentsDer, password, options)
    const children = asn1Children(contentInfo)
    children[0] = oid(forge.pki.oids.encryptedData)
    children[1] = contextSpecific(encryptedData)
  }

  const authenticatedSafeDer = asn1.toDer(authenticatedSafe).getBytes()
  asn1SetString(outerOctet, authenticatedSafeDer)

  // MAC 覆盖整个 AuthenticatedSafe，必须重算
  const macData = pfx.composed ? asn1Children(pfx)[2] : undefined
  if (!macData) return

  const macSalt = forge.random.getBytesSync(options.saltSize)
  const macKey = forge.pkcs12.generateKey(password, forge.util.createBuffer(macSalt), 3, options.iterations, 20)
  const mac = forge.hmac.create()
  mac.start(forge.md.sha1.create(), macKey)
  mac.update(authenticatedSafeDer)
  const macValue = mac.getMac()

  // MacData ::= SEQUENCE { DigestInfo, macSalt OCTET STRING, iterations INTEGER }
  const macChildren = asn1Children(macData)
  // macChildren[0] = DigestInfo ::= SEQUENCE { digestAlgorithm, digest OCTET STRING }
  asn1SetString(asn1Child(macChildren[0], 1), macValue.getBytes())
  asn1SetString(macChildren[1], macSalt)
  asn1SetString(macChildren[2], asn1.integerToDer(options.iterations).getBytes())
}

function sequence(children: forge.asn1.Asn1[]): forge.asn1.Asn1 {
  return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, children)
}

function oid(value: string): forge.asn1.Asn1 {
  return forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.OID,
    false,
    forge.asn1.oidToDer(value).getBytes()
  )
}

function octetString(value: string): forge.asn1.Asn1 {
  return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, value)
}

function integer(value: string): forge.asn1.Asn1 {
  return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, value)
}

function contextSpecific(child: forge.asn1.Asn1): forge.asn1.Asn1 {
  return forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [child])
}

/** 断言 asn1 节点为构造类型，返回其子节点数组 */
function asn1Children(node: forge.asn1.Asn1): forge.asn1.Asn1[] {
  if (!Array.isArray(node.value)) {
    throw new Error('ASN.1 结构异常：期望构造类型节点')
  }
  return node.value
}

function asn1Child(node: forge.asn1.Asn1, index: number): forge.asn1.Asn1 {
  const child = asn1Children(node)[index]
  if (!child) throw new Error('ASN.1 结构异常：缺少第 ' + index + ' 个子节点')
  return child
}

/** 读取原始类型节点的字节内容 */
function asn1String(node: forge.asn1.Asn1): string {
  if (typeof node.value !== 'string') {
    throw new Error('ASN.1 结构异常：期望原始类型节点')
  }
  return node.value
}

function asn1SetString(node: forge.asn1.Asn1, value: string): void {
  node.value = value
}
