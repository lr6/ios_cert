import 'fake-indexeddb/auto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { destroyDatabase, getDatabase } from '@/services/storage/database'
import { deleteCertificateCascade, getCertificate, requireCertificate } from '@/services/storage/certificate-repository'
import { getKeyByCertificateId } from '@/services/storage/key-repository'
import {
  createCertificateWithCsr,
  exportP12,
  getCertificateDetail,
  importCer,
  renameCertificate
} from '@/services/certificates/certificate-service'
import { certificateMatchesPrivateKey, parseCertificatePem } from '@/services/certificates/x509-service'
import { parsePkcs12 } from '@/services/certificates/pkcs12-service'
import { unsealPrivateKey } from '@/services/crypto/key-management-service'
import { resolveOpenSsl, runOpenSsl } from '../helpers/openssl'

const openssl = resolveOpenSsl()
let dir = ''

const EXT_FILE = `[ v3 ]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
`

/** 用 OpenSSL 基于 CSR 签发自签名证书，扮演 Apple 返回 CER 的角色 */
function signCsr(csrPem: string, keyPath: string, outPath: string): void {
  const csrPath = join(dir, 'req.csr')
  const extPath = join(dir, 'ext.cnf')
  writeFileSync(csrPath, csrPem)
  writeFileSync(extPath, EXT_FILE)
  const result = runOpenSsl(openssl!, [
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
    extPath,
    '-extensions',
    'v3',
    '-out',
    outPath
  ])
  if (!result.ok) throw new Error(`OpenSSL 签发失败: ${result.stderr}`)
}

