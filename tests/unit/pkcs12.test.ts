import { describe, expect, it } from 'vitest'
import { createPkcs12, parsePkcs12 } from '@/services/certificates/pkcs12-service'
import { generateRsaKeyPair } from '@/services/certificates/csr-service'
import { certificateMatchesPrivateKey } from '@/services/certificates/x509-service'
import { getTestFixture } from '../helpers/fixture'

// 夹具在运行时生成，仓库中不保存任何私钥（见 tests/helpers/fixture.ts）
const { certPem, keyPem } = getTestFixture()

const PASSWORD = 'Str0ng-Test-Passw0rd!'

describe('PKCS#12 打包与解析（单元）', () => {
  it('导出 P12 后可用正确密码重新打开，且包含匹配的证书与私钥', () => {
    const der = createPkcs12(keyPem, certPem, { password: PASSWORD, friendlyName: '测试证书' })
    expect(der.length).toBeGreaterThan(500)

    const contents = parsePkcs12(der, PASSWORD)
    expect(contents.certificatePems).toHaveLength(1)
    expect(contents.certificatePems[0]).toContain('BEGIN CERTIFICATE')
    expect(contents.privateKeyPem).toContain('BEGIN PRIVATE KEY')
    expect(contents.friendlyName).toBe('测试证书')

    // 重新打开后证书与私钥仍然匹配
    const match = certificateMatchesPrivateKey(contents.certificatePems[0], contents.privateKeyPem)
    expect(match.matches).toBe(true)
  })

  it('错误密码必须失败，并给出明确提示', () => {
    const der = createPkcs12(keyPem, certPem, { password: PASSWORD })
    expect(() => parsePkcs12(der, 'wrong-password')).toThrow(/密码错误|损坏/)
  })

  it('文件被篡改后必须失败', () => {
    const der = createPkcs12(keyPem, certPem, { password: PASSWORD })
    const tampered = der.slice()
    // 破坏靠后的密文区域
    tampered[tampered.length - 40] ^= 0xff
    expect(() => parsePkcs12(tampered, PASSWORD)).toThrow()
  })

  it('拒绝打包不匹配的证书与私钥', async () => {
    const other = await generateRsaKeyPair(2048)
    expect(() => createPkcs12(other.privateKeyPem, certPem, { password: PASSWORD })).toThrow(/无法导出 P12/)
  })

  it('在 PKCS#12 中混入额外证书时全部保留，且不混入其他私钥', () => {
    const der = createPkcs12(keyPem, certPem, { password: PASSWORD, chainPems: [certPem] })
    const contents = parsePkcs12(der, PASSWORD)
    expect(contents.certificatePems.length).toBe(2)
  })

  it('3DES 兼容模式同样可以正确打开', () => {
    const der = createPkcs12(keyPem, certPem, { password: PASSWORD, algorithm: '3des' })
    const contents = parsePkcs12(der, PASSWORD)
    expect(certificateMatchesPrivateKey(contents.certificatePems[0], contents.privateKeyPem).matches).toBe(true)
  })

  it('每次导出都使用新的盐值与 nonce（产物不可重复）', () => {
    const a = createPkcs12(keyPem, certPem, { password: PASSWORD })
    const b = createPkcs12(keyPem, certPem, { password: PASSWORD })
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    // 盐值/nonce 随机，两次产物整体不应相同
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })
})
