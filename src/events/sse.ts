import { env } from '../env'
import { endSession } from '../auth/session'
import { ApiError, SessionEndedError } from '../lib/errors'
import { request } from '../lib/http'
import { toApiError } from '../lib/httpCore'
import { TicketSchema } from '../lib/schemas'
import { backoffDelay, isAbortError, sleep } from '../lib/time'
import { dispatch, streamStatus, type LumonEvent, type StreamStatus } from './eventBus'

/**
 * Stream de eventos con UNA sola conexión por navegador:
 * - La pestaña que obtiene el Web Lock `lumon-sse-leader` es la líder y abre la conexión (ticket nuevo en cada una).
 * - Reparte cada evento al resto de pestañas por BroadcastChannel.
 * - Si la líder se cierra, el lock se libera y otra pestaña la retoma, continuando desde `lastEventId`.
 * El stream se lee con fetch + ReadableStream (sin librerías) para ver también los heartbeats `: hb` y detectar una
 * conexión muerta (45 s sin datos).
 */
const LAST_ID_KEY = 'lumon.lastEventId'
const DEAD_AFTER_MS = 45_000

type Msg =
  | { kind: 'event'; ev: LumonEvent }
  | { kind: 'status'; status: StreamStatus }
  | { kind: 'status-request' }

let channel: BroadcastChannel | null = null
let lockAbort: AbortController | null = null
let runAbort: AbortController | null = null
let running = false
let isLeader = false

function setStatus(s: Omit<StreamStatus, 'role'>) {
  const status: StreamStatus = { ...s, role: isLeader ? 'leader' : 'follower' }
  streamStatus.set(status)
  if (isLeader) channel?.postMessage({ kind: 'status', status } satisfies Msg)
}

function readLastId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_ID_KEY)
    if (!raw) return null
    const { id, at } = JSON.parse(raw) as { id: number; at: number }
    // El servidor guarda ~15 minutos: más viejo que eso solo provocaría un stream.reset.
    if (typeof id !== 'number' || Date.now() - at > 14 * 60_000) return null
    return id
  } catch {
    return null
  }
}

function writeLastId(id: number) {
  try {
    localStorage.setItem(LAST_ID_KEY, JSON.stringify({ id, at: Date.now() }))
  } catch {
    /* sin storage */
  }
}

let lastId: number | null = null

function deliver(ev: LumonEvent) {
  if (ev.id !== null && (lastId === null || ev.id > lastId)) {
    lastId = ev.id
    writeLastId(ev.id)
  }
  if (dispatch(ev)) channel?.postMessage({ kind: 'event', ev } satisfies Msg)
  if (ev.type === 'session.revoked') {
    const reason = typeof ev.data === 'object' && ev.data && 'reason' in ev.data ? String((ev.data as { reason: unknown }).reason) : 'SESSION_REVOKED'
    void endSession(reason === 'LOGOUT' || reason === 'REFRESH_REUSED' ? reason : 'SESSION_REVOKED')
  }
}

/** Parser SSE mínimo (campos id / event / data / comentarios). */
function createParser(onEvent: (ev: LumonEvent) => void) {
  let buffer = ''
  let data: string[] = []
  let event = 'message'
  let id: number | null = null
  return (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = buffer.slice(0, idx)
      const sepLen = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1
      buffer = buffer.slice(idx + sepLen)
      if (line === '') {
        if (data.length > 0) {
          let parsed: unknown = null
          const raw = data.join('\n')
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = raw
          }
          onEvent({ id, type: event, data: parsed })
        }
        data = []
        event = 'message'
        id = null
        continue
      }
      if (line.startsWith(':')) continue // comentario / heartbeat
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') data.push(value)
      else if (field === 'event') event = value
      else if (field === 'id') {
        const n = Number(value)
        id = value !== '' && Number.isFinite(n) ? n : null
      }
    }
  }
}

