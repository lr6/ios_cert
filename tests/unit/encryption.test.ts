import { describe, expect, it } from 'vitest'
import {
  DecryptionError,
  decryptWithPassword,
  deriveKeyFromPassword,
  encryptWithPassword,
  generateVaultKey,
  openBytes,
  sealBytes,
  validateBackupEnvelope
} from '@/services/crypto/encryption-service'
import { base64ToBytes, randomBytes } from '@/utils/encoding'

// 测试用较低迭代次数以加快速度；生产默认 600000
const TEST_ITERATIONS = 20_000
const PASSWORD = 'correct horse battery staple'

describe('加密服务（单元）', () => {
  it('AES-256-GCM 加解密往返成功', async () => {
    const payload = { version: 1, records: [{ id: 'a', name: '证书 A' }], n: 42 }
    const envelope = await encryptWithPassword(payload, PASSWORD, { iterations: TEST_ITERATIONS })
    const decrypted = await decryptWithPassword<typeof payload>(envelope, PASSWORD)
    expect(decrypted).toEqual(payload)
  })

  it('错误密码抛 DecryptionError 且原因为密码/损坏', async () => {
    const envelope = await encryptWithPassword({ a: 1 }, PASSWORD, { iterations: TEST_ITERATIONS })
    await expect(decryptWithPassword(envelope, 'wrong')).rejects.toBeInstanceOf(DecryptionError)
    await expect(decryptWithPassword(envelope, 'wrong')).rejects.toMatchObject({
      reason: 'wrong-password-or-corrupted'
    })
  })

  it('密文被篡改后解密失败', async () => {
    const envelope = await encryptWithPassword({ a: 1 }, PASSWORD, { iterations: TEST_ITERATIONS })
    const bytes = base64ToBytes(envelope.ciphertext)
    bytes[bytes.length - 1] ^= 0x01
    const tampered = { ...envelope, ciphertext: Buffer.from(bytes).toString('base64') }
    await expect(decryptWithPassword(tampered, PASSWORD)).rejects.toBeInstanceOf(DecryptionError)
  })

  it('头部被篡改（版本号抬高）会得到“版本不支持”提示', async () => {
    const envelope = await encryptWithPassword({ a: 1 }, PASSWORD, { iterations: TEST_ITERATIONS })
    await expect(decryptWithPassword({ ...envelope, version: 99 }, PASSWORD)).rejects.toMatchObject({
      reason: 'unsupported-version'
    })
  })

  it('非备份文件格式会被拒绝', () => {
    expect(() => validateBackupEnvelope({ hello: 'world' })).toThrow(DecryptionError)
    expect(() => validateBackupEnvelope(null)).toThrow(/格式错误/)
  })

  it('每次加密使用新的盐值与 nonce', async () => {
    const a = await encryptWithPassword({ a: 1 }, PASSWORD, { iterations: TEST_ITERATIONS })
    const b = await encryptWithPassword({ a: 1 }, PASSWORD, { iterations: TEST_ITERATIONS })
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
    expect(a.cipher.iv).not.toBe(b.cipher.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('空密码被拒绝', async () => {
    await expect(encryptWithPassword({ a: 1 }, '', { iterations: TEST_ITERATIONS })).rejects.toThrow(/密码不能为空/)
    const envelope = await encryptWithPassword({ a: 1 }, PASSWORD, { iterations: TEST_ITERATIONS })
    await expect(decryptWithPassword(envelope, '')).rejects.toThrow(/请输入备份密码/)
  })

  it('迭代次数过低时拒绝派生密钥', async () => {
    await expect(deriveKeyFromPassword(PASSWORD, randomBytes(16), 1000)).rejects.toThrow(/迭代次数过低/)
  })

  it('封装的字节可用主密钥解开，密钥不可导出', async () => {
    const vaultKey = await generateVaultKey()
    expect(vaultKey.extractable).toBe(false)
    expect(vaultKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })

    const secret = randomBytes(64)
    const sealed = await sealBytes(secret, vaultKey, 'ioscert-vault')
    const opened = await openBytes(sealed, vaultKey, 'ioscert-vault')
    expect(Array.from(opened)).toEqual(Array.from(secret))

    // 错误的 AAD 必须解密失败
    await expect(openBytes(sealed, vaultKey, 'other-context')).rejects.toBeInstanceOf(DecryptionError)
  })

  it('相同明文在两次封装后密文不同（随机 nonce）', async () => {
    const vaultKey = await generateVaultKey()
    const secret = randomBytes(32)
    const a = await sealBytes(secret, vaultKey)
    const b = await sealBytes(secret, vaultKey)
    expect(a.iv).not.toBe(b.iv)
    expect(a.data).not.toBe(b.data)
  })
})
