import { ApiError } from '../lib/errors'
import { request } from '../lib/http'
import { TileSchema, type Bin, type TileDto } from '../lib/schemas'
import { backoffDelay, isAbortError } from '../lib/time'

export interface TileData {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  /** Dígito 0-9 por celda. */
  values: Uint8Array
  /** Temblor 0-100 por celda (base64 decodificado). */
  tremor: Uint8Array
  /** 0 = sin refinar, o el código del carácter W/F/D/M. */
  bins: Uint8Array
  version: number
}

export const BIN_CHAR: Record<Bin, string> = { WO: 'W', FC: 'F', DR: 'D', MA: 'M' }
export const CHAR_BIN: Record<string, Bin> = { W: 'WO', F: 'FC', D: 'DR', M: 'MA' }

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function decodeTile(dto: TileDto): TileData {
  const n = dto.rows * dto.cols
  const values = new Uint8Array(n)
  for (let i = 0; i < n; i++) values[i] = dto.values.charCodeAt(i) - 48
  const tremor = decodeBase64(dto.tremor)
  if (tremor.length !== n || dto.values.length !== n || dto.bins.length !== n) throw new Error('Bloque con tamaño inconsistente.')
  const bins = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const ch = dto.bins.charCodeAt(i)
    bins[i] = ch === 46 /* . */ ? 0 : ch
  }
  return { ...dto, values, tremor, bins }
}

export interface CellView {
  digit: number
  tremor: number
  bin: Bin | null
}

const WINDOW_MS = 10_000
/** El servidor admite 40 bloques cada 10 s: se deja margen para no provocar 429. */
const BUDGET = 36
const MAX_CONCURRENT = 4

interface Inflight {
  ctl: AbortController
}

type Waiter = { resolve: (t: TileData) => void; reject: (e: unknown) => void }

/**
 * Caché y planificador de bloques de un archivo.
 * - Se piden solo los bloques que hacen falta (vista actual o un grupo que se está explorando).
 * - Nunca hay dos requests en vuelo para el mismo bloque.
 * - Se cancelan las de bloques que salieron de la vista antes de responder.
 * - Respeta 429 (nada sale hasta que pase Retry-After) y reintenta 503 con espera creciente.
 */
export class GridStore {
  readonly fileId: number
  readonly rows: number
  readonly cols: number
  readonly tileSize: number
  readonly tileRows: number
  readonly tileCols: number

  private tiles = new Map<number, TileData>()
  private inflight = new Map<number, Inflight>()
  private wanted = new Set<number>()
  private pins = new Map<number, number>()
  private waiters = new Map<number, Waiter[]>()
  private queue: number[] = []
  private attempts = new Map<number, number>()
  private notBefore = new Map<number, number>()
  private failed = new Map<number, string>()
  private sent: number[] = []
  private blockedUntil = 0
  private timer: number | null = null
  private disposed = false
  private listeners = new Set<() => void>()
  private _version = 0
  /** Estado visible del planificador (para la barra de estado). */
  rateLimitedUntil = 0

  constructor(fileId: number, rows: number, cols: number, tileSize: number) {
    this.fileId = fileId
    this.rows = rows
    this.cols = cols
    this.tileSize = tileSize
    this.tileRows = Math.ceil(rows / tileSize)
    this.tileCols = Math.ceil(cols / tileSize)
  }

  get version() {
    return this._version
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  getVersion = () => this._version

  private emit() {
    this._version++
    for (const l of [...this.listeners]) l()
  }

  key(tr: number, tc: number) {
    return tr * this.tileCols + tc
  }

  tileOf(r: number, c: number): number {
    return this.key(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize))
  }

  hasTile(key: number) {
    return this.tiles.has(key)
  }

  tileError(key: number): string | undefined {
    return this.failed.get(key)
  }

  loadedCount() {
    return this.tiles.size
  }

  inflightCount() {
    return this.inflight.size
  }

  cell(r: number, c: number): CellView | null {
    const t = this.tiles.get(this.tileOf(r, c))
    if (!t) return null
    const i = (r - t.originRow) * t.cols + (c - t.originCol)
    const b = t.bins[i] ?? 0
    return { digit: t.values[i] ?? 0, tremor: t.tremor[i] ?? 0, bin: b === 0 ? null : (CHAR_BIN[String.fromCharCode(b)] ?? null) }
  }

  /** Bloques que cubren un rango de celdas. */
  tilesForRange(r0: number, r1: number, c0: number, c1: number): number[] {
    const out: number[] = []
    const tr0 = Math.floor(r0 / this.tileSize)
    const tr1 = Math.floor(r1 / this.tileSize)
    const tc0 = Math.floor(c0 / this.tileSize)
    const tc1 = Math.floor(c1 / this.tileSize)
    for (let tr = tr0; tr <= tr1; tr++) for (let tc = tc0; tc <= tc1; tc++) out.push(this.key(tr, tc))
    return out
  }

  /** La vista pide estos bloques; los que salieron de la vista y no hacen falta se cancelan. */
  setWanted(keys: Iterable<number>) {
    if (this.disposed) return
    this.wanted = new Set(keys)
    for (const [k, f] of this.inflight) if (!this.isNeeded(k)) f.ctl.abort()
    this.queue = this.queue.filter((k) => this.isNeeded(k))
    for (const k of this.wanted) if (!this.tiles.has(k) && !this.failed.has(k)) this.enqueue(k, false)
    this.pump()
  }

