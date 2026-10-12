import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { destroyDatabase } from '@/services/storage/database'
import {
  countByStatus,
  createCertificate,
  deleteCertificateCascade,
  getCertificate,
  listAllCertificates,
  listCertificates,
  requireCertificate,
  saveCertificateWithKey,
  updateCertificate
} from '@/services/storage/certificate-repository'
import { findOrphanKeys, getKeyByCertificateId, countKeys } from '@/services/storage/key-repository'
import type { KeyRecord } from '@/types/record'

async function newCertificate(name: string, status: Parameters<typeof updateCertificate>[1]['status'] = undefined) {
  const record = await createCertificate({ name, purpose: 'development' })
  if (status) await updateCertificate(record.id, { status })
  return record
}

function makeKey(certificateId: string, id = `key-${certificateId}`): KeyRecord {
  const now = new Date().toISOString()
  return {
    id,
    certificateId,
    algorithm: 'RSA',
    bits: 2048,
    sealedPrivateKey: { iv: 'aa', data: 'bb' },
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAA\n-----END PUBLIC KEY-----\n',
    modulusHex: 'ff',
    createdAt: now,
    updatedAt: now
  }
}

describe('IndexedDB 存储层', () => {
  beforeEach(async () => {
    await destroyDatabase()
  })

  it('创建、读取、更新证书记录', async () => {
    const created = await createCertificate({ name: '  测试证书 A  ', purpose: 'distribution', note: '备注' })
    expect(created.name).toBe('测试证书 A')
    expect(created.status).toBe('draft')
    expect(created.keyId).toBeNull()

    const fetched = await requireCertificate(created.id)
    expect(fetched.purpose).toBe('distribution')

    const updated = await updateCertificate(created.id, { status: 'csr-created' })
    expect(updated.status).toBe('csr-created')
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt >= created.updatedAt).toBe(true)
  })

  it('读取不存在的记录会抛出明确错误', async () => {
    await expect(requireCertificate('not-exist')).rejects.toThrow(/不存在/)
    expect(await getCertificate('not-exist')).toBeUndefined()
  })

  it('原子写入证书记录与私钥记录', async () => {
    const record = await createCertificate({ name: 'atomic', purpose: 'development' })
    const key = makeKey(record.id)
    await saveCertificateWithKey({ ...record, status: 'csr-created', keyId: key.id }, key)

    const stored = await requireCertificate(record.id)
    expect(stored.keyId).toBe(key.id)
    const storedKey = await getKeyByCertificateId(record.id)
    expect(storedKey?.id).toBe(key.id)
    expect(await countKeys()).toBe(1)
  })

  it('分页、搜索、状态筛选与排序', async () => {
    const a = await newCertificate('Alpha 开发证书', 'csr-created')
    const b = await newCertificate('Beta 发布证书', 'ready')
    await newCertificate('Gamma 开发证书', 'csr-created')
    await updateCertificate(a.id, { status: 'csr-created' })
    await updateCertificate(b.id, { status: 'ready' })

    const all = await listCertificates({ page: 1, pageSize: 2 })
    expect(all.total).toBe(3)
    expect(all.items).toHaveLength(2)

    const page2 = await listCertificates({ page: 2, pageSize: 2 })
    expect(page2.items).toHaveLength(1)

    const searched = await listCertificates({ search: '开发' })
    expect(searched.total).toBe(2)

    const byStatus = await listCertificates({ status: 'ready' })
    expect(byStatus.total).toBe(1)
    expect(byStatus.items[0].name).toBe('Beta 发布证书')

    const counts = await countByStatus()
    expect(counts.all).toBe(3)
    expect(counts['csr-created']).toBe(2)
    expect(counts.ready).toBe(1)

    const sorted = await listCertificates({ page: 1, pageSize: 10, sort: 'created-desc' })
    expect(sorted.items[0].name).toBe('Gamma 开发证书')
  })

  it('删除记录时区分是否删除私钥材料', async () => {
    const record = await createCertificate({ name: 'keep-key', purpose: 'development' })
    const key = makeKey(record.id)
    await saveCertificateWithKey({ ...record, keyId: key.id }, key)

    await deleteCertificateCascade(record.id, { deleteKeyMaterial: false })
    expect(await getCertificate(record.id)).toBeUndefined()
    // 私钥材料保留，但成为孤立记录
    expect(await countKeys()).toBe(1)
    expect((await findOrphanKeys()).length).toBe(1)

    const second = await createCertificate({ name: 'drop-key', purpose: 'development' })
    const secondKey = makeKey(second.id)
    await saveCertificateWithKey({ ...second, keyId: secondKey.id }, secondKey)

    await deleteCertificateCascade(second.id, { deleteKeyMaterial: true })
    expect(await getKeyByCertificateId(second.id)).toBeUndefined()
    expect(await countKeys()).toBe(1) // 只剩上一条孤立私钥
  })

  it('清空数据库后不再返回任何记录', async () => {
    await createCertificate({ name: 'to-be-cleared', purpose: 'development' })
    await destroyDatabase()
    expect(await listAllCertificates()).toHaveLength(0)
  })
})
