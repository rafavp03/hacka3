/** Saneo de parámetros de URL: un valor inválido nunca rompe la vista, se reemplaza por el valor por defecto. */
export function intParam(raw: string | null, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === null || raw.trim() === '' || !/^\d+$/.test(raw.trim())) return def
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : def
}

export function enumParam<T extends string>(raw: string | null, allowed: readonly T[], def: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : def
}

export function textParam(raw: string | null, maxLen: number): string {
  return (raw ?? '').slice(0, maxLen)
}

/** Compara dos URLSearchParams ignorando el orden. */
export function sameParams(a: URLSearchParams, b: URLSearchParams): boolean {
  const sa = [...a.entries()].sort().join('&')
  const sb = [...b.entries()].sort().join('&')
  return sa === sb
}
