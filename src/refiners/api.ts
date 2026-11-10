import { ApiError } from '../lib/errors'
import { request } from '../lib/http'
import { DepartmentSchema, RefinerSchema, z, type Department, type Refiner } from '../lib/schemas'
import { applyRefiner } from './refinerStore'

export interface VersionedRefiner {
  refiner: Refiner
  etag: string
}

function etagOf(headers: Headers, r: Refiner): string {
  return headers.get('ETag') ?? `"${r.version}"`
}

export async function getRefiner(id: number, signal?: AbortSignal): Promise<VersionedRefiner> {
  const { data, headers } = await request(`/refiners/${id}`, { signal }, (v) => RefinerSchema.parse(v))
  applyRefiner(data)
  return { refiner: data, etag: etagOf(headers, data) }
}

export type RefinerPatch = Partial<{ title: string; extension: string; bio: string; departmentId: number; badgeMediaId: number | null }>

/** PATCH con If-Match (Regla de Milchick). Un 412 sube como ApiError con details.current. */
export async function patchRefiner(id: number, etag: string, patch: RefinerPatch): Promise<VersionedRefiner> {
  const { data, headers } = await request(
    `/refiners/${id}`,
    { method: 'PATCH', body: patch, headers: { 'If-Match': etag } },
    (v) => RefinerSchema.parse(v),
  )
  applyRefiner(data)
  return { refiner: data, etag: etagOf(headers, data) }
}

const DepartmentsSchema = z.array(DepartmentSchema)
let deptCache: Promise<Department[]> | null = null
export function getDepartments(signal?: AbortSignal): Promise<Department[]> {
  if (!deptCache) {
    deptCache = request('/departments', { signal }, (v) => DepartmentsSchema.parse(v)).then((r) => r.data)
    deptCache.catch(() => {
      deptCache = null
    })
  }
  return deptCache
}

export function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    const url = new URL(u)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function conflictFrom(e: unknown): VersionedRefiner | null {
  if (!(e instanceof ApiError) || e.code !== 'VERSION_CONFLICT') return null
  const err = e
  const d = err.details as { current?: unknown } | null
  const parsed = RefinerSchema.safeParse(d?.current)
  if (!parsed.success) return null
  applyRefiner(parsed.data)
  return { refiner: parsed.data, etag: err.headers?.get('ETag') ?? `"${parsed.data.version}"` }
}