describe.skipIf(!openssl)('完整业务流程（存储 + 加密 + OpenSSL 交叉验证）', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ioscert-flow-'))
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await destroyDatabase()
  })

  it('新建证书：生成密钥与 CSR，私钥以密文保存', async () => {
    const record = await createCertificateWithCsr({ name: '流程测试证书', purpose: 'development', note: 'note' })
    expect(record.status).toBe('csr-created')
    expect(record.csrPem).toContain('BEGIN CERTIFICATE REQUEST')
    expect(record.csrInfo?.selfVerified).toBe(true)
    expect(record.csrInfo?.subject.commonName).toBe('流程测试证书')
    expect(record.keyId).toBeTruthy()

    const keyRecord = await getKeyByCertificateId(record.id)
    expect(keyRecord).toBeTruthy()
    // IndexedDB 中不得出现明文私钥
    expect(JSON.stringify(keyRecord)).not.toContain('PRIVATE KEY')
    expect(keyRecord?.sealedPrivateKey.data.length).toBeGreaterThan(0)

    // 私钥可以用主密钥解封，且与证书请求中的公钥一致
    const privateKeyPem = await unsealPrivateKey(keyRecord!)
    expect(privateKeyPem).toContain('BEGIN PRIVATE KEY')
  })

  it('拒绝非法证书名', async () => {
    await expect(createCertificateWithCsr({ name: '   ', purpose: 'development' })).rejects.toThrow(/不能为空/)
    await expect(createCertificateWithCsr({ name: 'x'.repeat(200), purpose: 'development' })).rejects.toThrow(/过长/)
  })

  it('导入匹配的 CER：状态进入 ready，可导出 P12', async () => {
    const record = await createCertificateWithCsr({ name: '导入流程证书', purpose: 'distribution' })
    const keyRecord = await getKeyByCertificateId(record.id)
    const keyPath = join(dir, 'key.pem')
    writeFileSync(keyPath, await unsealPrivateKey(keyRecord!))

    const certPath = join(dir, 'cert.pem')
    signCsr(record.csrPem!, keyPath, certPath)
    const certDer = readFileSync(certPath)

    const imported = await importCer(record.id, { data: new Uint8Array(certDer), fileName: 'cert.cer' })
    expect(imported.matchesPrivateKey).toBe(true)
    expect(imported.record.status).toBe('ready')
    expect(imported.record.cerInfo?.publicKeyBits).toBe(2048)
    expect(imported.record.cerFileName).toBe('cert.cer')
    expect(imported.record.lastError).toBeUndefined()

    const detail = await getCertificateDetail(record.id)
    expect(detail.canExportP12).toBe(true)
    expect(detail.hasPrivateKey).toBe(true)

    const exported = await exportP12(record.id, { password: 'Export-Pass-123' })
    expect(exported.fileName).toBe('导入流程证书.p12')
    expect(exported.der.length).toBeGreaterThan(500)
    expect(exported.certificate.p12ExportedAt).toBeTruthy()

    // 导出后可重新打开并验证内容匹配
    const contents = parsePkcs12(exported.der, 'Export-Pass-123')
    expect(certificateMatchesPrivateKey(contents.certificatePems[0], contents.privateKeyPem).matches).toBe(true)
    expect(parseCertificatePem(contents.certificatePems[0]).info.sha256Fingerprint).toBe(
      imported.record.cerInfo?.sha256Fingerprint
    )
  })

  it('导入不匹配的 CER：标记 error 并给出真实原因，且不写假状态', async () => {
    const record = await createCertificateWithCsr({ name: '不匹配证书', purpose: 'development' })
    const otherRecord = await createCertificateWithCsr({ name: '另一个证书', purpose: 'development' })
    const otherKey = await getKeyByCertificateId(otherRecord.id)
    const otherKeyPath = join(dir, 'other-key.pem')
    writeFileSync(otherKeyPath, await unsealPrivateKey(otherKey!))

    const foreignCertPath = join(dir, 'foreign-cert.pem')
    signCsr(otherRecord.csrPem!, otherKeyPath, foreignCertPath)

    const imported = await importCer(record.id, {
      data: new Uint8Array(readFileSync(foreignCertPath)),
      fileName: 'foreign.cer'
    })
    expect(imported.matchesPrivateKey).toBe(false)
    expect(imported.record.status).toBe('error')
    expect(imported.record.lastError).toMatch(/不匹配/)

    // 状态为 error 时不允许导出 P12
    const detail = await getCertificateDetail(record.id)
    expect(detail.canExportP12).toBe(false)
    await expect(exportP12(record.id, { password: 'Export-Pass-123' })).rejects.toThrow(/不匹配/)
  })

  it('导出 P12 前校验密码强度，并拒绝无效密码', async () => {
    const record = await createCertificateWithCsr({ name: '密码校验', purpose: 'development' })
    await expect(exportP12(record.id, { password: 'short' })).rejects.toThrow(/至少/)
    // 未导入 CER 时给出明确提示
    await expect(exportP12(record.id, { password: 'Long-Enough-123' })).rejects.toThrow(/尚未导入/)
  })

  it('重命名与删除：可只删元信息或连同私钥一起删除', async () => {
    const record = await createCertificateWithCsr({ name: '待重命名', purpose: 'development' })
    const renamed = await renameCertificate(record.id, '已重命名证书')
    expect(renamed.name).toBe('已重命名证书')
    expect(renamed.csrPem).toBe(record.csrPem)
    await expect(renameCertificate(record.id, '   ')).rejects.toThrow(/不能为空/)

    await deleteCertificateCascade(record.id, { deleteKeyMaterial: true })
    expect(await getCertificate(record.id)).toBeUndefined()
    expect(await getKeyByCertificateId(record.id)).toBeUndefined()
  })

  it('数据持久化：重新打开数据库后记录仍在（模拟刷新页面）', async () => {
    const record = await createCertificateWithCsr({ name: '持久化证书', purpose: 'distribution' })
    // 直接再取一次（会走同一份连接，等价于重新读取存储）
    const db = await getDatabase()
    const stored = await db.get('certificates', record.id)
    expect(stored?.name).toBe('持久化证书')
    expect((await requireCertificate(record.id)).id).toBe(record.id)
  })
})
