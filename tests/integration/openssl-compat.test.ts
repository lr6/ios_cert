/**
 * 独立兼容性验证（集成测试）。
 *
 * 用外部 OpenSSL 交叉验证本项目生成的 CSR 与 P12 是否为真实、标准、可解析的文件。
 * 这是阶段 A 的核心验收：未通过 OpenSSL 验证的产物，不得宣称功能可用。
 *
 * 运行：npm run verify:crypto
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCsr, generateRsaKeyPair, publicKeyPemFromCsr } from '@/services/certificates/csr-service'
import { createPkcs12, parsePkcs12 } from '@/services/certificates/pkcs12-service'
import { certificateMatchesPrivateKey, parseCertificatePem } from '@/services/certificates/x509-service'
import { opensslVersion, resolveOpenSsl, runOpenSsl } from '../helpers/openssl'

const openssl = resolveOpenSsl()
const PASSWORD = 'Independent-Verify-2026!'

if (!openssl) {
  console.warn('[verify-crypto] 未找到 OpenSSL，独立兼容性测试将跳过。可用环境变量 OPENSSL_BIN 指定路径。')
}

const EXT_FILE = `[ v3_codesign ]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
`

describe.skipIf(!openssl)('OpenSSL 独立兼容性验证（集成）', () => {
  let dir = ''
  let keyPath = ''
  let csrPath = ''
  let certPath = ''
  let p12Path = ''
  let publicKeyPem = ''
  let privateKeyPem = ''
  let csrPem = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ioscert-verify-'))
    const material = await generateRsaKeyPair(2048)
    privateKeyPem = material.privateKeyPem
    publicKeyPem = material.publicKeyPem

    const csr = createCsr(material.privateKeyPem, material.publicKeyPem, {
      commonName: 'iOS Cert Manager Verification',
      organization: 'Local Verification'
    })
    csrPem = csr.pem

    keyPath = join(dir, 'key.pem')
    csrPath = join(dir, 'request.csr')
    certPath = join(dir, 'cert.pem')
    p12Path = join(dir, 'out.p12')

    writeFileSync(keyPath, material.privateKeyPem)
    writeFileSync(csrPath, csr.pem)
    writeFileSync(join(dir, 'ext.cnf'), EXT_FILE)

    // 用 OpenSSL 基于我们的 CSR 签发自签名证书（扮演 Apple 返回 CER 的角色）
    const signResult = runOpenSsl(openssl!, [
      'x509',
      '-req',
      '-in',
      csrPath,
      '-signkey',
      keyPath,
      '-days',
      '365',
      '-sha256',
      '-extfile',
      join(dir, 'ext.cnf'),
      '-extensions',
      'v3_codesign',
      '-out',
      certPath
    ])
    expect(signResult.ok, `OpenSSL 签发测试证书失败: ${signResult.stderr}`).toBe(true)
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('环境中的 OpenSSL 可用', () => {
    expect(opensslVersion(openssl!)).toMatch(/^OpenSSL /)
  })

  it('OpenSSL 能验证 CSR 自签名，并解析出我们写入的 subject', () => {
    const result = runOpenSsl(openssl!, ['req', '-in', csrPath, '-noout', '-verify', '-subject', '-text'])
    const output = result.stdout + result.stderr
    expect(result.ok).toBe(true)
    expect(output).toContain('verify OK')
    expect(output).toContain('CN=iOS Cert Manager Verification')
    expect(output).toContain('O=Local Verification')
    expect(output).toContain('rsaEncryption')
    expect(output).toMatch(/Public-Key: \(2048 bit\)/)
    expect(output).toContain('sha256WithRSAEncryption')
  })

  it('含中文证书名的 CSR 同样是合法 DER（回归：forge 的 UTF8String 编码缺陷）', () => {
    const unicodePath = join(dir, 'unicode.csr')
    const unicodeCsr = createCsr(privateKeyPem, publicKeyPem, {
      commonName: '示例开发证书',
      organization: '示例工作室'
    })
    writeFileSync(unicodePath, unicodeCsr.pem)

    const result = runOpenSsl(openssl!, ['req', '-in', unicodePath, '-noout', '-verify', '-subject'])
    const output = result.stdout + result.stderr
    expect(result.ok, `OpenSSL 拒绝了解析中文 CN 的 CSR: ${output}`).toBe(true)
    expect(output).toContain('verify OK')
    expect(output).toContain('CN=示例开发证书')
    expect(output).toContain('O=示例工作室')
  })

  it('OpenSSL 提取的 CSR 公钥与本项目导出的公钥一致', () => {
    const result = runOpenSsl(openssl!, ['req', '-in', csrPath, '-noout', '-pubkey'])
    expect(result.ok).toBe(true)
    expect(normalizePem(result.stdout)).toBe(normalizePem(publicKeyPem))
    expect(normalizePem(publicKeyPemFromCsr(csrPem))).toBe(normalizePem(publicKeyPem))
  })

  it('本项目解析证书得到的 SHA-256 指纹与 OpenSSL 一致', () => {
    const result = runOpenSsl(openssl!, ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256', '-serial'])
    expect(result.ok).toBe(true)

    const fingerprint = /Fingerprint=([0-9A-Fa-f:]+)/.exec(result.stdout)?.[1] ?? ''
    const serial = /serial=([0-9A-Fa-f]+)/.exec(result.stdout)?.[1] ?? ''

    const parsed = parseCertificatePem(readFileSync(certPath, 'utf8'))
    expect(stripColons(fingerprint)).toBe(stripColons(parsed.info.sha256Fingerprint))
    expect(parsed.info.serialNumber).toBe(serial.replace(/^0+/, '').toUpperCase())
  })

  it('本项目解析的证书公钥与 OpenSSL 签发的证书匹配私钥', () => {
    const parsed = parseCertificatePem(readFileSync(certPath, 'utf8'))
    expect(certificateMatchesPrivateKey(parsed, privateKeyPem).matches).toBe(true)
  })

  it('本项目的 P12 能被 OpenSSL 用正确密码打开，且能提取出匹配的证书与私钥', () => {
    const parsed = parseCertificatePem(readFileSync(certPath, 'utf8'))
    const der = createPkcs12(privateKeyPem, parsed.pem, {
      password: PASSWORD,
      friendlyName: 'iOS Cert Manager Verification',
      algorithm: 'aes256'
    })
    writeFileSync(p12Path, der)

    // -info -nokeys 会在 stdout 打印 bag attributes（含 friendlyName）
    const info = runOpenSsl(openssl!, ['pkcs12', '-in', p12Path, '-passin', `pass:${PASSWORD}`, '-info', '-nokeys'])
    const infoOutput = info.stdout + info.stderr
    expect(info.ok, `OpenSSL 无法解析本项目生成的 P12: ${infoOutput}`).toBe(true)
    expect(infoOutput).toContain('friendlyName: iOS Cert Manager Verification')

    // 结构断言（完全不经过 node-forge）：私钥**与证书袋**都使用 PBES2 + AES-256-CBC，
    // MAC 摘要为 SHA-1。PBES2 OID 出现两次 = 私钥袋与证书袋都被加密
    // （未加密的证书袋是 node-forge 的默认行为，部分 Java 系工具链会因此导入失败）。
    expect(derContainsOid(der, OID_PBES2), '未找到 PBES2 OID').toBe(true)
    expect(derContainsOid(der, OID_AES256_CBC), '未找到 AES-256-CBC OID').toBe(true)
    expect(countOidOccurrences(der, OID_PBES2), '证书袋没有被加密（PBES2 只出现一次）').toBeGreaterThanOrEqual(2)
    expect(countOidOccurrences(der, OID_ENCRYPTED_DATA), '未找到 PKCS#7 EncryptedData 结构').toBeGreaterThanOrEqual(1)
    const asn1Dump = runOpenSsl(openssl!, ['asn1parse', '-inform', 'DER', '-in', p12Path])
    expect(asn1Dump.stdout).toContain(':sha1')

    const certOut = join(dir, 'extracted-cert.pem')
    const keyOut = join(dir, 'extracted-key.pem')

    const extractCert = runOpenSsl(openssl!, [
      'pkcs12',
      '-in',
      p12Path,
      '-passin',
      `pass:${PASSWORD}`,
      '-clcerts',
      '-nokeys',
      '-out',
      certOut
    ])
    expect(extractCert.ok, `OpenSSL 提取证书失败: ${extractCert.stderr}`).toBe(true)

    const extractKey = runOpenSsl(openssl!, [
      'pkcs12',
      '-in',
      p12Path,
      '-passin',
      `pass:${PASSWORD}`,
      '-nocerts',
      '-nodes',
      '-out',
      keyOut
    ])
    expect(extractKey.ok, `OpenSSL 提取私钥失败: ${extractKey.stderr}`).toBe(true)

    // 独立比对：提取出的证书公钥 === 提取出的私钥公钥 === 我们生成的公钥
    const certPub = runOpenSsl(openssl!, ['x509', '-in', certOut, '-noout', '-pubkey'])
    const keyPub = runOpenSsl(openssl!, ['pkey', '-in', keyOut, '-pubout'])
    expect(certPub.ok).toBe(true)
    expect(keyPub.ok).toBe(true)
    expect(normalizePem(certPub.stdout)).toBe(normalizePem(keyPub.stdout))
    expect(normalizePem(certPub.stdout)).toBe(normalizePem(publicKeyPem))
  })

  it('OpenSSL 使用错误密码打开本项目 P12 时必须失败', () => {
    const result = runOpenSsl(openssl!, [
      'pkcs12',
      '-in',
      p12Path,
      '-passin',
      'pass:definitely-wrong',
      '-info',
      '-nokeys'
    ])
    expect(result.ok).toBe(false)
    expect(`${result.stdout}${result.stderr}`).toMatch(/mac verify error|invalid password|MAC/i)
  })

  it('3DES(PKCS#12 PBE) 变体也能被 OpenSSL 正确读取', () => {
    const parsed = parseCertificatePem(readFileSync(certPath, 'utf8'))
    const der = createPkcs12(privateKeyPem, parsed.pem, { password: PASSWORD, algorithm: '3des' })
    const legacyPath = join(dir, 'out-3des.p12')
    writeFileSync(legacyPath, der)

    const result = runOpenSsl(openssl!, [
      'pkcs12',
      '-in',
      legacyPath,
      '-passin',
      `pass:${PASSWORD}`,
      '-info',
      '-nokeys'
    ])
    expect(result.ok, `OpenSSL 无法读取 3DES 变体: ${result.stderr}`).toBe(true)
    expect(derContainsOid(der, OID_PBE_SHA1_3DES), '未找到 3DES PBE OID').toBe(true)
    // 私钥袋 + 证书袋都用 pbeWithSHAAnd3-KeyTripleDES-CBC（与 OpenSSL 传统产物一致）
    expect(countOidOccurrences(der, OID_PBE_SHA1_3DES), '证书袋没有用 3DES 加密').toBeGreaterThanOrEqual(2)
  })

  it('friendlyName 使用标准 BMPString 编码（中文名以 UCS-2 存放）', () => {
    const parsed = parseCertificatePem(readFileSync(certPath, 'utf8'))
    const friendlyName = '端到端恢复证书'
    const der = createPkcs12(privateKeyPem, parsed.pem, {
      password: PASSWORD,
      friendlyName,
      algorithm: 'aes256'
    })

    // 说明：OpenSSL 3 的 `pkcs12 -info` 在打印非 ASCII BMPString 时会丢失高字节，
    // 显示成乱码 —— 那是 OpenSSL 显示层的问题。这里做字节级断言，证明文件内容本身是
    // 符合 PKCS#12 规范的 UCS-2 BMPString。
    const decoded = readFriendlyNameFromDer(der)
    expect(decoded?.tag).toBe(0x1e)
    expect(decoded?.value).toBe(friendlyName)

    // 本项目自己的解析器也必须能读回原名
    const contents = parsePkcs12(der, PASSWORD)
    expect(contents.friendlyName).toBe(friendlyName)
  })

  it('能读取 OpenSSL 导出的传统 P12 与 OpenSSL 3 默认参数的现代 P12（反向互通）', () => {
    const legacyP12 = join(dir, 'openssl-legacy.p12')
    const legacyExport = runOpenSsl(openssl!, [
      'pkcs12',
      '-export',
      '-inkey',
      keyPath,
      '-in',
      certPath,
      '-out',
      legacyP12,
      '-passout',
      `pass:${PASSWORD}`,
      '-keypbe',
      'PBE-SHA1-3DES',
      '-certpbe',
      'PBE-SHA1-3DES',
      '-macalg',
      'sha1',
      '-iter',
      '2048'
    ])
    expect(legacyExport.ok, `OpenSSL 导出传统 P12 失败: ${legacyExport.stderr}`).toBe(true)
    const legacy = parsePkcs12(new Uint8Array(readFileSync(legacyP12)), PASSWORD)
    expect(certificateMatchesPrivateKey(legacy.certificatePems[0], privateKeyPem).matches).toBe(true)

    // OpenSSL 3 默认：PBES2 + PBKDF2-HMAC-SHA256 + AES-256-CBC，MAC 为 SHA-256
    const modernP12 = join(dir, 'openssl-modern.p12')
    const modernExport = runOpenSsl(openssl!, [
      'pkcs12',
      '-export',
      '-inkey',
      keyPath,
      '-in',
      certPath,
      '-out',
      modernP12,
      '-passout',
      `pass:${PASSWORD}`
    ])
    expect(modernExport.ok, `OpenSSL 导出默认 P12 失败: ${modernExport.stderr}`).toBe(true)

    const modernBytes = new Uint8Array(readFileSync(modernP12))
    const modern = parsePkcs12(modernBytes, PASSWORD)
    expect(certificateMatchesPrivateKey(modern.certificatePems[0], privateKeyPem).matches).toBe(true)
    // 错误密码也必须失败
    expect(() => parsePkcs12(modernBytes, 'wrong')).toThrow(/密码错误|损坏/)
  })
})

// 算法 OID 的 DER 编码（公开常量，用于不依赖任何库的结构断言）
const OID_PBES2 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0d] // 1.2.840.113549.1.5.13
const OID_AES256_CBC = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2a] // 2.16.840.1.101.3.4.1.42
const OID_PBE_SHA1_3DES = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x01, 0x03] // 1.2.840.113549.1.12.1.3
const OID_ENCRYPTED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x06] // 1.2.840.113549.1.7.6

function derContainsOid(der: Uint8Array, oid: number[]): boolean {
  outer: for (let i = 0; i + oid.length <= der.length; i++) {
    for (let j = 0; j < oid.length; j++) {
      if (der[i + j] !== oid[j]) continue outer
    }
    return true
  }
  return false
}

/** 从 PKCS#12 的 DER 中定位 friendlyName 属性并解码其 BMPString 值 */
function readFriendlyNameFromDer(der: Uint8Array): { tag: number; value: string } | null {
  const oid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x14]
  const index = indexOfBytes(der, oid)
  if (index < 0) return null
  // 结构：OID, SET(0x31), BMPString(0x1e), 长度, 内容
  const setIndex = index + oid.length
  const stringIndex = setIndex + 2
  const tag = der[stringIndex]
  const length = der[stringIndex + 1]
  const bytes = der.slice(stringIndex + 2, stringIndex + 2 + length)
  let value = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    value += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
  }
  return { tag, value }
}

function countOidOccurrences(der: Uint8Array, oid: number[]): number {
  let count = 0
  outer: for (let i = 0; i + oid.length <= der.length; i++) {
    for (let j = 0; j < oid.length; j++) {
      if (der[i + j] !== oid[j]) continue outer
    }
    count += 1
    i += oid.length - 1
  }
  return count
}

function indexOfBytes(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function normalizePem(pem: string): string {
  return pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
}

function stripColons(value: string): string {
  return value.replace(/:/g, '').toUpperCase()
}
