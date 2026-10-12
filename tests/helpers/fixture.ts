/**
 * 测试用证书夹具（fixture）。
 *
 * 为什么不在仓库里存私钥：
 * - 仓库里放任何 PEM 私钥（哪怕是自签测试密钥）都会触发代码托管平台的私钥告警，
 *   也容易被误当成真实密钥；
 * - 因此夹具改为**运行时生成**：每次跑测试时现场生成一对 RSA 密钥与一张自签证书，
 *   不落盘、不提交。
 *
 * 独立验证不受影响：真正的"外部工具交叉验证"在
 * tests/integration/openssl-compat.test.ts 中用 OpenSSL 现场签发的证书完成。
 */
import forge from 'node-forge'
import { binaryStringToBytes } from '@/utils/encoding'

export interface TestFixture {
  /** 自签证书 PEM */
  certPem: string
  /** 自签证书 DER 字节 */
  certDer: Uint8Array
  /** 对应私钥（PKCS#8 PEM） */
  keyPem: string
  /** 证书 SHA-256 指纹（十六进制，无分隔符） */
  sha256Hex: string
}

let cached: TestFixture | null = null

/** 取得测试夹具（同一进程内复用，避免重复生成密钥） */
export function getTestFixture(): TestFixture {
  if (!cached) cached = generateFixture()
  return cached
}

function generateFixture(): TestFixture {
  const keys = forge.pki.rsa.generateKeyPair(2048)

  const certificate = forge.pki.createCertificate()
  certificate.publicKey = keys.publicKey
  certificate.serialNumber = '00' + forge.util.bytesToHex(forge.random.getBytesSync(16))
  certificate.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
  certificate.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)

  const attributes = [
    { name: 'commonName', value: 'Test Fixture Certificate', valueTagClass: forge.asn1.Type.PRINTABLESTRING },
    { name: 'organizationName', value: 'Local Testing Only', valueTagClass: forge.asn1.Type.PRINTABLESTRING }
  ] as unknown as forge.pki.CertificateField[]
  certificate.setSubject(attributes)
  certificate.setIssuer(attributes)
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyCertSign: true, critical: true },
    { name: 'extKeyUsage', codeSigning: true }
  ])
  certificate.sign(keys.privateKey, forge.md.sha256.create())

  const certPem = forge.pki.certificateToPem(certificate)
  const der = binaryStringToBytes(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes())

  const sha256 = forge.md.sha256.create()
  sha256.update(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes())

  return {
    certPem,
    certDer: der,
    keyPem: forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey))),
    sha256Hex: sha256.digest().toHex().toUpperCase()
  }
}
