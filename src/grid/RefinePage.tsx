import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useMe, hasPermission } from '../auth/authStore'
import { NotFound } from '../components/ErrorPages'
import { Alert, Button, PageTitle, ProgressBar, Spinner } from '../components/ui'
import { on } from '../events/eventBus'
import { ApiError, errorMessage, isRecord } from '../lib/errors'
import { request } from '../lib/http'
import { BINS, FileSchema, RefineResultSchema, RulesSchema, type Bin, type LumonFile, type Progress, type Rules } from '../lib/schemas'
import { createStore, useStore, type Store } from '../lib/store'
import { intParam } from '../lib/urlState'
import { uuid } from '../lib/time'
import { FloorClient, type ClaimResult, type FloorState } from './floor'
import { Grid, CELL, type GridHandle, type Holder, type ViewRange } from './Grid'
import { GridStore } from './gridStore'
import { findGroup, type Cell, type GroupInfo } from './groups'

const BIN_NAMES: Record<Bin, string> = { WO: 'WO', FC: 'FC', DR: 'DR', MA: 'MA' }
const REASONS: Record<string, string> = {
  BELOW_THRESHOLD: 'Alguna celda no da miedo con las reglas actuales.',
  NOT_CONNECTED: 'Las celdas no forman un solo grupo conexo.',
  INCOMPLETE: 'El grupo está incompleto: faltan celdas.',
  SIZE_OUT_OF_RANGE: 'El grupo es ruido (su tamaño está fuera del rango).',
}

type ClaimState = 'none' | 'pending' | 'granted' | 'denied' | 'unavailable'

interface Notice {
  kind: 'error' | 'info' | 'success' | 'warning'
  text: string
}

export default function RefinePage() {
  const { id } = useParams()
  const fileId = intParam(id ?? null, -1, 1)
  if (fileId < 1) return <NotFound />
  return <RefineLoader key={fileId} fileId={fileId} />
}

function RefineLoader({ fileId }: { fileId: number }) {
  const [file, setFile] = useState<LumonFile | null>(null)
  const [rules, setRules] = useState<Rules | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const ctl = new AbortController()
    setError(null)
    Promise.all([
      request(`/files/${fileId}`, { signal: ctl.signal }, (v) => FileSchema.parse(v)),
      request(`/files/${fileId}/rules`, { signal: ctl.signal }, (v) => RulesSchema.parse(v)),
    ])
      .then(([f, r]) => {
        setFile(f.data)
        setRules(r.data)
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e)
      })
    return () => ctl.abort()
  }, [fileId, nonce])

  if (error instanceof ApiError && error.status === 404) return <NotFound />
  if (error)
    return (
      <Alert>
        No se pudo abrir el archivo: {errorMessage(error)}{' '}
        <Button variant="ghost" onClick={() => setNonce((n) => n + 1)}>
          Reintentar
        </Button>
      </Alert>
    )
  if (!file || !rules) return <Spinner label="Abriendo el archivo…" />
  return <Refiner file={file} rules={rules} />
}

