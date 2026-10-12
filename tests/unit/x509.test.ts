import { describe, expect, it } from 'vitest'
import {
  CertificateParseError,
  certificateMatchesPrivateKey,
  certificateValidity,
  parseCertificate
} from '@/services/certificates/x509-service'
import { parseCertificatePem } from '@/services/certificates/x509-service'
import { getTestFixture } from '../helpers/fixture'

// 夹具在运行时生成，仓库中不保存任何私钥（见 tests/helpers/fixture.ts）
const { certPem, certDer, keyPem, sha256Hex } = getTestFixture()

describe('X.509 证书解析（单元）', () => {
  it('解析 PEM 证书并得到正确的字段与指纹', () => {
    const artifact = parseCertificate({ data: new TextEncoder().encode(certPem), fileName: 'test-cert.pem' })

    expect(artifact.info.subjectCommonName).toBe('Test Fixture Certificate')
    expect(artifact.info.subject).toContain('O=Local Testing Only')
    expect(artifact.info.issuerCommonName).toBe('Test Fixture Certificate')
    expect(artifact.info.publicKeyBits).toBe(2048)
    expect(artifact.info.publicKeyExponent).toBe('0x10001')
    expect(artifact.info.signatureAlgorithm).toBe('SHA256withRSA')
    expect(artifact.info.sha256Fingerprint.replace(/:/g, '')).toBe(sha256Hex)
    expect(new Date(artifact.info.notBefore).getTime()).toBeLessThan(new Date(artifact.info.notAfter).getTime())
    expect(artifact.info.expired).toBe(false)
    expect(certificateValidity(artifact.info)).toBe('valid')
    expect(artifact.info.serialNumber).toMatch(/^[0-9A-F]+$/)
    expect(artifact.info.serialNumber.length).toBeGreaterThan(16)
    expect(artifact.info.keyUsage).toContain('digitalSignature')
    expect(artifact.info.extendedKeyUsage).toContain('codeSigning')
  })

  it('解析 DER（.cer）证书，结果与 PEM 完全一致', () => {
    const fromDer = parseCertificate({ data: certDer, fileName: 'test-cert.cer' })
    const fromPem = parseCertificatePem(certPem)

    expect(fromDer.info.sha256Fingerprint).toBe(fromPem.info.sha256Fingerprint)
    expect(fromDer.info.serialNumber).toBe(fromPem.info.serialNumber)
    expect(fromDer.derBase64).toBe(fromPem.derBase64)
    expect(fromDer.pem).toBe(fromPem.pem)
  })

  it('校验证书与私钥匹配（真实密钥参数比对）', () => {
    const certificate = parseCertificatePem(certPem)
    const match = certificateMatchesPrivateKey(certificate, keyPem)
    expect(match.matches).toBe(true)
  })

  it('匹配失败时给出明确原因', async () => {
    const { generateRsaKeyPair } = await import('@/services/certificates/csr-service')
    const other = await generateRsaKeyPair(2048)
    const result = certificateMatchesPrivateKey(certPem, other.privateKeyPem)

    expect(result.matches).toBe(false)
    expect(result.reason).toMatch(/不匹配/)
  })

  it('SHA-256 指纹格式为冒号分隔的大写十六进制', () => {
    const artifact = parseCertificatePem(certPem)
    expect(artifact.info.sha256Fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  })

  it('拒绝空文件和任意二进制垃圾', () => {
    expect(() => parseCertificate({ data: new Uint8Array(0) })).toThrow(CertificateParseError)
    expect(() => parseCertificate({ data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) })).toThrow(CertificateParseError)
    expect(() => parseCertificate({ data: new TextEncoder().encode('hello world, not a certificate') })).toThrow(
      CertificateParseError
    )
  })

  it('拒绝过大的文件', () => {
    expect(() => parseCertificate({ data: new Uint8Array(300 * 1024) })).toThrow(/过大/)
  })
})
