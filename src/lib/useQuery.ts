import { useCallback, useEffect, useRef, useState } from 'react'
import { on } from '../events/eventBus'
import { isAbortError } from './time'

export interface QueryState<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => void
  setData: (updater: (prev: T | undefined) => T | undefined) => void
}

/**
 * Carga con cancelación: cada cambio de `key` aborta la request anterior y solo la última puede escribir el estado
 * (una respuesta vieja nunca pisa a una nueva). Con `reloadOnReset`, un `stream.reset` vuelve a pedir el estado.
 */
export function useQuery<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, reloadOnReset = true): QueryState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(key !== null)
  const [nonce, setNonce] = useState(0)
  const seq = useRef(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    if (key === null) return
    const id = ++seq.current
    const ctl = new AbortController()
    setLoading(true)
    setError(null)
    fetcherRef
      .current(ctl.signal)
      .then((d) => {
        if (id === seq.current) {
          setDataState(d)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (isAbortError(e) || ctl.signal.aborted) return
        if (id === seq.current) {
          setError(e)
          setLoading(false)
        }
      })
    return () => ctl.abort()
  }, [key, nonce])

  useEffect(() => {
    if (!reloadOnReset) return
    return on('stream.reset', () => setNonce((n) => n + 1))
  }, [reloadOnReset])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const setData = useCallback((u: (prev: T | undefined) => T | undefined) => setDataState(u), [])
  return { data, error, loading, reload, setData }
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