function Refiner({ file, rules }: { file: LumonFile; rules: Rules }) {
  const me = useMe()
  const canRefine = hasPermission(me, 'files:refine')
  const [sp, setSp] = useSearchParams()
  const initial = useMemo<Cell>(
    () => ({ r: intParam(sp.get('r'), 0, 0, file.rows - 1), c: intParam(sp.get('c'), 0, 0, file.cols - 1) }),
    // Solo al abrir: la URL se actualiza luego con el scroll (sin llenar el historial).
    [],
  )
  const store = useMemo(() => new GridStore(file.id, file.rows, file.cols, file.tileSize), [file.id, file.rows, file.cols, file.tileSize])
  useEffect(() => {
    store.revive()
    return () => store.dispose()
  }, [store])

  const floor = useMemo(() => (me ? new FloorClient(file.id, me.id) : null), [file.id, me?.id])
  useEffect(() => {
    if (!floor) return
    floor.start()
    return () => floor.stop()
  }, [floor])

  const viewStore = useMemo(() => createStore<ViewRange>({ r0: 0, r1: 0, c0: 0, c1: 0 }), [])
  const gridRef = useRef<GridHandle>(null)
  const [focus, setFocus] = useState<Cell>(initial)
  const [group, setGroup] = useState<GroupInfo | null>(null)
  const [finding, setFinding] = useState(false)
  const [claimState, setClaimState] = useState<ClaimState>('none')
  const claimPromise = useRef<Promise<ClaimResult> | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [progress, setProgress] = useState<Progress>(file.progress)
  const [stats, setStats] = useState({ refinedGroups: file.refinedGroups, totalGroups: file.totalGroups, mistakes: file.mistakes })
  const [completed, setCompleted] = useState(file.status === 'COMPLETE' || file.progress.overall >= 1)
  const [showGrid, setShowGrid] = useState(!completed)
  const [refining, setRefining] = useState<Bin | null>(null)
  const refiningRef = useRef(false)
  const intents = useRef(new Map<string, string>())
  const findCtl = useRef<AbortController | null>(null)
  const seenRefinements = useRef(new Set<number>())
  const groupRef = useRef<GroupInfo | null>(null)

  const floorState = useStore(floor?.state ?? EMPTY_FLOOR)
  const claimed = useMemo(() => {
    const m = new Map<number, Holder>()
    for (const cl of floorState.claims) for (const cell of cl.cells) m.set(cell.r * file.cols + cell.c, { displayName: cl.displayName, mine: !!me && cl.userId === me.id })
    return m
  }, [floorState.claims, file.cols, me])

  const heldByOther = useMemo(() => {
    if (!group) return null
    for (const idx of group.indexSet) {
      const h = claimed.get(idx)
      if (h && !h.mine) return h.displayName
    }
    return null
  }, [group, claimed])

  const applyProgress = useCallback((p: Progress) => {
    setProgress((prev) => (p.overall >= prev.overall ? p : prev))
    if (p.overall >= 1) setCompleted(true)
  }, [])

  // URL con la posición (?r=&c=), sin llenar el historial.
  const urlTimer = useRef<number | null>(null)
  const onViewport = useCallback(
    (range: ViewRange, topLeft: Cell) => {
      viewStore.set(range)
      if (urlTimer.current !== null) window.clearTimeout(urlTimer.current)
      urlTimer.current = window.setTimeout(() => {
        setSp(
          (prev) => {
            const n = new URLSearchParams(prev)
            n.set('r', String(topLeft.r))
            n.set('c', String(topLeft.c))
            return n
          },
          { replace: true },
        )
      }, 300)
    },
    [setSp, viewStore],
  )
  useEffect(() => () => {
    if (urlTimer.current !== null) window.clearTimeout(urlTimer.current)
  }, [])

  const clearSelection = useCallback(() => {
    findCtl.current?.abort()
    setGroup(null)
    setClaimState('none')
    claimPromise.current = null
    floor?.release()
  }, [floor])

  const selectAt = useCallback(
    async (cell: Cell) => {
      findCtl.current?.abort()
      const ctl = new AbortController()
      findCtl.current = ctl
      const v = store.cell(cell.r, cell.c)
      if (v && v.tremor < rules.tremorThreshold) {
        if (group) clearSelection()
        setNotice({ kind: 'info', text: `La celda (${cell.r}, ${cell.c}) no da miedo.` })
        return
      }
      setFinding(true)
      try {
        const g = await findGroup(store, rules, cell.r, cell.c, ctl.signal)
        if (ctl.signal.aborted) return
        floor?.release()
        setClaimState('none')
        claimPromise.current = null
        if (!g) {
          setGroup(null)
          setNotice({ kind: 'info', text: `La celda (${cell.r}, ${cell.c}) no da miedo.` })
          return
        }
        setGroup(g)
        if (g.refinedBin) {
          setNotice({ kind: 'info', text: `Este grupo ya está refinado en ${g.refinedBin}.` })
          return
        }
        if (g.noise) {
          setNotice({ kind: 'warning', text: `Ruido: ${g.truncated ? `más de ${rules.maxGroupSize}` : g.size} celdas (rango válido ${rules.minGroupSize}–${rules.maxGroupSize}). No se puede refinar.` })
          return
        }
        setNotice(null)
        if (canRefine && floor) {
          setClaimState('pending')
          const p = floor.claim(g.cells[0] ?? cell)
          claimPromise.current = p
          void p.then((res) => {
            if (claimPromise.current !== p) return
            if (res.kind === 'granted') setClaimState('granted')
            else if (res.kind === 'denied') {
              setClaimState('denied')
              setNotice({
                kind: 'warning',
                text:
                  res.reason === 'HELD'
                    ? `Este grupo lo tiene reservado ${res.holder?.displayName ?? 'otro refinador'}. Elige otro grupo o espera a que lo libere.`
                    : 'El piso dice que esta celda no forma un grupo refinable (ruido o ya refinado).',
              })
            } else setClaimState('unavailable')
          })
        }
      } catch (e) {
        if (!ctl.signal.aborted) setNotice({ kind: 'error', text: `No se pudo cargar el grupo completo: ${errorMessage(e)}` })
      } finally {
        if (findCtl.current === ctl) setFinding(false)
      }
    },
    [store, rules, floor, canRefine, group, clearSelection],
  )

  const refine = useCallback(
    async (bin: Bin) => {
      if (!group || refiningRef.current) return // doble clic / doble Enter
      if (!canRefine) {
        setNotice({ kind: 'error', text: 'Tu rol no tiene el permiso files:refine.' })
        return
      }
      if (group.refinedBin || group.noise) return
      if (heldByOther) {
        setNotice({ kind: 'warning', text: `No se puede: ${heldByOther} tiene este grupo reservado.` })
        return
      }
      refiningRef.current = true
      setRefining(bin)
      try {
        if (claimPromise.current) {
          const res = await claimPromise.current
          if (res.kind === 'denied') {
            setNotice({ kind: 'warning', text: `No se puede: ${res.holder?.displayName ?? 'otro refinador'} tiene este grupo reservado.` })
            return
          }
        }
        // Una key por intención (grupo + caja): reintentos, doble clic o red caída reutilizan la misma.
        const intent = `${group.id}|${bin}`
        let key = intents.current.get(intent)
        if (!key) {
          key = uuid()
          intents.current.set(intent, key)
        }
        const { data } = await request(
          `/files/${file.id}/refinements`,
          { method: 'POST', body: { bin, cells: group.cells }, headers: { 'Idempotency-Key': key }, retries: 6, retryNetwork: true },
          (v) => RefineResultSchema.parse(v),
        )
        seenRefinements.current.add(data.refinementId)
        store.applyRefinement(group.cells, bin)
        applyProgress(data.file.progress)
        setStats({ refinedGroups: data.file.refinedGroups, totalGroups: data.file.totalGroups, mistakes: data.file.mistakes })
        if (data.file.status === 'COMPLETE') setCompleted(true)
        setNotice({ kind: 'success', text: `Grupo de ${data.size} celdas refinado en ${bin}.` })
        setGroup(null)
        setClaimState('none')
        claimPromise.current = null
        floor?.release()
      } catch (e) {
        handleRefineError(e, bin)
      } finally {
        refiningRef.current = false
        setRefining(null)
      }
    },
    [group, canRefine, heldByOther, file.id, store, floor, applyProgress],
  )

  function handleRefineError(e: unknown, bin: Bin) {
    if (!(e instanceof ApiError)) {
      setNotice({ kind: 'error', text: `No se pudo refinar: ${errorMessage(e)} Puedes reintentar: no se refinará dos veces.` })
      return
    }
    const d = isRecord(e.details) ? e.details : {}
    switch (e.code) {
      case 'WRONG_BIN':
        setStats((s) => ({ ...s, mistakes: typeof d.mistakes === 'number' ? d.mistakes : s.mistakes + 1 }))
        setNotice({
          kind: 'error',
          text: `Caja equivocada: el grupo no va en ${bin}.${group?.expectedBin ? ` Según las reglas corresponde a ${group.expectedBin}.` : ''} Lumon lo anotó como error.`,
        })
        break
      case 'GROUP_INVALID': {
        const reason = typeof d.reason === 'string' ? d.reason : ''
        const missing = typeof d.missing === 'number' ? ` (faltan ${d.missing})` : ''
        setNotice({ kind: 'error', text: `Grupo no válido: ${REASONS[reason] ?? e.message}${missing} Vuelve a seleccionar el grupo.` })
        store.invalidate(group ? [...new Set(group.cells.map((c) => store.tileOf(c.r, c.c)))] : undefined)
        clearSelection()
        break
      }
      case 'ALREADY_REFINED': {
        const tiles = Array.isArray(d.tiles) ? d.tiles : []
        const keys = tiles
          .filter((t): t is [number, number] => Array.isArray(t) && typeof t[0] === 'number' && typeof t[1] === 'number')
          .map(([tr, tc]) => store.key(tr, tc))
        store.invalidate(keys.length ? keys : undefined)
        setNotice({ kind: 'warning', text: 'Alguien ya refinó parte de este grupo. Se actualizaron los bloques afectados: elige otro grupo.' })
        clearSelection()
        break
      }
      case 'GROUP_CLAIMED': {
        const h = isRecord(d.holder) && typeof d.holder.displayName === 'string' ? d.holder.displayName : 'otro refinador'
        setNotice({ kind: 'warning', text: `${h} tiene este grupo reservado. Espera a que lo libere o elige otro.` })
        break
      }
      default:
        setNotice({ kind: 'error', text: `No se pudo refinar: ${errorMessage(e)} Puedes reintentar sin riesgo de duplicar.` })
    }
  }

  // Eventos en vivo: refinamientos de otros, archivo completado, reset del stream.
  useEffect(() => {
    const offs = [
      on('refinement.created', (ev) => {
        const d = ev.data as { fileId?: number; cells?: Cell[]; bin?: Bin; progress?: Progress } | null
        if (!d || d.fileId !== file.id || !Array.isArray(d.cells) || !d.bin || !BINS.includes(d.bin)) return
        store.applyRefinement(d.cells, d.bin)
        if (d.progress) applyProgress(d.progress)
        const rid = (ev.data as { refinementId?: number }).refinementId
        if (typeof rid === 'number' && !seenRefinements.current.has(rid)) {
          seenRefinements.current.add(rid)
          setStats((s) => ({ ...s, refinedGroups: Math.min(s.totalGroups, s.refinedGroups + 1) }))
        }
        const g = groupRef.current
        if (g && !g.refinedBin && d.cells.some((c) => g.indexSet.has(c.r * file.cols + c.c))) {
          setNotice({ kind: 'info', text: 'Otro refinador acaba de refinar el grupo seleccionado.' })
          floor?.release()
          setGroup(null)
          setClaimState('none')
        }
      }),
      on('file.completed', (ev) => {
        const d = ev.data as { fileId?: number } | null
        if (d?.fileId === file.id) setCompleted(true)
      }),
      on('stream.reset', () => {
        store.invalidate()
        void request(`/files/${file.id}`, {}, (v) => FileSchema.parse(v))
          .then(({ data }) => {
            applyProgress(data.progress)
            setStats({ refinedGroups: data.refinedGroups, totalGroups: data.totalGroups, mistakes: data.mistakes })
          })
          .catch(() => undefined)
      }),
    ]
    return () => offs.forEach((o) => o())
  }, [file.id, file.cols, store, floor, applyProgress])

  // ---- Arrastre con Pointer Events ----
  const ghostRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [dragOver, setDragOver] = useState<Bin | null>(null)
  const dragRef = useRef<{ x: number; y: number; active: boolean; over: Bin | null } | null>(null)
  const refineRef = useRef(refine)
  refineRef.current = refine

  const startDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const target = e.currentTarget
    try {
      target.setPointerCapture(e.pointerId)
    } catch {
      /* sin captura */
    }
    dragRef.current = { x: e.clientX, y: e.clientY, active: false, over: null }
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (!d.active && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6) {
        d.active = true
        setDragging(true)
      }
      if (!d.active) return
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const binEl = el instanceof Element ? el.closest<HTMLElement>('[data-bin-target]') : null
      const over = (binEl?.dataset.binTarget as Bin | undefined) ?? null
      if (over !== d.over) {
        d.over = over
        setDragOver(over)
      }
    }
    const end = (ev: PointerEvent) => {
      const d = dragRef.current
      dragRef.current = null
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      setDragging(false)
      setDragOver(null)
      if (d?.active && d.over && ev.type === 'pointerup') void refineRef.current(d.over)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }, [])

  groupRef.current = group
  const onCellPointerDown = useCallback(
    (cell: Cell, e: React.PointerEvent<HTMLDivElement>) => {
      const g = groupRef.current
      const idx = cell.r * file.cols + cell.c
      if (g && g.indexSet.has(idx)) {
        if (!g.noise && !g.refinedBin) startDrag(e)
        return
      }
      void selectAt(cell)
    },
    [file.cols, selectAt, startDrag],
  )

  const onActivate = useCallback((cell: Cell) => void selectAt(cell), [selectAt])
  const onBinKey = useCallback((bin: Bin) => void refineRef.current(bin), [])
  const onHover = useCallback((cell: Cell) => floor?.moveCursor(cell), [floor])
  const onFocusChange = useCallback(
    (cell: Cell) => {
      setFocus(cell)
      floor?.moveCursor(cell)
    },
    [floor],
  )
  const overlay = useMemo(() => (floor ? <CursorLayer floor={floor} /> : null), [floor])
  const selectionSet = group?.indexSet ?? null

  if (completed && !showGrid) {
    return (
      <section className="mx-auto max-w-xl py-12 text-center" aria-live="polite">
        <p className="font-mono text-sm tracking-widest text-cyan-200">ARCHIVO COMPLETADO</p>
        <h1 className="mt-2 mb-4 text-3xl font-bold">{file.name} está refinado al 100 %</h1>
        <p className="mb-2 text-slate-200">
          Grupos refinados: {stats.refinedGroups}/{stats.totalGroups} · Errores de refinamiento: {stats.mistakes}
        </p>
        <p className="mb-6 text-slate-300">El trabajo es misterioso e importante.</p>
        <div className="flex justify-center gap-3">
          <Link to="/files" className="rounded-md bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950">
            Volver a los archivos
          </Link>
          <Button variant="secondary" onClick={() => setShowGrid(true)}>
            Ver la grilla
          </Button>
        </div>
      </section>
    )
  }

  const blockedBins = !group || !!group.refinedBin || group.noise || !!heldByOther || !canRefine || claimState === 'denied'

  return (
    <>
      <PageTitle actions={<Link to="/files" className="text-sm text-cyan-200 underline">Volver a archivos</Link>}>
        {file.name} <span className="font-mono text-base font-normal text-slate-300">{file.rows}×{file.cols}</span>
      </PageTitle>
      {completed && (
        <div className="mb-3">
          <Alert kind="success">Archivo completado al 100 %.</Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0">
          <GridStatus store={store} floorStatus={floorState.status} floorDetail={floorState.detail} focus={focus} />
          <Grid
            ref={gridRef}
            store={store}
            rules={rules}
            focus={focus}
            selection={selectionSet}
            claimed={claimed}
            initial={initial}
            label={`Grilla de ${file.name}. Flechas para moverse, Enter para seleccionar un grupo, 1 a 4 para llevarlo a WO, FC, DR o MA, Escape para cancelar.`}
            onFocusChange={onFocusChange}
            onActivate={onActivate}
            onBinKey={onBinKey}
            onEscape={clearSelection}
            onViewport={onViewport}
            onCellPointerDown={onCellPointerDown}
            onHover={onHover}
            overlay={overlay}
          />
          <p className="mt-2 text-xs text-slate-300">
            Umbral {rules.tremorThreshold} · conectividad {rules.connectivity} · grupos de {rules.minGroupSize} a {rules.maxGroupSize} ·{' '}
            {rules.binning.strategy === 'DIGIT_SUM_MOD' ? 'suma de dígitos' : 'dígito máximo'} % 4 → {rules.binning.order.join(', ')}
          </p>
        </div>

        <aside className="flex flex-col gap-4" aria-label="Panel de refinamiento">
          <section aria-labelledby="sel-title" className="rounded-lg border border-slate-700 bg-slate-900 p-3">
            <h2 id="sel-title" className="mb-2 font-semibold">
              Grupo seleccionado
            </h2>
            <div aria-live="polite">
              {finding && <Spinner small label="Buscando el grupo completo…" />}
              {!finding && !group && <p className="text-sm text-slate-300">Elige una celda que dé miedo (clic o Enter).</p>}
              {!finding && group && (
                <div className="text-sm">
                  <p>
                    Tamaño: <strong>{group.truncated ? `> ${rules.maxGroupSize}` : group.size}</strong> celdas
                  </p>
                  <p>
                    {group.refinedBin ? (
                      <>Ya refinado en <strong>{group.refinedBin}</strong></>
                    ) : group.noise ? (
                      <strong className="text-amber-200">Ruido: no se puede refinar</strong>
                    ) : (
                      <>
                        Caja según las reglas: <strong className="text-cyan-200">{group.expectedBin}</strong>
                      </>
                    )}
                  </p>
                  {heldByOther && <p className="text-pink-200">Reservado por {heldByOther}</p>}
                  {!group.noise && !group.refinedBin && !heldByOther && (
                    <p className="text-slate-300">
                      Reserva: {claimState === 'granted' ? 'tuya' : claimState === 'pending' ? 'pidiendo…' : claimState === 'denied' ? 'rechazada' : 'sin piso compartido'}
                    </p>
                  )}
                  {!group.noise && !group.refinedBin && canRefine && !heldByOther && (
                    <button
                      type="button"
                      onPointerDown={startDrag}
                      className="mt-2 w-full cursor-grab touch-none rounded border border-dashed border-cyan-300 px-2 py-2 text-cyan-100 active:cursor-grabbing"
                    >
                      Arrastra este grupo ({group.size}) a una caja
                    </button>
                  )}
                  <Button variant="ghost" className="mt-2" onClick={clearSelection}>
                    Cancelar selección
                  </Button>
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby="bins-title" className="rounded-lg border border-slate-700 bg-slate-900 p-3">
            <h2 id="bins-title" className="mb-2 font-semibold">
              Cajas
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {BINS.map((b, i) => (
                <button
                  key={b}
                  type="button"
                  data-bin-target={b}
                  disabled={blockedBins || refining !== null}
                  aria-keyshortcuts={String(i + 1)}
                  onClick={() => void refine(b)}
                  className={`rounded-md border p-2 text-left transition-colors disabled:cursor-not-allowed ${
                    dragOver === b ? 'border-cyan-200 bg-cyan-900' : 'border-slate-600 bg-slate-950 hover:bg-slate-800'
                  } ${blockedBins ? 'opacity-80' : ''}`}
                >
                  <span className="flex items-center justify-between font-mono text-lg font-bold">
                    {BIN_NAMES[b]}
                    {refining === b && <Spinner small />}
                  </span>
                  <ProgressBar value={progress[b]} label={`Caja ${b}`} />
                  <span className="text-xs text-slate-300">Tecla {i + 1}</span>
                </button>
              ))}
            </div>
            <ProgressBar className="mt-3" value={progress.overall} label="Progreso total" />
            <p className="mt-2 text-xs text-slate-300">
              Grupos {stats.refinedGroups}/{stats.totalGroups} · errores {stats.mistakes}
            </p>
          </section>

          {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

          {floor && <MembersPanel floor={floor} viewStore={viewStore} myId={me?.id ?? -1} onGo={(c) => gridRef.current?.scrollToCell(c.r, c.c, 'center')} />}
        </aside>
      </div>
      <div
        ref={ghostRef}
        aria-hidden="true"
        className={`pointer-events-none fixed top-0 left-0 z-40 rounded bg-cyan-300 px-2 py-1 text-sm font-bold text-slate-950 shadow-lg ${dragging ? '' : 'hidden'}`}
      >
        {group?.size ?? 0} celdas → {dragOver ?? '¿caja?'}
      </div>
    </>
  )
}

const EMPTY_FLOOR = createStore<FloorState>({ status: 'closed', detail: null, members: [], claims: [], myClaimId: null })

function GridStatus({ store, floorStatus, floorDetail, focus }: { store: GridStore; floorStatus: string; floorDetail: string | null; focus: Cell }) {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const limited = store.rateLimitedUntil > now
  const floorLabel: Record<string, string> = {
    connecting: 'conectando…',
    open: 'conectado',
    reconnecting: 'reconectando…',
    failed: 'no disponible',
    closed: 'cerrado',
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-200">
      <span>
        Celda ({focus.r}, {focus.c})
      </span>
      <span>
        Bloques en caché: {store.loadedCount()} / {store.tileRows * store.tileCols} · en vuelo: {store.inflightCount()}
      </span>
      {limited && <span className="text-amber-200" role="status">Límite de bloques: esperando {Math.ceil((store.rateLimitedUntil - now) / 1000)} s</span>}
      <span role="status" aria-live="polite">
        <span
          aria-hidden="true"
          className={`mr-1 inline-block h-2 w-2 rounded-full ${floorStatus === 'open' ? 'bg-emerald-400' : floorStatus === 'failed' ? 'bg-rose-400' : 'bg-amber-400'}`}
        />
        Piso compartido: {floorLabel[floorStatus] ?? floorStatus}
        {floorDetail ? ` — ${floorDetail}` : ''}
        {floorStatus === 'failed' ? ' (puedes seguir refinando)' : ''}
      </span>
    </div>
  )
}

const COLORS = ['#f472b6', '#a78bfa', '#34d399', '#fbbf24', '#60a5fa', '#fb7185']
function colorFor(userId: number) {
  return COLORS[Math.abs(userId) % COLORS.length] ?? '#f472b6'
}

/** Cursores de los demás sobre la grilla. Se renderiza aparte: un cursor que llega no re-renderiza la grilla. */
function CursorLayer({ floor }: { floor: FloorClient }) {
  const cursors = useStore(floor.cursors)
  const members = useStore(floor.state, (s) => s.members)
  return (
    <>
      {[...cursors.entries()].map(([userId, pos]) => {
        const name = members.find((m) => m.userId === userId)?.displayName ?? `Usuario ${userId}`
        return (
          <div
            key={userId}
            aria-hidden="true"
            className="mdr-cursor"
            style={{ transform: `translate(${pos.c * CELL}px, ${pos.r * CELL}px)`, ['--cc' as string]: colorFor(userId) }}
          >
            <span>{name}</span>
          </div>
        )
      })}
    </>
  )
}

function MembersPanel({
  floor,
  viewStore,
  myId,
  onGo,
}: {
  floor: FloorClient
  viewStore: Store<ViewRange>
  myId: number
  onGo: (c: Cell) => void
}) {
  const members = useStore(floor.state, (s) => s.members)
  const cursors = useStore(floor.cursors)
  const view = useStore(viewStore)
  return (
    <section aria-labelledby="members-title" className="rounded-lg border border-slate-700 bg-slate-900 p-3">
      <h2 id="members-title" className="mb-2 font-semibold">
        En el piso ({members.length})
      </h2>
      {members.length === 0 && <p className="text-sm text-slate-300">Nadie conectado.</p>}
      <ul className="flex flex-col gap-1 text-sm">
        {members.map((m) => {
          const pos = cursors.get(m.userId)
          const inView = pos ? pos.r >= view.r0 && pos.r <= view.r1 && pos.c >= view.c0 && pos.c <= view.c1 : false
          return (
            <li key={m.userId} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorFor(m.userId) }} />
                {m.displayName}
                {m.userId === myId && <span className="text-slate-300">(tú)</span>}
              </span>
              {m.userId !== myId && pos && !inView && (
                <button type="button" className="text-xs text-cyan-200 underline" onClick={() => onGo(pos)}>
                  Fuera de vista · ir a ({pos.r}, {pos.c})
                </button>
              )}
              {m.userId !== myId && pos && inView && <span className="text-xs text-slate-300">en vista</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