async function connectOnce(signal: AbortSignal): Promise<'closed' | 'superseded'> {
  const { data: t } = await request('/events/tickets', { method: 'POST', signal, retries: 3, retryNetwork: true }, (v) => TicketSchema.parse(v))
  const url = new URL(`${env.apiBaseUrl}/events/stream`)
  url.searchParams.set('ticket', t.ticket)
  if (lastId !== null) url.searchParams.set('lastEventId', String(lastId))
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  let watchdog = 0
  const resetWatchdog = () => {
    window.clearTimeout(watchdog)
    watchdog = window.setTimeout(() => ctl.abort(new DOMException('dead', 'TimeoutError')), DEAD_AFTER_MS)
  }
  try {
    resetWatchdog()
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'text/event-stream' }, cache: 'no-store', credentials: 'omit' })
    if (!res.ok || !res.body) throw await toApiError(res)
    setStatus({ state: 'open', detail: null })
    let superseded = false
    const parse = createParser((ev) => {
      if (ev.type === 'stream.superseded') {
        superseded = true
        ctl.abort()
        return
      }
      deliver(ev)
    })
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      resetWatchdog()
      if (value) parse(value)
    }
    return superseded ? 'superseded' : 'closed'
  } catch (e) {
    if (ctl.signal.reason instanceof DOMException && ctl.signal.reason.name === 'TimeoutError') {
      return 'closed' // conexión muerta: se reconecta
    }
    if (isAbortError(e) && !signal.aborted) return 'closed'
    throw e
  } finally {
    window.clearTimeout(watchdog)
    signal.removeEventListener('abort', onAbort)
  }
}

async function leaderLoop(signal: AbortSignal) {
  lastId = readLastId()
  let attempt = 0
  while (!signal.aborted) {
    setStatus({ state: attempt === 0 ? 'connecting' : 'reconnecting', detail: null })
    const startedAt = Date.now()
    try {
      const result = await connectOnce(signal)
      if (Date.now() - startedAt > 10_000) attempt = 0
      if (result === 'superseded') {
        setStatus({ state: 'reconnecting', detail: 'Otra conexión tomó el stream.' })
        await sleep(5000, signal)
      } else {
        setStatus({ state: 'reconnecting', detail: null })
        await sleep(backoffDelay(attempt++, 1000, 30_000), signal)
      }
    } catch (e) {
      if (signal.aborted || isAbortError(e)) return
      if (e instanceof SessionEndedError) return
      if (e instanceof ApiError && e.code === 'SESSION_REVOKED') {
        await endSession('SESSION_REVOKED')
        return
      }
      if (e instanceof ApiError && e.code === 'CLEARANCE_REQUIRED') {
        setStatus({ state: 'blocked', detail: 'Piso de Pruebas cerrado' })
        await sleep(30_000, signal).catch(() => undefined)
        continue
      }
      setStatus({ state: 'reconnecting', detail: e instanceof Error ? e.message : null })
      await sleep(backoffDelay(attempt++, 1000, 30_000), signal).catch(() => undefined)
    }
  }
}

export function startEvents() {
  if (running) return
  running = true
  channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lumon-events') : null
  channel?.addEventListener('message', (m: MessageEvent<Msg>) => {
    const msg = m.data
    if (msg.kind === 'event' && !isLeader) {
      if (msg.ev.id !== null && (lastId === null || msg.ev.id > lastId)) lastId = msg.ev.id
      dispatch(msg.ev)
      if (msg.ev.type === 'session.revoked') {
        const d = msg.ev.data as { reason?: unknown } | null
        const reason = d && typeof d.reason === 'string' ? d.reason : 'SESSION_REVOKED'
        void endSession(reason === 'LOGOUT' || reason === 'REFRESH_REUSED' ? reason : 'SESSION_REVOKED')
      }
    } else if (msg.kind === 'status' && !isLeader) {
      streamStatus.set({ ...msg.status, role: 'follower' })
    } else if (msg.kind === 'status-request' && isLeader) {
      channel?.postMessage({ kind: 'status', status: streamStatus.get() } satisfies Msg)
    }
  })
  streamStatus.set({ state: 'connecting', role: 'follower', detail: null })
  channel?.postMessage({ kind: 'status-request' } satisfies Msg)
  lockAbort = new AbortController()
  const run = async () => {
    isLeader = true
    runAbort = new AbortController()
    try {
      await leaderLoop(runAbort.signal)
    } finally {
      isLeader = false
    }
  }
  if (navigator.locks) {
    navigator.locks
      .request('lumon-sse-leader', { signal: lockAbort.signal }, run)
      .catch(() => undefined)
  } else {
    void run()
  }
}

export function stopEvents() {
  if (!running) return
  running = false
  lockAbort?.abort()
  runAbort?.abort()
  channel?.close()
  channel = null
  isLeader = false
  streamStatus.set({ state: 'stopped', role: null, detail: null })
}
