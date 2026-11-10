export interface ApiErrorBody {
  error: string
  message: string
  details: unknown
  requestId?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  readonly headers: Headers | null
  readonly requestId: string | undefined

  constructor(status: number, body: ApiErrorBody, headers: Headers | null) {
    super(body.message || body.error)
    this.name = 'ApiError'
    this.status = status
    this.code = body.error
    this.details = body.details
    this.headers = headers
    this.requestId = body.requestId
  }

  get retryAfterMs(): number | null {
    const v = this.headers?.get('Retry-After')
    if (!v) return null
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n * 1000 : null
  }
}

/** Error de red (fetch rechazado, CORS, sin conexión). */
export class NetworkError extends Error {
  constructor(message = 'No se pudo conectar con Lumon.') {
    super(message)
    this.name = 'NetworkError'
  }
}

/** La sesión terminó (revocada, refresh reutilizado, token inválido). */
export class SessionEndedError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super('La sesión terminó.')
    this.name = 'SessionEndedError'
    this.reason = reason
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `details.fields` de un VALIDATION_ERROR, o `details.field` de un conflicto (EMAIL_TAKEN…). */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || !isRecord(e.details)) return {}
  const out: Record<string, string> = {}
  const fields = e.details.fields
  if (isRecord(fields)) for (const [k, v] of Object.entries(fields)) if (typeof v === 'string') out[k] = v
  const field = e.details.field
  if (typeof field === 'string') out[field] = e.message
  return out
}

const FRIENDLY: Record<string, string> = {
  RATE_LIMITED: 'Demasiadas solicitudes. Espera unos segundos.',
  SERVICE_UNAVAILABLE: 'Lumon no está disponible en este momento. Reintenta en unos segundos.',
  FORBIDDEN: 'No tienes permiso para esta acción.',
  CLEARANCE_REQUIRED: 'El Piso de Pruebas sigue cerrado: aprueben la revisión automática en /estado.',
  NOT_FOUND: 'No se encontró el recurso.',
  BUILD_HEADER_REQUIRED: 'El build desplegado no envía un X-Lumon-Build válido.',
  STORAGE_NOT_VERIFIED: 'El storage de imágenes todavía no está verificado (ver /estado).',
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return FRIENDLY[e.code] ?? e.message ?? e.code
  if (e instanceof NetworkError) return e.message
  if (e instanceof SessionEndedError) return 'La sesión terminó.'
  if (e instanceof Error) return e.message
  return 'Error inesperado.'
}
