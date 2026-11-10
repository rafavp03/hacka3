import { createStore } from '../lib/store'

export interface LumonEvent {
  id: number | null
  type: string
  data: unknown
}

type Handler = (ev: LumonEvent) => void
const handlers = new Map<string, Set<Handler>>()

/** Ids ya aplicados: ningún evento se aplica dos veces (el stream puede repetirlos). */
const seen = new Set<number>()
const seenOrder: number[] = []

export function on(type: string | string[], h: Handler): () => void {
  const types = Array.isArray(type) ? type : [type]
  for (const t of types) {
    let set = handlers.get(t)
    if (!set) handlers.set(t, (set = new Set()))
    set.add(h)
  }
  return () => {
    for (const t of types) handlers.get(t)?.delete(h)
  }
}

/** Entrega un evento a los suscriptores de esta pestaña. Devuelve false si era un duplicado. */
export function dispatch(ev: LumonEvent): boolean {
  if (ev.id !== null) {
    if (seen.has(ev.id)) return false
    seen.add(ev.id)
    seenOrder.push(ev.id)
    if (seenOrder.length > 5000) {
      const old = seenOrder.shift()
      if (old !== undefined) seen.delete(old)
    }
  }
  for (const h of [...(handlers.get(ev.type) ?? [])]) {
    try {
      h(ev)
    } catch (e) {
      console.error('Error aplicando evento', ev.type, e)
    }
  }
  for (const h of [...(handlers.get('*') ?? [])]) h(ev)
  return true
}

export type StreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'blocked' | 'stopped'

export interface StreamStatus {
  state: StreamState
  role: 'leader' | 'follower' | null
  detail: string | null
}

export const streamStatus = createStore<StreamStatus>({ state: 'idle', role: null, detail: null })
