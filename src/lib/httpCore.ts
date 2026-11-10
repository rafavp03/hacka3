import { env } from '../env'
import { ApiError, isRecord, NetworkError } from './errors'
import { isAbortError } from './time'

export interface RawOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  token?: string | null
}

/** Una sola request a la API, con X-Lumon-Build siempre y Authorization si hay token. */
export async function rawFetch(path: string, opts: RawOptions = {}): Promise<Response> {
  const headers = new Headers(opts.headers)
  headers.set('X-Lumon-Build', env.build)
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`)
  let body: string | undefined
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(opts.body)
  }
  try {
    return await fetch(env.apiBaseUrl + path, {
      method: opts.method ?? 'GET',
      headers,
      body,
      signal: opts.signal,
      cache: 'no-store',
      credentials: 'omit',
    })
  } catch (e) {
    if (isAbortError(e) || opts.signal?.aborted) throw e
    throw new NetworkError()
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* cuerpo vacío o no JSON */
  }
  if (isRecord(body) && typeof body.error === 'string') {
    return new ApiError(
      res.status,
      {
        error: body.error,
        message: typeof body.message === 'string' ? body.message : body.error,
        details: body.details ?? null,
        requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
      },
      res.headers,
    )
  }
  return new ApiError(res.status, { error: `HTTP_${res.status}`, message: res.statusText || 'Error', details: null }, res.headers)
}

export async function readJson(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('La respuesta de Lumon no es JSON válido.')
  }
}
