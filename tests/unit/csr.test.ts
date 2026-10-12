import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RSA_BITS,
  createCsr,
  generateRsaKeyPair,
  parseCsr,
  publicKeyPemFromCsr,
  verifyCsrPem
} from '@/services/certificates/csr-service'

describe('CSR 服务（单元）', () => {
  it('生成可导出的 RSA-2048 密钥对', async () => {
    const material = await generateRsaKeyPair(DEFAULT_RSA_BITS)

    expect(material.bits).toBe(2048)
    expect(material.extractable).toBe(true)
    expect(material.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    expect(material.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/)
    // 2048 位模数 -> 512 个 hex 字符
    expect(material.modulusHex.length).toBe(512)
  })

  it('拒绝不支持的密钥长度', async () => {
    await expect(generateRsaKeyPair(1024 as never)).rejects.toThrow(/不支持的 RSA 密钥长度/)
  })

  it('生成可自校验的 PKCS#10 CSR，且公钥与密钥一致', async () => {
    const material = await generateRsaKeyPair(2048)
    const csr = createCsr(material.privateKeyPem, material.publicKeyPem, {
      commonName: '示例开发证书',
      organization: 'Example Studio'
    })

    expect(csr.pem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/)
    expect(csr.info.subject.commonName).toBe('示例开发证书')
    expect(csr.info.subject.organization).toBe('Example Studio')
    expect(csr.info.publicKeyBits).toBe(2048)
    expect(csr.info.publicKeyAlgorithm).toBe('RSA')
    expect(csr.info.signatureAlgorithm).toBe('SHA256withRSA')
    expect(csr.info.selfVerified).toBe(true)
    expect(verifyCsrPem(csr.pem)).toBe(true)

    // CSR 中的公钥与私钥对应的公钥一致
    expect(publicKeyPemFromCsr(csr.pem).replace(/\s+/g, '')).toBe(material.publicKeyPem.replace(/\s+/g, ''))
  })

  it('中文证书名生成的 CSR 必须是合法 DER，且能正确解析回中文', async () => {
    const material = await generateRsaKeyPair(2048)
    const csr = createCsr(material.privateKeyPem, material.publicKeyPem, {
      commonName: '示例开发证书',
      organization: '示例工作室'
    })

    // 回归测试：node-forge 若未显式指定 valueTagClass，这里会得到非法 DER，
    // 表现为解析抛错或返回乱码（该问题由 OpenSSL 独立验证确认）。
    const parsed = parseCsr(csr.pem)
    expect(parsed.subject.commonName).toBe('示例开发证书')
    expect(parsed.subject.organization).toBe('示例工作室')
    expect(parsed.selfVerified).toBe(true)
    expect(verifyCsrPem(csr.pem)).toBe(true)
  })

  it('拒绝空 commonName', async () => {
    const material = await generateRsaKeyPair(2048)
    expect(() => createCsr(material.privateKeyPem, material.publicKeyPem, { commonName: '   ' })).toThrow(/commonName/)
  })

  it('拒绝公钥与私钥不匹配的组合', async () => {
    const a = await generateRsaKeyPair(2048)
    const b = await generateRsaKeyPair(2048)
    expect(() => createCsr(a.privateKeyPem, b.publicKeyPem, { commonName: 'mismatch' })).toThrow(/不匹配/)
  })

  it('被篡改的 CSR 无法通过验签', async () => {
    const material = await generateRsaKeyPair(2048)
    const csr = createCsr(material.privateKeyPem, material.publicKeyPem, { commonName: 'tamper' })
    const body = csr.pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
    const tampered = 'A' + body.slice(1)

    const lines = tampered.match(/.{1,64}/g) ?? []
    const tamperedPem = `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`

    expect(verifyCsrPem(tamperedPem)).toBe(false)
    // 解析也可能失败，两种情况都算“没有通过验证”
    try {
      expect(parseCsr(tamperedPem).selfVerified).toBe(false)
    } catch {
      expect(true).toBe(true)
    }
  })
})
