import type { Bin, Rules } from '../lib/schemas'
import type { GridStore } from './gridStore'

export interface Cell {
  r: number
  c: number
}

export interface GroupInfo {
  /** Identificador estable del grupo: índice mínimo + tamaño. */
  id: string
  cells: Cell[]
  /** Índices r * cols + c. */
  indexSet: Set<number>
  size: number
  /** true si superó maxGroupSize durante la exploración (se cortó). */
  truncated: boolean
  noise: boolean
  expectedBin: Bin | null
  refinedBin: Bin | null
}

export function binFor(digits: number[], rules: Rules): Bin | null {
  if (digits.length === 0) return null
  const order = rules.binning.order
  let idx: number
  if (rules.binning.strategy === 'MAX_DIGIT_MOD') idx = Math.max(...digits) % 4
  else idx = digits.reduce((a, b) => a + b, 0) % 4
  return order[idx] ?? null
}

export function isScary(tremor: number, rules: Rules) {
  return tremor >= rules.tremorThreshold
}

/**
 * Grupo completo (componente conexo máximo de celdas que dan miedo) que contiene (r, c), aunque cruce varios bloques:
 * los bloques que faltan se piden al vuelo. Si supera maxGroupSize se corta: ya se sabe que es ruido.
 */
export async function findGroup(store: GridStore, rules: Rules, r: number, c: number, signal?: AbortSignal): Promise<GroupInfo | null> {
  const start = store.cell(r, c) ?? (await store.ensureTile(store.tileOf(r, c)), store.cell(r, c))
  if (!start || !isScary(start.tremor, rules)) return null
  const cols = store.cols
  const visited = new Set<number>([r * cols + c])
  const cells: Cell[] = [{ r, c }]
  const digits: number[] = [start.digit]
  let refinedBin = start.bin
  let frontier: Cell[] = [{ r, c }]
  let pending: Cell[] = []
  const limit = rules.maxGroupSize + 1
  const dirs4 = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const
  const dirs8 = [...dirs4, [-1, -1], [-1, 1], [1, -1], [1, 1]] as const
  const dirs = rules.connectivity === 8 ? dirs8 : dirs4
  let truncated = false

  while (frontier.length > 0 || pending.length > 0) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (frontier.length === 0) {
      const missing = new Set(pending.map((p) => store.tileOf(p.r, p.c)))
      await Promise.all([...missing].map((k) => store.ensureTile(k)))
      frontier = pending
      pending = []
      // Las celdas pendientes se reevalúan ahora que su bloque está cargado.
      const recheck = frontier
      frontier = []
      for (const p of recheck) {
        const v = store.cell(p.r, p.c)
        if (!v) continue
        if (isScary(v.tremor, rules)) {
          cells.push(p)
          digits.push(v.digit)
          if (v.bin) refinedBin = v.bin
          frontier.push(p)
        }
      }
      continue
    }
    const next: Cell[] = []
    for (const cur of frontier) {
      for (const [dr, dc] of dirs) {
        const nr = cur.r + dr
        const nc = cur.c + dc
        if (nr < 0 || nc < 0 || nr >= store.rows || nc >= store.cols) continue
        const idx = nr * cols + nc
        if (visited.has(idx)) continue
        visited.add(idx)
        const v = store.cell(nr, nc)
        if (!v) {
          pending.push({ r: nr, c: nc })
          continue
        }
        if (!isScary(v.tremor, rules)) continue
        cells.push({ r: nr, c: nc })
        digits.push(v.digit)
        if (v.bin) refinedBin = v.bin
        next.push({ r: nr, c: nc })
      }
    }
    frontier = next
    if (cells.length >= limit) {
      truncated = true
      break
    }
  }

  const size = cells.length
  const noise = truncated || size < rules.minGroupSize || size > rules.maxGroupSize
  const indexSet = new Set(cells.map((x) => x.r * cols + x.c))
  const minIdx = Math.min(...indexSet)
  return {
    id: `${minIdx}:${size}`,
    cells,
    indexSet,
    size,
    truncated,
    noise,
    expectedBin: noise ? null : binFor(digits, rules),
    refinedBin,
  }
}
