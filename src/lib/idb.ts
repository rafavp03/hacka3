/**
 * Almacén mínimo clave/valor sobre IndexedDB. Se usa solo para el refresh token: IndexedDB es consistente entre
 * pestañas (localStorage puede propagarse con retraso), así que dentro del lock de refresh siempre se lee el último.
 */
const DB = 'lumon'
const STORE = 'kv'

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbPromise = null
      reject(req.error ?? new Error('IndexedDB no disponible'))
    }
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        t.oncomplete = () => resolve(req.result)
        t.onerror = () => reject(t.error ?? new Error('IndexedDB'))
        t.onabort = () => reject(t.error ?? new Error('IndexedDB'))
      }),
  )
}

export async function idbGet(key: string): Promise<string | null> {
  const v = await tx<unknown>('readonly', (s) => s.get(key))
  return typeof v === 'string' ? v : null
}

export function idbSet(key: string, value: string): Promise<IDBValidKey> {
  return tx('readwrite', (s) => s.put(value, key))
}

export function idbDel(key: string): Promise<undefined> {
  return tx('readwrite', (s) => s.delete(key))
}
