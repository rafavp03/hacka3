import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Pagination } from '../components/Pagination'
import { Alert, Button, Field, PageTitle, ProgressBar, Select, Spinner } from '../components/ui'
import { on } from '../events/eventBus'
import { errorMessage } from '../lib/errors'
import { qs, request } from '../lib/http'
import { FilePageSchema, type LumonFile, type Page, type Progress } from '../lib/schemas'
import { enumParam, intParam, sameParams, textParam } from '../lib/urlState'
import { useDebounced, useQuery } from '../lib/useQuery'
import { formatDate } from '../lib/time'

const SIZES = ['10', '25', '50'] as const
const STATUSES = ['', 'ACTIVE', 'COMPLETE'] as const
const SORTS = ['updatedAt,desc', 'progress,desc', 'name,asc'] as const

interface FileQuery {
  page: number
  size: (typeof SIZES)[number]
  status: (typeof STATUSES)[number]
  q: string
  sort: (typeof SORTS)[number]
}

function parse(sp: URLSearchParams): FileQuery {
  return {
    page: intParam(sp.get('page'), 0, 0, 100_000),
    size: enumParam(sp.get('size'), SIZES, '10'),
    status: enumParam(sp.get('status'), STATUSES, ''),
    q: textParam(sp.get('q'), 60),
    sort: enumParam(sp.get('sort'), SORTS, 'updatedAt,desc'),
  }
}

function serialize(q: FileQuery): URLSearchParams {
  const sp = new URLSearchParams()
  if (q.page !== 0) sp.set('page', String(q.page))
  if (q.size !== '10') sp.set('size', q.size)
  if (q.status) sp.set('status', q.status)
  if (q.q) sp.set('q', q.q)
  if (q.sort !== 'updatedAt,desc') sp.set('sort', q.sort)
  return sp
}

export default function FilesPage() {
  const [sp, setSp] = useSearchParams()
  const query = useMemo(() => parse(sp), [sp])
  const canonical = useMemo(() => serialize(query), [query])

  // Una URL inválida se corrige sin romper la vista (y sin ensuciar el historial).
  useEffect(() => {
    if (!sameParams(sp, canonical)) setSp(canonical, { replace: true })
  }, [sp, canonical, setSp])

  const update = (patch: Partial<FileQuery>, replace = false) => {
    const next = { ...query, ...patch }
    if (!('page' in patch)) next.page = 0
    setSp(serialize(next), { replace })
  }

  // Búsqueda sin una request por tecla: el texto se lleva a la URL con debounce.
  const [text, setText] = useState(query.q)
  useEffect(() => setText(query.q), [query.q])
  const debounced = useDebounced(text, 400)
  useEffect(() => {
    if (debounced.slice(0, 60) !== query.q) update({ q: debounced.slice(0, 60) }, true)
  }, [debounced])

  const key = canonical.toString() + `|${query.page}|${query.size}`
  const files = useQuery<Page<LumonFile>>(key, async (signal) => {
    const { data } = await request(
      `/files${qs({ page: query.page, size: query.size, status: query.status, q: query.q, sort: query.sort })}`,
      { signal },
      (v) => FilePageSchema.parse(v),
    )
    return data
  })

  // Progreso en vivo desde el stream.
  useEffect(
    () =>
      on(['refinement.created', 'file.completed'], (ev) => {
        const d = ev.data as { fileId?: number; progress?: Progress } | null
        if (!d || typeof d.fileId !== 'number') return
        files.setData((prev) =>
          prev
            ? {
                ...prev,
                content: prev.content.map((f) =>
                  f.id !== d.fileId
                    ? f
                    : ev.type === 'file.completed'
                      ? { ...f, status: 'COMPLETE' as const }
                      : d.progress
                        ? { ...f, progress: d.progress, refinedGroups: f.refinedGroups + 1 }
                        : f,
                ),
              }
            : prev,
        )
      }),
    [files.setData],
  )

  const data = files.data
  return (
    <>
      <PageTitle>Archivos de datos</PageTitle>
      <form role="search" className="mb-4 grid gap-3 sm:grid-cols-4" onSubmit={(e) => e.preventDefault()}>
        <Field label="Buscar por nombre" type="search" value={text} maxLength={60} onChange={(e) => setText(e.target.value)} />
        <Select label="Estado" value={query.status} onChange={(e) => update({ status: e.target.value as FileQuery['status'] })}>
          <option value="">Todos</option>
          <option value="ACTIVE">Activos</option>
          <option value="COMPLETE">Completados</option>
        </Select>
        <Select label="Orden" value={query.sort} onChange={(e) => update({ sort: e.target.value as FileQuery['sort'] })}>
          <option value="updatedAt,desc">Actualizados recientemente</option>
          <option value="progress,desc">Mayor progreso</option>
          <option value="name,asc">Nombre (A-Z)</option>
        </Select>
        <Select label="Por página" value={query.size} onChange={(e) => update({ size: e.target.value as FileQuery['size'] })}>
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </form>

      {files.error !== null && (
        <Alert>
          {errorMessage(files.error)}{' '}
          <Button variant="ghost" onClick={files.reload}>
            Reintentar
          </Button>
        </Alert>
      )}
      <div className="relative" aria-busy={files.loading}>
        {files.loading && (
          <div className="mb-2 text-sm text-slate-200">
            <Spinner small label="Cargando archivos…" />
          </div>
        )}
        {data && data.content.length === 0 && !files.loading && <p className="text-slate-200">No hay archivos con esos filtros.</p>}
        {data && data.content.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">Archivos de datos</caption>
              <thead className="border-b border-slate-600 text-slate-200">
                <tr>
                  <th scope="col" className="py-2 pr-3">Nombre</th>
                  <th scope="col" className="py-2 pr-3">Estado</th>
                  <th scope="col" className="py-2 pr-3">Tamaño</th>
                  <th scope="col" className="w-48 py-2 pr-3">Progreso</th>
                  <th scope="col" className="py-2 pr-3">Grupos</th>
                  <th scope="col" className="py-2 pr-3">Errores</th>
                  <th scope="col" className="py-2 pr-3">Actualizado</th>
                  <th scope="col" className="py-2"><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody className={files.loading ? 'opacity-60' : ''}>
                {data.content.map((f) => (
                  <tr key={f.id} className="border-b border-slate-800">
                    <td className="py-2 pr-3 font-medium">{f.name}</td>
                    <td className="py-2 pr-3">{f.status === 'COMPLETE' ? 'Completado' : 'Activo'}</td>
                    <td className="py-2 pr-3 font-mono">
                      {f.rows}×{f.cols}
                    </td>
                    <td className="py-2 pr-3">
                      <ProgressBar value={f.progress.overall} label={`Progreso de ${f.name}`} />
                    </td>
                    <td className="py-2 pr-3">
                      {f.refinedGroups}/{f.totalGroups}
                    </td>
                    <td className="py-2 pr-3">{f.mistakes}</td>
                    <td className="py-2 pr-3">{formatDate(f.updatedAt)}</td>
                    <td className="py-2">
                      <Link to={`/files/${f.id}/refine`} className="text-cyan-200 underline">
                        Refinar<span className="sr-only"> {f.name}</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pagination page={data.page} totalPages={data.totalPages} totalElements={data.totalElements} onPage={(p) => update({ page: p })} />}
      </div>
    </>
  )
}
