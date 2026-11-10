import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { NotFound } from '../components/ErrorPages'
import { Alert, Button, PageTitle, Spinner } from '../components/ui'
import { ApiError, errorMessage } from '../lib/errors'
import { createStore, useStore } from '../lib/store'
import { intParam } from '../lib/urlState'
import { conflictFrom, getRefiner, patchRefiner, type VersionedRefiner } from '../refiners/api'
import { useRefiner } from '../refiners/refinerStore'
import { Badge } from '../refiners/RefinersPage'
import { BADGE_MAX_BYTES, loadBitmap, makeBadge, WebpUnsupportedError, type PreparedImage } from './image'
import { ImagePicker } from './ImagePicker'
import { UploadJob, type UploadState } from './upload'
import { UploadProgress } from './UploadProgress'

const VIEW = 320

export default function BadgeEditorPage() {
  const { id } = useParams()
  const refinerId = intParam(id ?? null, -1, 1)
  if (refinerId < 1) return <NotFound />
  return <BadgeEditor key={refinerId} id={refinerId} />
}

interface Source {
  bitmap: ImageBitmap
  url: string
}

function BadgeEditor({ id }: { id: number }) {
  const [base, setBase] = useState<VersionedRefiner | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [source, setSource] = useState<Source | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [prepared, setPrepared] = useState<PreparedImage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [job, setJob] = useState<UploadJob | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<VersionedRefiner | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const ctl = new AbortController()
    getRefiner(id, ctl.signal)
      .then(setBase)
      .catch((e: unknown) => !ctl.signal.aborted && setLoadError(e))
    return () => ctl.abort()
  }, [id])

  useEffect(() => () => {
    if (source) URL.revokeObjectURL(source.url)
  }, [source])

  const minZoom = source ? VIEW / Math.min(source.bitmap.width, source.bitmap.height) : 1
  const clampOffset = useCallback(
    (x: number, y: number, z: number) => {
      if (!source) return { x: 0, y: 0 }
      const w = source.bitmap.width * z
      const h = source.bitmap.height * z
      return { x: Math.min(0, Math.max(VIEW - w, x)), y: Math.min(0, Math.max(VIEW - h, y)) }
    },
    [source],
  )

  const pick = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    setError(null)
    setPrepared(null)
    setJob(null)
    setDone(false)
    try {
      const bitmap = await loadBitmap(f)
      const z = VIEW / Math.min(bitmap.width, bitmap.height)
      setSource({ bitmap, url: URL.createObjectURL(f) })
      setZoom(z)
      setOffset({ x: (VIEW - bitmap.width * z) / 2, y: (VIEW - bitmap.height * z) / 2 })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const setZoomAround = (nz: number) => {
    if (!source) return
    const z = Math.max(minZoom, Math.min(minZoom * 6, nz))
    // Zoom centrado en el centro del recorte.
    const cx = (VIEW / 2 - offset.x) / zoom
    const cy = (VIEW / 2 - offset.y) / zoom
    setZoom(z)
    setOffset(clampOffset(VIEW / 2 - cx * z, VIEW / 2 - cy * z, z))
    setPrepared(null)
  }

  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const generate = async () => {
    if (!source) return
    setProcessing(true)
    setError(null)
    try {
      const crop = { sx: -offset.x / zoom, sy: -offset.y / zoom, size: VIEW / zoom }
      const img = await makeBadge(source.bitmap, crop)
      setPrepared(img)
      const j = new UploadJob(img)
      setJob(j)
      j.start()
    } catch (e) {
      setError(e instanceof WebpUnsupportedError ? e.message : errorMessage(e))
    } finally {
      setProcessing(false)
    }
  }

  const jobState = useStore(job?.state ?? NO_JOB)
  const mediaId = jobState.media?.mediaId ?? null

  const applyBadge = useCallback(
    async (target: VersionedRefiner) => {
      if (mediaId === null) return
      setSaving(true)
      setError(null)
      try {
        const saved = await patchRefiner(id, target.etag, { badgeMediaId: mediaId })
        setBase(saved)
        setConflict(null)
        setDone(true)
      } catch (e) {
        const c = conflictFrom(e)
        if (c) setConflict(c)
        else setError(e instanceof ApiError && e.code === 'MEDIA_NOT_USABLE' ? 'Esa imagen ya no se puede usar: súbela de nuevo.' : errorMessage(e))
      } finally {
        setSaving(false)
      }
    },
    [id, mediaId],
  )

  // Al confirmar la imagen, se actualiza el expediente con If-Match.
  const appliedFor = useRef<number | null>(null)
  useEffect(() => {
    if (mediaId !== null && base && appliedFor.current !== mediaId) {
      appliedFor.current = mediaId
      void applyBadge(base)
    }
  }, [mediaId, base, applyBadge])

  // El expediente se muestra en su última versión conocida (stream o HTTP).
  const live = useRefiner(id)

  const imgStyle = useMemo(
    () =>
      source
        ? { width: source.bitmap.width * zoom, height: source.bitmap.height * zoom, transform: `translate(${offset.x}px, ${offset.y}px)`, maxWidth: 'none' }
        : undefined,
    [source, zoom, offset],
  )

  if (loadError instanceof ApiError && loadError.status === 404) return <NotFound />
  if (loadError) return <Alert>{errorMessage(loadError)}</Alert>
  if (!base) return <Spinner label="Cargando expediente…" />

  return (
    <>
      <PageTitle actions={<Link to="/refiners" className="text-sm text-cyan-200 underline">Volver al directorio</Link>}>
        Fotocheck de {base.refiner.fullName}
      </PageTitle>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-4" aria-label="Imagen y recorte">
          <ImagePicker label="Imagen para el fotocheck (se recorta en cuadrado)" onFiles={(f) => void pick(f)} disabled={processing} />
          {source && (
            <>
              <div
                role="group"
                tabIndex={0}
                aria-label="Recorte cuadrado. Arrastra o usa las flechas para mover; + y - para el zoom."
                className="relative touch-none overflow-hidden rounded-md border-2 border-cyan-300 bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                style={{ width: VIEW, height: VIEW, cursor: 'grab' }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId)
                  drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
                }}
                onPointerMove={(e) => {
                  const d = drag.current
                  if (!d) return
                  setOffset(clampOffset(d.ox + e.clientX - d.x, d.oy + e.clientY - d.y, zoom))
                  setPrepared(null)
                }}
                onPointerUp={() => (drag.current = null)}
                onPointerCancel={() => (drag.current = null)}
                onWheel={(e) => setZoomAround(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 40 : 10
                  const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }
                  const m = moves[e.key]
                  if (m) {
                    e.preventDefault()
                    setOffset(clampOffset(offset.x + m[0], offset.y + m[1], zoom))
                    setPrepared(null)
                  } else if (e.key === '+' || e.key === '=') {
                    e.preventDefault()
                    setZoomAround(zoom * 1.1)
                  } else if (e.key === '-') {
                    e.preventDefault()
                    setZoomAround(zoom / 1.1)
                  }
                }}
              >
                <img src={source.url} alt="Imagen original para recortar" draggable={false} className="pointer-events-none absolute top-0 left-0 select-none" style={imgStyle} />
              </div>
              <label className="flex flex-col gap-1 text-sm">
                Zoom
                <input
                  type="range"
                  min={minZoom}
                  max={minZoom * 6}
                  step={minZoom / 50}
                  value={zoom}
                  onChange={(e) => setZoomAround(Number(e.target.value))}
                  className="w-80"
                />
              </label>
              <Button onClick={() => void generate()} busy={processing} disabled={!!job && jobState.stage !== 'error' && jobState.stage !== 'canceled' && jobState.stage !== 'done'}>
                Generar y subir fotocheck
              </Button>
            </>
          )}
          {error && <Alert>{error}</Alert>}
        </section>

        <section className="flex flex-col gap-4" aria-label="Resultado">
          <div className="flex items-center gap-4">
            <Badge refiner={live && live.version >= base.refiner.version ? live : base.refiner} size={128} />
            <div className="text-sm text-slate-200">
              <p>Fotocheck actual (versión {Math.max(base.refiner.version, live?.version ?? 0)})</p>
              {done && <p className="text-emerald-300" role="status">Fotocheck actualizado.</p>}
            </div>
          </div>
          {prepared && (
            <div className="flex items-center gap-4">
              <img src={prepared.previewUrl} alt="Vista previa del nuevo fotocheck" width={128} height={128} className="rounded-md" />
              <p className="text-xs text-slate-300">
                512 × 512 · WebP · {(prepared.blob.size / 1024).toFixed(1)} KB (máx. {BADGE_MAX_BYTES / 1024} KB) · sin metadatos
                <br />
                SHA-256 <span className="font-mono break-all">{prepared.sha256.slice(0, 16)}…</span>
              </p>
            </div>
          )}
          {job && <UploadProgress job={job} name="el fotocheck" />}
          {saving && <Spinner small label="Actualizando el expediente…" />}
          {conflict && mediaId !== null && (
            <Alert kind="warning" title="El expediente cambió mientras subías el fotocheck">
              <p>
                Ahora está en la versión {conflict.refiner.version} (antes {base.refiner.version}). Lo que hay en el servidor: título «{conflict.refiner.title}», departamento{' '}
                {conflict.refiner.department.name}, fotocheck {conflict.refiner.badge ? 'presente' : 'sin fotocheck'}. Tu cambio: el fotocheck nuevo.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button onClick={() => void applyBadge(conflict)} busy={saving}>
                  Aplicar mi fotocheck sobre la versión {conflict.refiner.version}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setBase(conflict)
                    setConflict(null)
                  }}
                >
                  No aplicar
                </Button>
              </div>
            </Alert>
          )}
        </section>
      </div>
    </>
  )
}

const NO_JOB = createStore<UploadState>({ stage: 'ticket', progress: 0, error: null, media: null })
