import { authStore } from '../auth/authStore'
import { createStore } from '../lib/store'
import { on } from './eventBus'

export interface Contingency {
  id: number | string
  userId: number
  message: string
  createdAt: string
}

export const contingencyStore = createStore<Contingency[]>([])

on('contingency.activated', (ev) => {
  const d = ev.data as Partial<Contingency> | null
  if (!d || (typeof d.id !== 'number' && typeof d.id !== 'string')) return
  const me = authStore.get().me
  if (!me || d.userId !== me.id) return
  const c: Contingency = { id: d.id, userId: me.id, message: typeof d.message === 'string' ? d.message : '', createdAt: String(d.createdAt ?? '') }
  contingencyStore.set((list) => (list.some((x) => x.id === c.id) ? list : [...list, c]))
})

on('contingency.resolved', (ev) => {
  const d = ev.data as { id?: number | string } | null
  if (!d || d.id === undefined) return
  resolveContingency(d.id)
})

export function resolveContingency(id: number | string) {
  contingencyStore.set((list) => list.filter((c) => c.id !== id))
}
