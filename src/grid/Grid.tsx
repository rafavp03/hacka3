import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BINS, type Bin, type Rules } from '../lib/schemas'
import type { GridStore } from './gridStore'
import type { Cell } from './groups'

export const CELL = 32
const OVERSCAN = 2
/** Tope duro de celdas en el DOM (el enunciado exige nunca más de 2 500). */
export const MAX_DOM_CELLS = 2400

export interface ViewRange {
  r0: number
  r1: number
  c0: number
  c1: number
}

export interface GridHandle {
  scrollToCell(r: number, c: number, align?: 'start' | 'center' | 'nearest'): void
  focus(): void
}

export interface Holder {
  displayName: string
  mine: boolean
}

interface Props {
  store: GridStore
  rules: Rules
  focus: Cell
  selection: Set<number> | null
  claimed: ReadonlyMap<number, Holder>
  initial: Cell
  label: string
  onFocusChange(cell: Cell): void
  onActivate(cell: Cell): void
  onBinKey(bin: Bin): void
  onEscape(): void
  onViewport(range: ViewRange, topLeft: Cell): void
  onCellPointerDown(cell: Cell, e: React.PointerEvent<HTMLDivElement>): void
  onHover(cell: Cell): void
  overlay?: ReactNode
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

export const Grid = memo(
  forwardRef<GridHandle, Props>(function Grid(props, ref) {
    const { store, rules, focus, selection, claimed } = props
    const scrollRef = useRef<HTMLDivElement>(null)
    const [vp, setVp] = useState({ top: props.initial.r * CELL, left: props.initial.c * CELL, width: 960, height: 600 })
    useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
    const raf = useRef<number | null>(null)

    const rows = store.rows
    const cols = store.cols

    // Posición inicial (?r=&c=): se abre directo ahí.
    useLayoutEffect(() => {
      const el = scrollRef.current
      if (!el) return
      el.scrollTop = props.initial.r * CELL
      el.scrollLeft = props.initial.c * CELL
      setVp({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight })
    }, [])

    useEffect(() => {
      const el = scrollRef.current
      if (!el) return
      const ro = new ResizeObserver(() => setVp((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight })))
      ro.observe(el)
      return () => ro.disconnect()
    }, [])

    const onScroll = useCallback(() => {
      if (raf.current !== null) return
      raf.current = requestAnimationFrame(() => {
        raf.current = null
        const el = scrollRef.current
        if (el) setVp({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight })
      })
    }, [])

    // Ventana visible (+ margen), con tope de celdas.
    const visRows = Math.max(1, Math.ceil(vp.height / CELL))
    const visCols = Math.max(1, Math.ceil(vp.width / CELL))
    let overscan = OVERSCAN
    while (overscan > 0 && (visRows + 2 * overscan + 1) * (visCols + 2 * overscan + 1) > MAX_DOM_CELLS) overscan--
    let r0 = clamp(Math.floor(vp.top / CELL) - overscan, 0, rows - 1)
    let r1 = clamp(Math.floor((vp.top + vp.height) / CELL) + overscan, 0, rows - 1)
    const c0 = clamp(Math.floor(vp.left / CELL) - overscan, 0, cols - 1)
    let c1 = clamp(Math.floor((vp.left + vp.width) / CELL) + overscan, 0, cols - 1)
    // Seguridad: si aun así no entra, se recorta (deja sitio para la celda con foco).
    const maxCols = Math.max(1, Math.floor((MAX_DOM_CELLS - 1) / Math.max(1, r1 - r0 + 1)))
    if (c1 - c0 + 1 > maxCols) c1 = c0 + maxCols - 1
    const maxRows = Math.max(1, Math.floor((MAX_DOM_CELLS - 1) / (c1 - c0 + 1)))
    if (r1 - r0 + 1 > maxRows) r1 = r0 + maxRows - 1

    // Bloques que hacen falta: solo los visibles (se piden con un pequeño retardo para no pedir de más al hacer scroll rápido).
    const tileSig = `${Math.floor(r0 / store.tileSize)}:${Math.floor(r1 / store.tileSize)}:${Math.floor(c0 / store.tileSize)}:${Math.floor(c1 / store.tileSize)}`
    useEffect(() => {
      const t = window.setTimeout(() => store.setWanted(store.tilesForRange(r0, r1, c0, c1)), 70)
      return () => window.clearTimeout(t)
    }, [tileSig, store])

    const topLeft = { r: clamp(Math.floor(vp.top / CELL), 0, rows - 1), c: clamp(Math.floor(vp.left / CELL), 0, cols - 1) }
    const onViewport = props.onViewport
    useEffect(() => {
      onViewport(
        {
          r0: Math.floor(vp.top / CELL),
          r1: Math.min(rows - 1, Math.floor((vp.top + vp.height - 1) / CELL)),
          c0: Math.floor(vp.left / CELL),
          c1: Math.min(cols - 1, Math.floor((vp.left + vp.width - 1) / CELL)),
        },
        topLeft,
      )
    }, [vp.top, vp.left, vp.width, vp.height])

    const scrollToCell = useCallback(
      (r: number, c: number, align: 'start' | 'center' | 'nearest' = 'nearest') => {
        const el = scrollRef.current
        if (!el) return
        const y = r * CELL
        const x = c * CELL
        if (align === 'start') {
          el.scrollTop = y
          el.scrollLeft = x
        } else if (align === 'center') {
          el.scrollTop = y - el.clientHeight / 2 + CELL / 2
          el.scrollLeft = x - el.clientWidth / 2 + CELL / 2
        } else {
          if (y < el.scrollTop) el.scrollTop = y
          else if (y + CELL > el.scrollTop + el.clientHeight) el.scrollTop = y + CELL - el.clientHeight
          if (x < el.scrollLeft) el.scrollLeft = x
          else if (x + CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = x + CELL - el.clientWidth
        }
      },
      [],
    )

    useImperativeHandle(ref, () => ({ scrollToCell, focus: () => scrollRef.current?.focus() }), [scrollToCell])

    const move = (r: number, c: number) => {
      const nr = clamp(r, 0, rows - 1)
      const nc = clamp(c, 0, cols - 1)
      props.onFocusChange({ r: nr, c: nc })
      scrollToCell(nr, nc, 'nearest')
    }

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      const page = Math.max(1, Math.floor(vp.height / CELL) - 1)
      const { r, c } = focus
      switch (e.key) {
        case 'ArrowUp':
          move(r - 1, c)
          break
        case 'ArrowDown':
          move(r + 1, c)
          break
        case 'ArrowLeft':
          move(r, c - 1)
          break
        case 'ArrowRight':
          move(r, c + 1)
          break
        case 'PageUp':
          move(r - page, c)
          break
        case 'PageDown':
          move(r + page, c)
          break
        case 'Home':
          if (e.ctrlKey || e.metaKey) move(0, 0)
          else move(r, 0)
          break
        case 'End':
          if (e.ctrlKey || e.metaKey) move(rows - 1, cols - 1)
          else move(r, cols - 1)
          break
        case 'Enter':
        case ' ':
          if (e.repeat) break
          props.onActivate(focus)
          break
        case 'Escape':
          props.onEscape()
          break
        case '1':
        case '2':
        case '3':
        case '4': {
          if (e.repeat) break
          const bin = BINS[Number(e.key) - 1]
          if (bin) props.onBinKey(bin)
          break
        }
        default:
          return
      }
      e.preventDefault()
    }

    const cellFromEvent = (e: React.PointerEvent<HTMLDivElement>): Cell | null => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-r]')
      if (!target) return null
      return { r: Number(target.dataset.r), c: Number(target.dataset.c) }
    }

