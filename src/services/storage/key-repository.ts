/**
 * 私钥记录仓储（IndexedDB）。
 * 私钥记录里只有密文（sealedPrivateKey）与公钥信息，任何地方都不得写入明文私钥。
 */
import type { KeyRecord } from '@/types/record'
import { getDatabase } from '@/services/storage/database'

export async function getKey(id: string): Promise<KeyRecord | undefined> {
  const db = await getDatabase()
  return db.get('keys', id)
}

export async function getKeyByCertificateId(certificateId: string): Promise<KeyRecord | undefined> {
  const db = await getDatabase()
  const keys = await db.getAllFromIndex('keys', 'by-certificateId', certificateId)
  return keys[0]
}

export async function putKey(record: KeyRecord): Promise<void> {
  const db = await getDatabase()
  await db.put('keys', record)
}

export async function deleteKey(id: string): Promise<void> {
  const db = await getDatabase()
  await db.delete('keys', id)
}

export async function countKeys(): Promise<number> {
  const db = await getDatabase()
  return db.count('keys')
}

/** 是否存在孤立私钥（对应的证书记录已被删除），设置页用于提示清理 */
export async function findOrphanKeys(): Promise<KeyRecord[]> {
  const db = await getDatabase()
  const [keys, certificates] = await Promise.all([db.getAll('keys'), db.getAll('certificates')])
  const certificateIds = new Set(certificates.map((record) => record.id))
  return keys.filter((key) => !certificateIds.has(key.certificateId))
}
