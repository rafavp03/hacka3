import { env } from '../env'
import { ApiError, SessionEndedError } from '../lib/errors'
import { request } from '../lib/http'
import { TicketSchema } from '../lib/schemas'
import { createStore } from '../lib/store'
import { backoffDelay } from '../lib/time'
import type { Cell } from './groups'

export interface FloorMember {
  userId: number
  displayName: string
}

export interface FloorClaim {
  claimId: string
  userId: number
  displayName: string
  cells: Cell[]
  expiresAt: string | null
}

export type FloorStatus = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed'

export interface FloorState {
  status: FloorStatus
  detail: string | null
  members: FloorMember[]
  claims: FloorClaim[]
  myClaimId: string | null
}

export type ClaimResult =
  | { kind: 'granted'; claimId: string }
  | { kind: 'denied'; reason: string; holder: FloorMember | null }
  | { kind: 'unavailable' }

/** Códigos de cierre definitivos: no se reconecta. */
const FATAL: Record<number, string> = {
  4400: 'Mensaje inválido enviado al piso (error de la app).',
  4403: 'Origen no verificado o sin permiso para el piso compartido.',
  4404: 'El archivo no existe en el piso compartido.',
  4423: 'El Piso de Pruebas está cerrado: el piso compartido no está disponible.',
}

const PING_EVERY = 10_000
const RENEW_EVERY = 7_000
const CURSOR_MIN_INTERVAL = 110 // < 10 mensajes por segundo

type InMsg = { type: string; seq?: number; [k: string]: unknown }

function toCells(v: unknown): Cell[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is Cell => typeof x === 'object' && x !== null && typeof (x as Cell).r === 'number' && typeof (x as Cell).c === 'number')
}

function toClaim(m: Record<string, unknown>): FloorClaim | null {
  if (typeof m.claimId !== 'string' || typeof m.userId !== 'number') return null
  return {
    claimId: m.claimId,
    userId: m.userId,
    displayName: typeof m.displayName === 'string' ? m.displayName : `Usuario ${m.userId}`,
    cells: toCells(m.cells),
    expiresAt: typeof m.expiresAt === 'string' ? m.expiresAt : null,
  }
}

/**
 * Cliente del WebSocket del piso (nativo, ticket nuevo en cada conexión).
 * Los cursores van en un store aparte para que su llegada no vuelva a renderizar la grilla.
 */
export class FloorClient {
  readonly state = createStore<FloorState>({ status: 'connecting', detail: null, members: [], claims: [], myClaimId: null })
  readonly cursors = createStore<ReadonlyMap<number, Cell>>(new Map())

  private ws: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private reconnectTimer: number | null = null
  private pingTimer: number | null = null
  private renewTimer: number | null = null
  private outstandingPings = 0
  private lastSeq: number | null = null
  private awaitingSnapshot = true
  private ticketFailures = 0
  private reqCounter = 0
  private pendingClaims = new Map<string, { resolve: (r: ClaimResult) => void; timer: number }>()
  private lastCursorSent = 0
  private cursorTimer: number | null = null
  private pendingCursor: Cell | null = null
  /** Celda de la reserva propia, para volver a pedirla tras reconectar. */
  private wantedClaimCell: Cell | null = null
  private readonly fileId: number
  private readonly myUserId: number

  constructor(fileId: number, myUserId: number) {
    this.fileId = fileId
    this.myUserId = myUserId
  }

