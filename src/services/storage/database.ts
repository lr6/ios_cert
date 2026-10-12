/**
 * IndexedDB 连接与结构迁移。
 *
 * 约定：
 * - 所有存储访问都必须经过 storage 层，Vue 组件不直接接触 IndexedDB；
 * - 版本升级集中在 upgrade 回调里，按 oldVersion 分支迁移，保证老数据可继续使用。
 */
import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { CertificateRecord, KeyRecord, MetaRecord, VaultRecord } from '@/types/record'
import { SCHEMA_VERSION_KEY } from '@/types/record'

export const DB_NAME = 'ios-certificate-manager'
/** 结构版本：仅在 store / index 变化时递增，并补上对应迁移 */
export const DB_VERSION = 1

export interface AppDatabase extends DBSchema {
  certificates: {
    key: string
    value: CertificateRecord
    indexes: { 'by-updatedAt': string; 'by-status': string; 'by-name': string }
  }
  keys: {
    key: string
    value: KeyRecord
    indexes: { 'by-certificateId': string }
  }
  vault: {
    key: string
    value: VaultRecord
  }
  meta: {
    key: string
    value: MetaRecord
  }
}

let databasePromise: Promise<IDBPDatabase<AppDatabase>> | null = null

export function getDatabase(): Promise<IDBPDatabase<AppDatabase>> {
  if (!databasePromise) {
    databasePromise = openDB<AppDatabase>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          const certificates = db.createObjectStore('certificates', { keyPath: 'id' })
          certificates.createIndex('by-updatedAt', 'updatedAt')
          certificates.createIndex('by-status', 'status')
          certificates.createIndex('by-name', 'name')

          const keys = db.createObjectStore('keys', { keyPath: 'id' })
          keys.createIndex('by-certificateId', 'certificateId')

          db.createObjectStore('vault', { keyPath: 'id' })
          db.createObjectStore('meta', { keyPath: 'key' })
        }
        // 未来版本迁移写在这里，例如：
        // if (oldVersion < 2) { ... }

        void transaction.objectStore('meta').put({
          key: SCHEMA_VERSION_KEY,
          value: DB_VERSION,
          updatedAt: new Date().toISOString()
        })
      },
      blocked() {
        console.warn('[storage] 数据库升级被其他标签页阻塞，请关闭本站其它标签页后重试')
      },
      blocking() {
        console.warn('[storage] 本页面持有旧版本连接，正在关闭以允许升级')
        void closeDatabase()
      },
      terminated() {
        console.warn('[storage] 数据库连接被浏览器异常终止')
        databasePromise = null
      }
    })
  }
  return databasePromise
}

export async function closeDatabase(): Promise<void> {
  if (!databasePromise) return
  const db = await databasePromise
  db.close()
  databasePromise = null
}

/** 清空全部本地数据（界面必须二次确认后调用） */
export async function clearAllData(): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction(['certificates', 'keys', 'vault'], 'readwrite')
  await Promise.all([
    tx.objectStore('certificates').clear(),
    tx.objectStore('keys').clear(),
    tx.objectStore('vault').clear()
  ])
  await tx.done
}

/** 彻底删除数据库（用于“清空本地数据”后的彻底重置） */
export async function destroyDatabase(): Promise<void> {
  await closeDatabase()
  await deleteDB(DB_NAME)
}

export async function getMeta(db: IDBPDatabase<AppDatabase>, key: string): Promise<unknown> {
  const record = await db.get('meta', key)
  return record ? record.value : undefined
}

export async function setMeta(db: IDBPDatabase<AppDatabase>, key: string, value: unknown): Promise<void> {
  await db.put('meta', { key, value, updatedAt: new Date().toISOString() })
}

/** 估算本地占用（设置页展示用） */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const estimate = await navigator.storage.estimate()
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}
