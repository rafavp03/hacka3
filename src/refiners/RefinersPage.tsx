import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useCan } from '../auth/authStore'
import { Pagination } from '../components/Pagination'
import { Alert, Button, Field, PageTitle, Select, Spinner } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { qs, request } from '../lib/http'
import { RefinerPageSchema, type Department, type Page, type Refiner } from '../lib/schemas'
import { useStore } from '../lib/store'
import { enumParam, intParam, sameParams, textParam } from '../lib/urlState'
import { useDebounced, useQuery } from '../lib/useQuery'
import { getDepartments, safeHttpUrl } from './api'
import { applyRefiner, refinerStore } from './refinerStore'

const SIZES = ['10', '25', '50'] as const

interface Q {
  page: number
  size: (typeof SIZES)[number]
  departmentId: number | null
  q: string
}

function parse(sp: URLSearchParams): Q {
  const dep = intParam(sp.get('departmentId'), 0, 1)
  return { page: intParam(sp.get('page'), 0, 0, 100_000), size: enumParam(sp.get('size'), SIZES, '10'), departmentId: dep || null, q: textParam(sp.get('q'), 60) }
}
function serialize(q: Q) {
  const sp = new URLSearchParams()
  if (q.page) sp.set('page', String(q.page))
  if (q.size !== '10') sp.set('size', q.size)
  if (q.departmentId) sp.set('departmentId', String(q.departmentId))
  if (q.q) sp.set('q', q.q)
  return sp
}

export function Badge({ refiner, size = 64 }: { refiner: Refiner; size?: number }) {
  const initials = refiner.fullName
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
  const url = safeHttpUrl(refiner.badge?.url)
  return (
    <div className="shrink-0 overflow-hidden rounded-md bg-slate-800" style={{ width: size, height: size }}>
      {url ? (
        <img
          src={url}
          alt={`Fotocheck de ${refiner.fullName}`}
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <div aria-label={`Sin fotocheck: ${refiner.fullName}`} role="img" className="flex h-full w-full items-center justify-center font-mono text-lg text-slate-300">
          {initials || '?'}
        </div>
      )}
    </div>
  )
}

export default function RefinersPage() {
  const [sp, setSp] = useSearchParams()
  const query = useMemo(() => parse(sp), [sp])
  const canonical = useMemo(() => serialize(query), [query])
  useEffect(() => {
    if (!sameParams(sp, canonical)) setSp(canonical, { replace: true })
  }, [sp, canonical, setSp])
  const update = (patch: Partial<Q>, replace = false) => {
    const next = { ...query, ...patch }
    if (!('page' in patch)) next.page = 0
    setSp(serialize(next), { replace })
  }
  const canWrite = useCan('refiners:write')
  const canUpload = useCan('media:upload')

  const [departments, setDepartments] = useState<Department[]>([])
  const [depError, setDepError] = useState<string | null>(null)
  useEffect(() => {
    getDepartments()
      .then(setDepartments)
      .catch((e: unknown) => setDepError(errorMessage(e)))
  }, [])

  const [text, setText] = useState(query.q)
  useEffect(() => setText(query.q), [query.q])
  const debounced = useDebounced(text, 400)
  useEffect(() => {
    if (debounced.slice(0, 60) !== query.q) update({ q: debounced.slice(0, 60) }, true)
  }, [debounced])

  const list = useQuery<Page<Refiner>>(canonical.toString() || 'all', async (signal) => {
    const { data } = await request(
      `/refiners${qs({ page: query.page, size: query.size, departmentId: query.departmentId, q: query.q })}`,
      { signal },
      (v) => RefinerPageSchema.parse(v),
    )
    for (const r of data.content) applyRefiner(r)
    return data
  })
  const latest = useStore(refinerStore)

  return (
    <>
      <PageTitle>Directorio del personal</PageTitle>
      <form role="search" className="mb-4 grid gap-3 sm:grid-cols-3" onSubmit={(e) => e.preventDefault()}>
        <Field label="Buscar (nombre, título, anexo)" type="search" value={text} maxLength={60} onChange={(e) => setText(e.target.value)} />
        <Select
          label="Departamento"
          value={query.departmentId ? String(query.departmentId) : ''}
          onChange={(e) => update({ departmentId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">Todos</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <Select label="Por página" value={query.size} onChange={(e) => update({ size: e.target.value as Q['size'] })}>
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </form>
      {depError && <Alert kind="warning">No se pudieron cargar los departamentos: {depError}</Alert>}
      {list.error !== null && (
        <Alert>
          {errorMessage(list.error)}{' '}
          <Button variant="ghost" onClick={list.reload}>
            Reintentar
          </Button>
        </Alert>
      )}
      {list.loading && <Spinner small label="Cargando expedientes…" />}
      {list.data && list.data.content.length === 0 && !list.loading && <p className="text-slate-200">No hay expedientes con esos filtros.</p>}
      {list.data && (
        <ul className={`grid gap-3 md:grid-cols-2 ${list.loading ? 'opacity-60' : ''}`}>
          {list.data.content.map((item) => {
            const r = latest.get(item.id) ?? item
            const profile = safeHttpUrl(r.profileUrl)
            return (
              <li key={r.id} className="flex gap-3 rounded-lg border border-slate-700 bg-slate-900 p-3">
                <Badge refiner={r} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-semibold">{r.fullName}</h2>
                  <p className="text-sm break-words text-slate-200">{r.title}</p>
                  <p className="text-xs text-slate-300">
                    {r.department.name} · anexo {r.extension} · v{r.version}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm break-words whitespace-pre-wrap text-slate-300">{r.bio}</p>
                  <div className="mt-2 flex flex-wrap gap-3 text-sm">
                    {canWrite && (
                      <Link to={`/refiners/${r.id}/edit`} className="text-cyan-200 underline">
                        Editar<span className="sr-only"> {r.fullName}</span>
                      </Link>
                    )}
                    {canWrite && canUpload && (
                      <Link to={`/refiners/${r.id}/badge`} className="text-cyan-200 underline">
                        Fotocheck<span className="sr-only"> de {r.fullName}</span>
                      </Link>
                    )}
                    {profile && (
                      <a href={profile} target="_blank" rel="noopener noreferrer nofollow" className="text-cyan-200 underline">
                        Perfil externo<span className="sr-only"> de {r.fullName}</span>
                      </a>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {list.data && <Pagination page={list.data.page} totalPages={list.data.totalPages} totalElements={list.data.totalElements} onPage={(p) => update({ page: p })} />}
    </>
  )
}
