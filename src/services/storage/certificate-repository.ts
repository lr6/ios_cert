/**
 * 证书记录仓储（IndexedDB）。
 *
 * 说明：
 * - 这是唯一直接读写 certificates / keys 两个 store 的模块；
 * - 多处写入放在同一个 IDB 事务里，避免出现“有证书记录但缺私钥”的半成品数据；
 * - 搜索使用名称子串匹配（个人工具数据量小，内存过滤足够且行为可预期），
 *   状态筛选与排序走索引。
 */
import type { CertificateStatus } from '@/types/certificate'
import type { CertificateRecord, KeyRecord } from '@/types/record'
import { getDatabase } from '@/services/storage/database'

export interface NewCertificateInput {
  name: string
  purpose: CertificateRecord['purpose']
  note?: string
}

export interface ListQuery {
  page?: number
  pageSize?: number
  /** 名称子串搜索（忽略大小写） */
  search?: string
  /** 状态筛选；'all' 或省略表示不过滤 */
  status?: CertificateStatus | 'all'
  sort?: 'updated-desc' | 'updated-asc' | 'created-desc'
}

export interface ListResult {
  items: CertificateRecord[]
  total: number
  page: number
  pageSize: number
}

export const DEFAULT_PAGE_SIZE = 10

export function generateId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 新建证书元信息（不含密钥记录，密钥由 saveCertificateWithKey 原子写入） */
export async function createCertificate(input: NewCertificateInput): Promise<CertificateRecord> {
  const now = new Date().toISOString()
  const record: CertificateRecord = {
    id: generateId(),
    name: input.name.trim(),
    purpose: input.purpose,
    status: 'draft',
    keyId: null,
    note: input.note?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  }
  const db = await getDatabase()
  await db.put('certificates', record)
  return record
}

/** 原子写入：证书记录 + 私钥记录（生成 CSR 成功后调用） */
export async function saveCertificateWithKey(certificate: CertificateRecord, key: KeyRecord): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction(['certificates', 'keys'], 'readwrite')
  await tx.objectStore('keys').put(key)
  await tx.objectStore('certificates').put(certificate)
  await tx.done
}

export async function getCertificate(id: string): Promise<CertificateRecord | undefined> {
  const db = await getDatabase()
  return db.get('certificates', id)
}

export async function requireCertificate(id: string): Promise<CertificateRecord> {
  const record = await getCertificate(id)
  if (!record) throw new Error(`证书记录不存在或已被删除（id: ${id}）`)
  return record
}

export async function updateCertificate(
  id: string,
  patch: Partial<Omit<CertificateRecord, 'id' | 'createdAt'>>
): Promise<CertificateRecord> {
  const db = await getDatabase()
  const current = await db.get('certificates', id)
  if (!current) throw new Error(`证书记录不存在或已被删除（id: ${id}）`)

  const next: CertificateRecord = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString()
  }
  await db.put('certificates', next)
  return next
}

export async function deleteCertificate(id: string): Promise<void> {
  const db = await getDatabase()
  await db.delete('certificates', id)
}

/**
 * 删除证书记录。
 * 明确区分两种删除语义（说明书 5.7）：
 * - deleteKeyMaterial = true  → 连同私钥一起删除（此后无法再导出 P12，且不可恢复）
 * - deleteKeyMaterial = false → 保留私钥材料，仅删除证书元信息
 */
export async function deleteCertificateCascade(id: string, options: { deleteKeyMaterial: boolean }): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction(['certificates', 'keys'], 'readwrite')
  const certificate = await tx.objectStore('certificates').get(id)
  await tx.objectStore('certificates').delete(id)

  if (options.deleteKeyMaterial) {
    const keyIds = new Set<string>()
    if (certificate?.keyId) keyIds.add(certificate.keyId)
    const byCertificate = await tx.objectStore('keys').index('by-certificateId').getAll(id)
    for (const key of byCertificate) keyIds.add(key.id)
    for (const keyId of keyIds) {
      await tx.objectStore('keys').delete(keyId)
    }
  }
  // deleteKeyMaterial = false 时故意保留私钥记录（会成为孤立私钥，
  // 由设置页的“孤立私钥”提示引导用户清理），但不再保留证书元信息。

  await tx.done
}

export async function listCertificates(query: ListQuery = {}): Promise<ListResult> {
  const db = await getDatabase()
  const page = Math.max(1, query.page ?? 1)
  const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : DEFAULT_PAGE_SIZE

  // 先按状态缩小范围（走索引），再在内存中做搜索/排序/分页
  let records: CertificateRecord[]
  if (query.status && query.status !== 'all') {
    records = await db.getAllFromIndex('certificates', 'by-status', query.status)
  } else {
    records = await db.getAll('certificates')
  }

  const search = query.search?.trim().toLowerCase()
  if (search) {
    records = records.filter((record) => record.name.toLowerCase().includes(search))
  }

  records.sort(comparator(query.sort ?? 'updated-desc'))

  const total = records.length
  const start = (page - 1) * pageSize
  return { items: records.slice(start, start + pageSize), total, page, pageSize }
}

/** 各状态数量统计（列表页筛选器展示用） */
export async function countByStatus(): Promise<Record<CertificateStatus | 'all', number>> {
  const db = await getDatabase()
  const all = await db.getAll('certificates')
  const counts: Record<string, number> = {
    all: all.length,
    draft: 0,
    'csr-created': 0,
    'cer-imported': 0,
    ready: 0,
    error: 0
  }
  for (const record of all) {
    counts[record.status] = (counts[record.status] ?? 0) + 1
  }
  return counts as Record<CertificateStatus | 'all', number>
}

export async function listAllCertificates(): Promise<CertificateRecord[]> {
  const db = await getDatabase()
  return db.getAll('certificates')
}

function comparator(sort: NonNullable<ListQuery['sort']>): (a: CertificateRecord, b: CertificateRecord) => number {
  switch (sort) {
    case 'updated-asc':
      return (a, b) => a.updatedAt.localeCompare(b.updatedAt)
    case 'created-desc':
      return (a, b) => b.createdAt.localeCompare(a.createdAt)
    case 'updated-desc':
    default:
      return (a, b) => b.updatedAt.localeCompare(a.updatedAt)
  }
}
