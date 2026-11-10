import { Link, useSearchParams } from 'react-router'
import { useCan } from '../auth/authStore'
import { Pagination } from '../components/Pagination'
import { Alert, Button, PageTitle, Spinner } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { qs, request } from '../lib/http'
import { IncidentPageSchema, type Incident, type Page } from '../lib/schemas'
import { formatDate } from '../lib/time'
import { enumParam, intParam } from '../lib/urlState'
import { useQuery } from '../lib/useQuery'
import { safeHttpUrl } from '../refiners/api'

const SEVERITY: Record<string, string> = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' }

export default function IncidentsPage() {
  const [sp, setSp] = useSearchParams()
  const page = intParam(sp.get('page'), 0, 0, 100_000)
  const size = enumParam(sp.get('size'), ['10', '25', '50'] as const, '10')
  const canCreate = useCan('incidents:create')
  const list = useQuery<Page<Incident>>(`${page}|${size}`, async (signal) => {
    const { data } = await request(`/incidents${qs({ page, size })}`, { signal }, (v) => IncidentPageSchema.parse(v))
    return data
  })
  return (
    <>
      <PageTitle
        actions={
          canCreate && (
            <Link to="/incidents/new" className="rounded-md bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950">
              Nuevo reporte
            </Link>
          )
        }
      >
        Reportes de incidencia
      </PageTitle>
      {list.error !== null && (
        <Alert>
          {errorMessage(list.error)}{' '}
          <Button variant="ghost" onClick={list.reload}>
            Reintentar
          </Button>
        </Alert>
      )}
      {list.loading && <Spinner small label="Cargando reportes…" />}
      {list.data && list.data.content.length === 0 && <p className="text-slate-200">Todavía no hay reportes.</p>}
      <ul className="flex flex-col gap-3">
        {list.data?.content.map((i) => (
          <li key={i.id} className="rounded-lg border border-slate-700 bg-slate-900 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold break-words">{i.title}</h2>
              <span className="text-xs text-slate-300">
                Severidad {SEVERITY[i.severity] ?? i.severity} · {i.createdBy.displayName} · {formatDate(i.createdAt)}
                {i.file ? ` · archivo ${i.file.name}` : ''}
              </span>
            </div>
            <p className="mt-1 text-sm break-words whitespace-pre-wrap text-slate-200">{i.description}</p>
            {i.photos.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {i.photos.map((p) => {
                  const url = safeHttpUrl(p.url)
                  return url ? (
                    <li key={p.mediaId}>
                      <a href={url} target="_blank" rel="noopener noreferrer">
                        <img
                          src={url}
                          alt={`Foto del reporte ${i.title}`}
                          width={160}
                          height={Math.round((160 * p.height) / Math.max(1, p.width))}
                          loading="lazy"
                          decoding="async"
                          className="h-auto rounded-md bg-slate-800"
                          style={{ aspectRatio: `${p.width} / ${p.height}` }}
                        />
                      </a>
                    </li>
                  ) : null
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {list.data && (
        <Pagination
          page={list.data.page}
          totalPages={list.data.totalPages}
          totalElements={list.data.totalElements}
          onPage={(p) => {
            const n = new URLSearchParams(sp)
            if (p) n.set('page', String(p))
            else n.delete('page')
            setSp(n)
          }}
        />
      )}
    </>
  )
}