    // Filas/columnas a dibujar; la celda con foco siempre está en el DOM.
    const rowList: number[] = []
    for (let r = r0; r <= r1; r++) rowList.push(r)
    if (focus.r < r0 || focus.r > r1) rowList.push(focus.r)
    const threshold = rules.tremorThreshold
    const idPrefix = `g${store.fileId}`

    return (
      <div
        ref={scrollRef}
        role="grid"
        tabIndex={0}
        aria-label={props.label}
        aria-rowcount={rows}
        aria-colcount={cols}
        aria-activedescendant={`${idPrefix}-${focus.r}-${focus.c}`}
        aria-multiselectable="true"
        className="mdr-grid relative overflow-auto rounded-md border border-slate-700 bg-slate-950"
        style={{ height: 'min(68vh, 704px)', maxWidth: '100%', width: Math.min(cols * CELL + 2, 1282), touchAction: 'none' }}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          const cell = cellFromEvent(e)
          if (!cell) return
          props.onFocusChange(cell)
          props.onCellPointerDown(cell, e)
        }}
        onPointerMove={(e) => {
          if (e.pointerType !== 'mouse' || e.buttons !== 0) return
          const cell = cellFromEvent(e)
          if (cell) props.onHover(cell)
        }}
      >
        <div role="presentation" style={{ position: 'relative', height: rows * CELL, width: cols * CELL }}>
          {rowList.map((r) => {
            const colList: number[] = []
            for (let c = c0; c <= c1; c++) colList.push(c)
            if (r === focus.r && (focus.c < c0 || focus.c > c1)) colList.push(focus.c)
            return (
              <div key={r} role="row" aria-rowindex={r + 1} style={{ position: 'absolute', top: r * CELL, left: 0, height: CELL, width: cols * CELL }}>
                {colList.map((c) => {
                  const v = store.cell(r, c)
                  const idx = r * cols + c
                  const isFocus = r === focus.r && c === focus.c
                  const sel = selection?.has(idx) ?? false
                  const holder = claimed.get(idx)
                  let cls = 'gc'
                  let label: string
                  let style: React.CSSProperties = { left: c * CELL }
                  if (!v) {
                    cls += ' gc-load'
                    label = 'cargando'
                  } else {
                    const scary = v.tremor >= threshold
                    if (scary) {
                      const t = v.tremor / 100
                      cls += ' gc-scary'
                      style = {
                        ...style,
                        ['--t' as string]: t.toFixed(2),
                        ['--amp' as string]: `${(0.4 + t * 1.6).toFixed(2)}px`,
                        ['--spd' as string]: `${(0.95 - t * 0.6).toFixed(2)}s`,
                        ['--dly' as string]: `${-((r * 7 + c * 13) % 10) / 10}s`,
                      }
                    }
                    if (v.bin) cls += ` gc-ref gc-bin-${v.bin}`
                    label = `${v.digit}${scary ? ', da miedo' : ''}${v.bin ? `, refinado en ${v.bin}` : ''}`
                  }
                  if (holder) {
                    cls += holder.mine ? ' gc-mine' : ' gc-claim'
                    if (!holder.mine) label += `, reservado por ${holder.displayName}`
                  }
                  if (sel) cls += ' gc-sel'
                  if (isFocus) cls += ' gc-focus'
                  return (
                    <div
                      key={c}
                      id={`${idPrefix}-${r}-${c}`}
                      role="gridcell"
                      aria-colindex={c + 1}
                      aria-selected={sel}
                      aria-label={label}
                      data-r={r}
                      data-c={c}
                      data-bin={v?.bin ?? undefined}
                      className={cls}
                      style={style}
                      title={holder && !holder.mine ? `Reservado por ${holder.displayName}` : undefined}
                    >
                      <span aria-hidden="true">{v ? v.digit : '·'}</span>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {props.overlay}
        </div>
      </div>
    )
  }),
)