  /** Pide un bloque fuera de la vista (por ejemplo, para completar un grupo). */
  ensureTile(key: number): Promise<TileData> {
    const t = this.tiles.get(key)
    if (t) return Promise.resolve(t)
    this.failed.delete(key)
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1)
    const p = new Promise<TileData>((resolve, reject) => {
      const list = this.waiters.get(key) ?? []
      list.push({ resolve, reject })
      this.waiters.set(key, list)
    })
    this.enqueue(key, true)
    this.pump()
    return p.finally(() => {
      const n = (this.pins.get(key) ?? 1) - 1
      if (n <= 0) this.pins.delete(key)
      else this.pins.set(key, n)
    })
  }

  /** Vuelve a pedir bloques concretos (409 ALREADY_REFINED) o todos (stream.reset). */
  invalidate(keys?: number[]) {
    const list = keys ?? [...this.tiles.keys()]
    for (const k of list) {
      this.tiles.delete(k)
      this.failed.delete(k)
    }
    this.emit()
    this.setWanted(this.wanted)
  }

  retryFailed() {
    this.failed.clear()
    this.setWanted(this.wanted)
  }

  /** Marca celdas con su caja sin volver a pedir la grilla. */
  applyRefinement(cells: { r: number; c: number }[], bin: Bin) {
    const code = BIN_CHAR[bin].charCodeAt(0)
    let changed = false
    for (const { r, c } of cells) {
      const t = this.tiles.get(this.tileOf(r, c))
      if (!t) continue
      const i = (r - t.originRow) * t.cols + (c - t.originCol)
      if (t.bins[i] !== code) {
        t.bins[i] = code
        changed = true
      }
    }
    if (changed) this.emit()
  }

  /** Reactiva el store tras un dispose (React StrictMode monta, desmonta y vuelve a montar en desarrollo). */
  revive() {
    if (!this.disposed) return
    this.disposed = false
    this.setWanted(this.wanted)
  }

  dispose() {
    this.disposed = true
    for (const f of this.inflight.values()) f.ctl.abort()
    this.inflight.clear()
    if (this.timer !== null) window.clearTimeout(this.timer)
    for (const list of this.waiters.values()) for (const w of list) w.reject(new DOMException('Aborted', 'AbortError'))
    this.waiters.clear()
    this.pins.clear()
    this.queue = []
  }

  private isNeeded(k: number) {
    return this.wanted.has(k) || (this.pins.get(k) ?? 0) > 0
  }

  private enqueue(k: number, priority: boolean) {
    if (this.tiles.has(k) || this.inflight.has(k)) return
    const idx = this.queue.indexOf(k)
    if (idx >= 0) {
      if (!priority) return
      this.queue.splice(idx, 1)
    }
    if (priority) this.queue.unshift(k)
    else this.queue.push(k)
  }

  private schedule(at: number) {
    if (this.disposed) return
    const delay = Math.max(0, at - Date.now())
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.pump()
    }, delay)
  }

  private pump() {
    if (this.disposed) return
    const now = Date.now()
    if (now < this.blockedUntil) {
      this.schedule(this.blockedUntil)
      return
    }
    this.sent = this.sent.filter((t) => now - t < WINDOW_MS)
    let earliestDeferred = Infinity
    while (this.inflight.size < MAX_CONCURRENT && this.queue.length > 0) {
      if (this.sent.length >= BUDGET) {
        this.schedule((this.sent[0] ?? now) + WINDOW_MS + 50)
        return
      }
      const idx = this.queue.findIndex((k) => (this.notBefore.get(k) ?? 0) <= now)
      if (idx < 0) break
      const [k] = this.queue.splice(idx, 1)
      if (k === undefined) break
      if (!this.isNeeded(k) || this.tiles.has(k) || this.inflight.has(k)) continue
      this.start(k)
    }
    for (const k of this.queue) earliestDeferred = Math.min(earliestDeferred, this.notBefore.get(k) ?? Infinity)
    if (earliestDeferred !== Infinity && this.inflight.size < MAX_CONCURRENT) this.schedule(earliestDeferred)
  }

  private start(k: number) {
    const tr = Math.floor(k / this.tileCols)
    const tc = k % this.tileCols
    const ctl = new AbortController()
    this.inflight.set(k, { ctl })
    this.sent.push(Date.now())
    request(`/files/${this.fileId}/tiles/${tr}/${tc}`, { signal: ctl.signal, retries: 0, retryNetwork: false }, (v) => TileSchema.parse(v))
      .then(({ data }) => {
        this.inflight.delete(k)
        const tile = decodeTile(data)
        this.tiles.set(k, tile)
        this.attempts.delete(k)
        this.notBefore.delete(k)
        this.failed.delete(k)
        const ws = this.waiters.get(k)
        this.waiters.delete(k)
        for (const w of ws ?? []) w.resolve(tile)
        this.emit()
      })
      .catch((e: unknown) => {
        this.inflight.delete(k)
        if (isAbortError(e) || ctl.signal.aborted) return
        if (e instanceof ApiError && e.status === 429) {
          const wait = e.retryAfterMs ?? 2000
          this.blockedUntil = Math.max(this.blockedUntil, Date.now() + wait)
          this.rateLimitedUntil = this.blockedUntil
          this.enqueue(k, true)
          this.emit()
          return
        }
        const attempt = this.attempts.get(k) ?? 0
        const transient = (e instanceof ApiError && e.status >= 500) || !(e instanceof ApiError)
        if (transient && attempt < 6) {
          this.attempts.set(k, attempt + 1)
          const wait = Math.max(e instanceof ApiError ? (e.retryAfterMs ?? 0) : 0, backoffDelay(attempt, 600, 15_000))
          this.notBefore.set(k, Date.now() + wait)
          this.enqueue(k, false)
          return
        }
        this.attempts.delete(k)
        this.failed.set(k, e instanceof Error ? e.message : 'Error')
        const ws = this.waiters.get(k)
        this.waiters.delete(k)
        for (const w of ws ?? []) w.reject(e)
        this.emit()
      })
      .finally(() => this.pump())
  }
}
