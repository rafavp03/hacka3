import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Alert, Button, Field, PageTitle, Select, TextArea } from '../components/ui'
import { ApiError, errorMessage, fieldErrors, isRecord } from '../lib/errors'
import { request } from '../lib/http'
import { IncidentSchema, type Severity } from '../lib/schemas'
import { createStore, useStore } from '../lib/store'
import { loadBitmap, makeIncidentPhoto, WebpUnsupportedError } from './image'
import { ImagePicker } from './ImagePicker'
import { UploadJob, type UploadState } from './upload'
import { UploadProgress } from './UploadProgress'

interface PhotoItem {
  key: string
  name: string
  job: UploadJob | null
  error: string | null
  processing: boolean
}

const MAX_PHOTOS = 3

function PhotoCard({ item, onRemove, onReady }: { item: PhotoItem; onRemove: () => void; onReady: (mediaId: number | null) => void }) {
  const state = useStore(item.job?.state ?? EMPTY)
  const mediaId = state.media?.mediaId ?? null
  useEffect(() => onReady(item.job ? mediaId : null), [mediaId, item.job, onReady])
  return (
    <li className="flex gap-3 rounded-lg border border-slate-700 p-3">
      {item.job ? (
        <img src={item.job.image.previewUrl} alt={`Vista previa de ${item.name}`} width={96} height={96} className="h-24 w-24 rounded object-cover" />
      ) : (
        <div className="h-24 w-24 rounded bg-slate-800" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.name}</p>
        {item.processing && <p className="text-sm text-slate-200">Procesando imagen…</p>}
        {item.error && <p className="text-sm text-rose-300">{item.error}</p>}
        {item.job && (
          <>
            <p className="text-xs text-slate-300">
              {item.job.image.width}×{item.job.image.height} · {(item.job.image.blob.size / 1024).toFixed(0)} KB · WebP sin metadatos
            </p>
            <UploadProgress job={item.job} name={item.name} />
          </>
        )}
        <Button variant="ghost" className="mt-1" onClick={onRemove}>
          Quitar<span className="sr-only"> {item.name}</span>
        </Button>
      </div>
    </li>
  )
}

const EMPTY = createStore<UploadState>({ stage: 'ticket', progress: 0, error: null, media: null })

export default function IncidentNewPage() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('MEDIUM')
  const [fileId, setFileId] = useState('')
  const [photos, setPhotos] = useState<PhotoItem[]>([])
  const [ready, setReady] = useState<Record<string, number | null>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})

  const addFiles = async (files: File[]) => {
    const room = MAX_PHOTOS - photos.length
    if (room <= 0) {
      setError(`Máximo ${MAX_PHOTOS} fotos.`)
      return
    }
    for (const f of files.slice(0, room)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      setPhotos((p) => [...p, { key, name: f.name || 'imagen pegada', job: null, error: null, processing: true }])
      // Cada foto se procesa y sube en paralelo, con su propio progreso.
      void (async () => {
        try {
          const bmp = await loadBitmap(f)
          const img = await makeIncidentPhoto(bmp)
          bmp.close()
          const job = new UploadJob(img)
          setPhotos((p) => p.map((x) => (x.key === key ? { ...x, job, processing: false } : x)))
          job.start()
        } catch (e) {
          const msg = e instanceof WebpUnsupportedError ? e.message : errorMessage(e)
          setPhotos((p) => p.map((x) => (x.key === key ? { ...x, error: msg, processing: false } : x)))
        }
      })()
    }
  }

  const mediaIds = photos.map((p) => ready[p.key]).filter((v): v is number => typeof v === 'number')
  const allConfirmed = photos.length >= 1 && photos.length <= MAX_PHOTOS && mediaIds.length === photos.length

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!allConfirmed) return
    setBusy(true)
    setError(null)
    setFields({})
    try {
      const body = {
        title: title.trim(),
        description: description.trim(),
        severity,
        fileId: fileId.trim() ? Number(fileId) : null,
        mediaIds,
      }
      await request('/incidents', { method: 'POST', body, retries: 3, retryNetwork: false }, (v) => IncidentSchema.parse(v))
      navigate('/incidents')
    } catch (err) {
      // Un error no borra el formulario ni las fotos ya confirmadas.
      setFields(fieldErrors(err))
      if (err instanceof ApiError && err.code === 'MEDIA_NOT_USABLE' && isRecord(err.details)) setError('Alguna foto ya no se puede usar: quítala y súbela de nuevo.')
      else setError(`No se pudo enviar: ${errorMessage(err)} Tus datos y fotos siguen aquí; puedes reintentar.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageTitle actions={<Link to="/incidents" className="text-sm text-cyan-200 underline">Volver a reportes</Link>}>Nuevo reporte de incidencia</PageTitle>
      <form onSubmit={submit} className="grid max-w-3xl gap-4" noValidate>
        <Field label="Título" value={title} minLength={3} maxLength={120} required onChange={(e) => setTitle(e.target.value)} error={fields.title} />
        <TextArea label="Descripción" rows={5} maxLength={4000} required value={description} onChange={(e) => setDescription(e.target.value)} error={fields.description} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Severidad" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} error={fields.severity}>
            <option value="LOW">Baja</option>
            <option value="MEDIUM">Media</option>
            <option value="HIGH">Alta</option>
            <option value="CRITICAL">Crítica</option>
          </Select>
          <Field label="Archivo relacionado (id, opcional)" inputMode="numeric" value={fileId} onChange={(e) => setFileId(e.target.value.replace(/\D/g, ''))} error={fields.fileId} />
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">Fotos (1 a 3)</legend>
          {photos.length < MAX_PHOTOS && <ImagePicker multiple label="Fotos del incidente" onFiles={(f) => void addFiles(f)} />}
          <ul className="flex flex-col gap-2">
            {photos.map((p) => (
              <PhotoCard
                key={p.key}
                item={p}
                onReady={(id) => setReady((r) => (r[p.key] === id ? r : { ...r, [p.key]: id }))}
                onRemove={() => {
                  p.job?.cancel()
                  setPhotos((list) => list.filter((x) => x.key !== p.key))
                  setReady((r) => {
                    const n = { ...r }
                    delete n[p.key]
                    return n
                  })
                }}
              />
            ))}
          </ul>
          {fields.mediaIds && <p className="text-sm text-rose-300">{fields.mediaIds}</p>}
        </fieldset>
        {error && <Alert>{error}</Alert>}
        <div>
          <Button type="submit" busy={busy} disabled={!allConfirmed || title.trim().length < 3 || !description.trim()}>
            Enviar reporte
          </Button>
          {!allConfirmed && <p className="mt-2 text-sm text-slate-300">El reporte se puede enviar cuando todas las fotos estén confirmadas.</p>}
        </div>
      </form>
    </>
  )
}