  start() {
    this.stopped = false
    void this.connect()
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  stop() {
    this.stopped = true
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.release()
    this.clearTimers()
    if (this.ws) {
      this.ws.onclose = null
      try {
        this.ws.close(1000, 'bye')
      } catch {
        /* ya cerrado */
      }
      this.ws = null
    }
    for (const p of this.pendingClaims.values()) {
      window.clearTimeout(p.timer)
      p.resolve({ kind: 'unavailable' })
    }
    this.pendingClaims.clear()
    this.state.set((s) => ({ ...s, status: 'closed', members: [], claims: [], myClaimId: null }))
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private onVisibility = () => {
    if (document.hidden && this.cursorTimer !== null) {
      window.clearTimeout(this.cursorTimer)
      this.cursorTimer = null
      this.pendingCursor = null
    }
  }

  private clearTimers() {
    for (const t of [this.reconnectTimer, this.cursorTimer]) if (t !== null) window.clearTimeout(t)
    for (const t of [this.pingTimer, this.renewTimer]) if (t !== null) window.clearInterval(t)
    this.reconnectTimer = this.cursorTimer = this.pingTimer = this.renewTimer = null
  }

  private setStatus(status: FloorStatus, detail: string | null = null) {
    this.state.set((s) => ({ ...s, status, detail }))
  }

  private async connect() {
    if (this.stopped) return
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    let ticket: string
    try {
      const { data } = await request('/floor/tickets', { method: 'POST', body: { fileId: this.fileId }, retries: 2, retryNetwork: true }, (v) =>
        TicketSchema.parse(v),
      )
      ticket = data.ticket
    } catch (e) {
      if (this.stopped || e instanceof SessionEndedError) return
      if (e instanceof ApiError && (e.code === 'CLEARANCE_REQUIRED' || e.status === 403 || e.status === 404)) {
        this.setStatus('failed', e.code === 'CLEARANCE_REQUIRED' ? FATAL[4423] ?? null : e.message)
        return
      }
      this.scheduleReconnect()
      return
    }
    if (this.stopped) return
    const url = `${env.wsBaseUrl}/floor/ws?ticket=${encodeURIComponent(ticket)}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.lastSeq = null
    this.awaitingSnapshot = true
    ws.onopen = () => {
      this.outstandingPings = 0
      this.pingTimer = window.setInterval(() => this.ping(), PING_EVERY)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let msg: InMsg
      try {
        msg = JSON.parse(ev.data) as InMsg
      } catch {
        return
      }
      this.handle(msg)
    }
    ws.onclose = (ev) => this.onClose(ev)
  }

  private ping() {
    if (!this.isOpen()) return
    // Dos pong sin llegar: la conexión está muerta, se cierra y se reconecta.
    if (this.outstandingPings >= 2) {
      const ws = this.ws
      this.ws = null
      if (ws) {
        ws.onclose = null
        ws.close(1000, 'dead')
      }
      this.onClose({ code: 1006, reason: 'sin pong' } as CloseEvent)
      return
    }
    this.outstandingPings++
    this.send({ type: 'ping', t: Date.now() })
  }

  private onClose(ev: CloseEvent) {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer)
    if (this.renewTimer !== null) window.clearInterval(this.renewTimer)
    this.pingTimer = this.renewTimer = null
    this.ws = null
    // Al cortarse, las reservas se liberan en el servidor: no quedan cursores ni reservas fantasma.
    this.cursors.set(new Map())
    this.state.set((s) => ({ ...s, members: [], claims: [], myClaimId: null }))
    for (const p of this.pendingClaims.values()) {
      window.clearTimeout(p.timer)
      p.resolve({ kind: 'unavailable' })
    }
    this.pendingClaims.clear()
    if (this.stopped) return
    const fatal = FATAL[ev.code]
    if (fatal) {
      this.setStatus('failed', `${fatal}${ev.reason ? ` (${ev.reason})` : ''}`)
      return
    }
    if (ev.code === 4401) {
      this.ticketFailures++
      if (this.ticketFailures >= 2) {
        this.setStatus('failed', 'El piso rechazó el ticket dos veces seguidas.')
        return
      }
      this.scheduleReconnect(0)
      return
    }
    if (ev.code === 4429) {
      this.scheduleReconnect(10_000 + Math.random() * 2000)
      return
    }
    if (ev.code === 4408) {
      this.scheduleReconnect(500)
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(delay?: number) {
    if (this.stopped) return
    const wait = delay ?? backoffDelay(this.attempt, 1000, 30_000)
    this.attempt++
    this.setStatus('reconnecting', `Reconectando en ${Math.ceil(wait / 1000)} s`)
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, wait)
  }

  private send(msg: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  private handle(m: InMsg) {
    switch (m.type) {
      case 'snapshot':
        this.applySnapshot(m)
        return
      case 'pong':
        this.outstandingPings = 0
        return
      case 'cursor': {
        if (typeof m.userId !== 'number' || m.userId === this.myUserId) return
        if (typeof m.r !== 'number' || typeof m.c !== 'number') return
        const r = m.r
        const c = m.c
        this.cursors.set((prev) => new Map(prev).set(m.userId as number, { r, c }))
        return
      }
      case 'claim.denied': {
        const id = String(m.requestId)
        const p = this.pendingClaims.get(id)
        if (!p) return
        window.clearTimeout(p.timer)
        this.pendingClaims.delete(id)
        const h = m.holder as { userId?: unknown; displayName?: unknown } | null
        p.resolve({
          kind: 'denied',
          reason: typeof m.reason === 'string' ? m.reason : 'HELD',
          holder: h && typeof h.userId === 'number' ? { userId: h.userId, displayName: String(h.displayName ?? '') } : null,
        })
        this.wantedClaimCell = null
        return
      }
    }
    // claim.granted resuelve la promesa aunque haya que resincronizar el estado.
    if (m.type === 'claim.granted') this.onGranted(m)
    // claim.released sin seq: respuesta a un renew/release de una reserva que ya no es nuestra.
    if (m.type === 'claim.released' && typeof m.seq !== 'number') {
      if (typeof m.claimId === 'string') this.removeClaim(m.claimId)
      return
    }
    if (typeof m.seq !== 'number') return
    if (this.awaitingSnapshot || this.lastSeq === null) return
    if (m.seq <= this.lastSeq) return // duplicado
    if (m.seq !== this.lastSeq + 1) {
      // Se perdió algo: se reconstruye desde snapshot.
      this.awaitingSnapshot = true
      this.send({ type: 'resync' })
      return
    }
    this.lastSeq = m.seq
    switch (m.type) {
      case 'member.joined':
        if (typeof m.userId === 'number') {
          const member = { userId: m.userId, displayName: String(m.displayName ?? '') }
          this.state.set((s) => ({ ...s, members: [...s.members.filter((x) => x.userId !== member.userId), member] }))
        }
        break
      case 'member.left':
        if (typeof m.userId === 'number') {
          const uid = m.userId
          this.state.set((s) => ({ ...s, members: s.members.filter((x) => x.userId !== uid) }))
          this.cursors.set((prev) => {
            const n = new Map(prev)
            n.delete(uid)
            return n
          })
        }
        break
      case 'claim.granted':
      case 'claim.updated': {
        const claim = toClaim(m)
        if (claim) this.state.set((s) => ({ ...s, claims: [...s.claims.filter((x) => x.claimId !== claim.claimId), claim] }))
        break
      }
      case 'claim.released':
        if (typeof m.claimId === 'string') this.removeClaim(m.claimId)
        break
    }
  }

  private removeClaim(claimId: string) {
    this.state.set((s) => ({ ...s, claims: s.claims.filter((x) => x.claimId !== claimId), myClaimId: s.myClaimId === claimId ? null : s.myClaimId }))
    if (this.state.get().myClaimId === null && this.renewTimer !== null) {
      window.clearInterval(this.renewTimer)
      this.renewTimer = null
    }
  }

  private applySnapshot(m: InMsg) {
    this.awaitingSnapshot = false
    this.lastSeq = typeof m.seq === 'number' ? m.seq : 0
    this.attempt = 0
    this.ticketFailures = 0
    const members: FloorMember[] = []
    const cursors = new Map<number, Cell>()
    if (Array.isArray(m.members)) {
      for (const raw of m.members as Record<string, unknown>[]) {
        if (typeof raw.userId !== 'number') continue
        if (!members.some((x) => x.userId === raw.userId)) members.push({ userId: raw.userId, displayName: String(raw.displayName ?? '') })
        if (raw.userId !== this.myUserId && typeof raw.r === 'number' && typeof raw.c === 'number') cursors.set(raw.userId, { r: raw.r, c: raw.c })
      }
    }
    const claims = Array.isArray(m.claims) ? (m.claims as Record<string, unknown>[]).map(toClaim).filter((x): x is FloorClaim => x !== null) : []
    const myClaimId = this.state.get().myClaimId
    this.state.set({
      status: 'open',
      detail: null,
      members,
      claims,
      myClaimId: myClaimId && claims.some((c) => c.claimId === myClaimId) ? myClaimId : null,
    })
    this.cursors.set(cursors)
    // Tras reconectar, si teníamos una reserva hay que volver a pedirla (puede que otro la haya tomado).
    if (this.wantedClaimCell && !this.state.get().myClaimId && this.pendingClaims.size === 0) {
      void this.claim(this.wantedClaimCell)
    }
  }

  private onGranted(m: InMsg) {
    const id = String(m.requestId)
    const claim = toClaim(m)
    const p = this.pendingClaims.get(id)
    if (p) {
      window.clearTimeout(p.timer)
      this.pendingClaims.delete(id)
    }
    if (!claim) return
    this.state.set((s) => ({
      ...s,
      myClaimId: claim.claimId,
      claims: [...s.claims.filter((x) => x.claimId !== claim.claimId && x.claimId !== s.myClaimId), claim],
    }))
    if (this.renewTimer !== null) window.clearInterval(this.renewTimer)
    this.renewTimer = window.setInterval(() => {
      const mine = this.state.get().myClaimId
      if (mine) this.send({ type: 'renew', claimId: mine })
    }, RENEW_EVERY)
    p?.resolve({ kind: 'granted', claimId: claim.claimId })
  }

  /** Reserva el grupo de esa celda. Si el piso no está disponible, responde `unavailable` (se puede refinar igual). */
  claim(cell: Cell, timeoutMs = 6000): Promise<ClaimResult> {
    this.wantedClaimCell = cell
    if (!this.isOpen() || this.awaitingSnapshot) return Promise.resolve({ kind: 'unavailable' })
    const requestId = `c-${++this.reqCounter}`
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.pendingClaims.delete(requestId)
        resolve({ kind: 'unavailable' })
      }, timeoutMs)
      this.pendingClaims.set(requestId, { resolve, timer })
      this.send({ type: 'claim', requestId, r: cell.r, c: cell.c })
    })
  }

  /** Libera la reserva propia (al cancelar, al refinar o al salir). */
  release() {
    this.wantedClaimCell = null
    const mine = this.state.get().myClaimId
    if (this.renewTimer !== null) window.clearInterval(this.renewTimer)
    this.renewTimer = null
    if (!mine) return
    this.send({ type: 'release', claimId: mine })
    this.state.set((s) => ({ ...s, myClaimId: null, claims: s.claims.filter((c) => c.claimId !== mine) }))
  }

  /** Mueve el cursor propio: como máximo ~9 mensajes por segundo y nada si la pestaña está oculta. */
  moveCursor(cell: Cell) {
    if (document.hidden || !this.isOpen()) return
    this.pendingCursor = cell
    const now = Date.now()
    const wait = this.lastCursorSent + CURSOR_MIN_INTERVAL - now
    if (wait <= 0) {
      this.flushCursor()
    } else if (this.cursorTimer === null) {
      this.cursorTimer = window.setTimeout(() => {
        this.cursorTimer = null
        this.flushCursor()
      }, wait)
    }
  }

  private flushCursor() {
    const c = this.pendingCursor
    this.pendingCursor = null
    if (!c || document.hidden) return
    if (this.send({ type: 'cursor', r: c.r, c: c.c })) this.lastCursorSent = Date.now()
  }
}
