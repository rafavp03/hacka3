import { on } from '../events/eventBus'
import { RefinerSchema, type Refiner } from '../lib/schemas'
import { createStore, useStore } from '../lib/store'

/**
 * Última versión conocida de cada expediente. Una versión más vieja nunca pisa a una más nueva, llegue por el stream
 * o por una respuesta HTTP.
 */
export const refinerStore = createStore<ReadonlyMap<number, Refiner>>(new Map())

export function applyRefiner(r: Refiner): Refiner {
  const current = refinerStore.get().get(r.id)
  if (current && current.version >= r.version) return current
  refinerStore.set((m) => new Map(m).set(r.id, r))
  return r
}

/** Devuelve la versión más nueva entre la recibida y la del store. */
export function newest(r: Refiner): Refiner {
  const current = refinerStore.get().get(r.id)
  return current && current.version > r.version ? current : r
}

export function useRefiner(id: number | null): Refiner | undefined {
  return useStore(refinerStore, (m) => (id === null ? undefined : m.get(id)))
}

export interface RefinerUpdate {
  id: number
  version: number
  changes: string[]
  refiner: Refiner
  updatedBy: { userId: number | null; displayName: string }
}

export const lastRefinerUpdate = createStore<RefinerUpdate | null>(null)

on('refiner.updated', (ev) => {
  const d = ev.data as Partial<RefinerUpdate> | null
  if (!d || typeof d !== 'object') return
  const parsed = RefinerSchema.safeParse(d.refiner)
  if (!parsed.success) return
  const before = refinerStore.get().get(parsed.data.id)
  const applied = applyRefiner(parsed.data)
  if (applied === parsed.data && (!before || before.version < parsed.data.version)) {
    lastRefinerUpdate.set({
      id: parsed.data.id,
      version: parsed.data.version,
      changes: Array.isArray(d.changes) ? d.changes.filter((c): c is string => typeof c === 'string') : [],
      refiner: parsed.data,
      updatedBy: d.updatedBy && typeof d.updatedBy.displayName === 'string' ? d.updatedBy : { userId: null, displayName: 'alguien' },
    })
  }
})
