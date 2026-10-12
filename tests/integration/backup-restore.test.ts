import 'fake-indexeddb/auto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { destroyDatabase, getDatabase } from '@/services/storage/database'
import { getCertificate, listAllCertificates } from '@/services/storage/certificate-repository'
import { getKeyByCertificateId } from '@/services/storage/key-repository'
import {
  createCertificateWithCsr,
  exportP12,
  getCertificateDetail,
  importCer
} from '@/services/certificates/certificate-service'
import { createBackup, inspectBackup, restoreBackup, validateBackupPayload } from '@/services/backup/backup-service'
import { DecryptionError } from '@/services/crypto/encryption-service'
import { destroyVault, unsealPrivateKey } from '@/services/crypto/key-management-service'
import { certificateMatchesPrivateKey } from '@/services/certificates/x509-service'
import { parsePkcs12 } from '@/services/certificates/pkcs12-service'
import { resolveOpenSsl, runOpenSsl } from '../helpers/openssl'

const openssl = resolveOpenSsl()
const BACKUP_PASSWORD = 'Backup-Pass-2026!'
const P12_PASSWORD = 'Export-Pass-2026!'

let dir = ''

const EXT_FILE = `[ v3 ]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
`

function signCsr(csrPem: string, privateKeyPem: string, outPath: string, tag: string): void {
  const csrPath = join(dir, `${tag}.csr`)
  const keyPath = join(dir, `${tag}.key.pem`)
  const extPath = join(dir, `${tag}.cnf`)
  writeFileSync(csrPath, csrPem)
  writeFileSync(keyPath, privateKeyPem)
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

/** 造一条“可导出 P12”的完整记录 */
async function createReadyCertificate(name: string) {
  const record = await createCertificateWithCsr({ name, purpose: 'development' })
  const keyRecord = await getKeyByCertificateId(record.id)
  const privateKeyPem = await unsealPrivateKey(keyRecord!)
  const certPath = join(dir, `${record.id}.pem`)
  signCsr(record.csrPem!, privateKeyPem, certPath, record.id)
  const imported = await importCer(record.id, { data: new Uint8Array(readFileSync(certPath)), fileName: `${name}.cer` })
  expect(imported.matchesPrivateKey).toBe(true)
  return imported.record
}

describe.skipIf(!openssl)('加密备份与恢复', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ioscert-backup-'))
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await destroyDatabase()
  })

  it('备份文件不包含明文私钥与密码，但解密后信息完整', async () => {
    const record = await createReadyCertificate('备份测试证书')
    const backup = await createBackup(BACKUP_PASSWORD, { iterations: 20_000 })

    expect(backup.content).not.toContain('PRIVATE KEY')
    expect(backup.content).not.toContain(BACKUP_PASSWORD)
    expect(backup.summary.certificateCount).toBe(1)
    expect(backup.summary.privateKeyCount).toBe(1)
    expect(backup.summary.withCerCount).toBe(1)

    const summary = await inspectBackup(backup.content, BACKUP_PASSWORD)
    expect(summary.certificateCount).toBe(1)
    expect(summary.sampleNames).toEqual([record.name])
  })

  it('错误密码无法解密，且不会改动现有数据', async () => {
    await createReadyCertificate('密码保护')
    const backup = await createBackup(BACKUP_PASSWORD, { iterations: 20_000 })

    await expect(inspectBackup(backup.content, 'wrong-password')).rejects.toBeInstanceOf(DecryptionError)
    await expect(restoreBackup(backup.content, 'wrong-password', 'replace')).rejects.toBeInstanceOf(DecryptionError)
    // 数据仍在
    expect((await listAllCertificates()).length).toBe(1)
  })

  it('损坏的备份文件无法恢复，且不会破坏原有数据', async () => {
    await createReadyCertificate('损坏测试')
    const backup = await createBackup(BACKUP_PASSWORD, { iterations: 20_000 })
    const tampered = backup.content.replace(/"ciphertext":"(.{10})/, '"ciphertext":"$1XXXX')

    await expect(restoreBackup(tampered, BACKUP_PASSWORD, 'replace')).rejects.toBeTruthy()
    expect((await listAllCertificates()).length).toBe(1)
    await expect(restoreBackup('not-json-at-all', BACKUP_PASSWORD, 'merge')).rejects.toThrow(/不是合法 JSON/)
  })

  it('不支持的备份版本会给出明确提示', async () => {
    const backup = await createBackup(BACKUP_PASSWORD, { iterations: 20_000 })
    const envelope = JSON.parse(backup.content)
    envelope.version = 99
    await expect(inspectBackup(JSON.stringify(envelope), BACKUP_PASSWORD)).rejects.toMatchObject({
      reason: 'unsupported-version'
    })
  })

  it('结构非法的负载会被拒绝', () => {
    expect(() => validateBackupPayload({ app: 'other-app', payloadVersion: 1, certificates: [], keys: [] })).toThrow(
      /不是本工具生成的备份/
    )
    expect(() => validateBackupPayload({ app: 'ios-certificate-manager', payloadVersion: 1 })).toThrow(
      /缺少 certificates/
    )
    expect(() =>
      validateBackupPayload({ app: 'ios-certificate-manager', payloadVersion: 99, certificates: [], keys: [] })
    ).toThrow(/高于当前支持的版本/)
    expect(() =>
      validateBackupPayload({
        app: 'ios-certificate-manager',
        payloadVersion: 1,
        certificates: [{ id: 'a', name: 'x', purpose: 'development', status: 'ready' }],
        keys: [{ id: 'k', certificateId: 'a', privateKeyPem: 'not-a-key' }]
      })
    ).toThrow(/缺少有效的 PKCS#8 私钥内容/)
  })

  it('清空本地数据后可以完整恢复，并且恢复后仍能导出可用的 P12', async () => {
    const record = await createReadyCertificate('恢复测试证书')
    const backup = await createBackup(BACKUP_PASSWORD, { iterations: 20_000 })

    // 模拟换设备：清空数据库与主密钥
    await destroyDatabase()
    await destroyVault()
    expect(await listAllCertificates()).toHaveLength(0)

    const result = await restoreBackup(backup.content, BACKUP_PASSWORD, 'replace')
    expect(result.added).toBe(1)
    expect(result.keyCount).toBe(1)

    const restored = await getCertificate(record.id)
    expect(restored?.name).toBe('恢复测试证书')
    expect(restored?.cerInfo?.sha256Fingerprint).toBe(record.cerInfo?.sha256Fingerprint)

    // 恢复后的私钥可用，且与证书匹配
    const keyRecord = await getKeyByCertificateId(record.id)
    expect(keyRecord).toBeTruthy()
    const privateKeyPem = await unsealPrivateKey(keyRecord!)
    expect(certificateMatchesPrivateKey(restored!.cerPem!, privateKeyPem).matches).toBe(true)

    // 恢复后重新导出 P12，用 OpenSSL 独立验证
    const detail = await getCertificateDetail(record.id)
    expect(detail.canExportP12).toBe(true)

    const exported = await exportP12(record.id, { password: P12_PASSWORD })
    const p12Path = join(dir, 'restored.p12')
    writeFileSync(p12Path, exported.der)
    const opensslCheck = runOpenSsl(openssl!, [
      'pkcs12',
      '-in',
      p12Path,
      '-passin',
      `pass:${P12_PASSWORD}`,
      '-info',
      '-nokeys'
    ])
    expect(opensslCheck.ok).toBe(true)

    const contents = parsePkcs12(exported.der, P12_PASSWORD)
    expect(certificateMatchesPrivateKey(contents.certificatePems[0], contents.privateKeyPem).matches).toBe(true)
  })

  it('合并模式跳过已存在记录，替换模式清空后写入', async () => {
    const first = await createReadyCertificate('原有证书')
    const backup = await createBackup(BACKUP_PASSWORD, { iterations: 20_000 })

    await createCertificateWithCsr({ name: '新增的本地证书', purpose: 'distribution' })
    expect((await listAllCertificates()).length).toBe(2)

    const merged = await restoreBackup(backup.content, BACKUP_PASSWORD, 'merge')
    expect(merged.added).toBe(0)
    expect(merged.skipped).toBe(1)
    expect((await listAllCertificates()).length).toBe(2)

    const replaced = await restoreBackup(backup.content, BACKUP_PASSWORD, 'replace')
    expect(replaced.removed).toBe(2)
    expect(replaced.added).toBe(1)
    const remaining = await listAllCertificates()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(first.id)
  })

  it('备份不依赖本机主密钥：不同主密钥环境下也能恢复（换设备场景）', async () => {
    await createReadyCertificate('跨设备证书')
    const backup = await createBackup(BACKUP_PASSWORD, { iterations: 20_000 })

    // 丢弃数据库与主密钥，等价于换了一个浏览器
    await destroyDatabase()
    await destroyVault()

    const db = await getDatabase()
    expect(await db.count('vault')).toBe(0)
    await restoreBackup(backup.content, BACKUP_PASSWORD, 'replace')
    // 恢复时自动创建了新的本机主密钥
    expect(await db.count('vault')).toBe(1)
  })
})
