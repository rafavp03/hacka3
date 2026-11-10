import { endSession, ensureAccessToken, refresh } from '../auth/session'
import { ApiError, NetworkError, SessionEndedError } from './errors'
import { rawFetch, readJson, toApiError } from './httpCore'
import { backoffDelay, sleep } from './time'

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Envía Authorization (por defecto sí). */
  auth?: boolean
  /** Reintentos ante 503/429/red. Por defecto 4 en GET y 0 en el resto. */
  retries?: number
  /** Reintentar también si falla la red (por defecto solo en GET). */
  retryNetwork?: boolean
  /** Se llama antes de cada reintento (útil para mostrar "reintentando"). */
  onRetry?: (attempt: number, reason: unknown) => void
}

export interface ApiResult<T> {
  data: T
  status: number
  headers: Headers
}

const SESSION_CODES = new Set(['SESSION_REVOKED', 'TOKEN_INVALID', 'REFRESH_REUSED'])

export async function request<T = unknown>(
  path: string,
  opts: RequestOptions = {},
  parse?: (v: unknown) => T,
): Promise<ApiResult<T>> {
  const method = opts.method ?? 'GET'
  const auth = opts.auth ?? true
  const maxRetries = opts.retries ?? (method === 'GET' ? 4 : 0)
  const retryNetwork = opts.retryNetwork ?? method === 'GET'
  let refreshed = false
  let attempt = 0
  for (;;) {
    const token = auth ? await ensureAccessToken() : null
    let res: Response
    try {
      res = await rawFetch(path, { method, body: opts.body, headers: opts.headers, signal: opts.signal, token })
    } catch (e) {
      if (e instanceof NetworkError && retryNetwork && attempt < maxRetries) {
        opts.onRetry?.(attempt + 1, e)
        await sleep(backoffDelay(attempt++), opts.signal)
        continue
      }
      throw e
    }
    if (res.ok) {
      const raw = await readJson(res)
      let data: T
      try {
        data = parse ? parse(raw) : (raw as T)
      } catch (e) {
        console.error('Respuesta inesperada de', path, e)
        throw new Error('Lumon respondió con un formato inesperado.')
      }
      return { data, status: res.status, headers: res.headers }
    }
    const err = await toApiError(res)
    if (res.status === 401 && auth) {
      // Solo TOKEN_EXPIRED justifica un refresh, y cada request se reintenta una sola vez.
      if (err.code === 'TOKEN_EXPIRED' && !refreshed) {
        refreshed = true
        await refresh(token)
        continue
      }
      if (SESSION_CODES.has(err.code)) {
        await endSession(err.code)
        throw new SessionEndedError(err.code)
      }
    }
    if ((res.status === 503 || res.status === 429) && attempt < maxRetries) {
      const wait = Math.max(err.retryAfterMs ?? 0, backoffDelay(attempt))
      opts.onRetry?.(attempt + 1, err)
      attempt++
      await sleep(wait, opts.signal)
      continue
    }
    throw err
  }
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code)
}

/** Construye una query string ignorando vacíos. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}
