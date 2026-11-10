import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { configErrors } from '../env'
import { request } from '../lib/http'
import { HealthSchema } from '../lib/schemas'
import { backoffDelay } from '../lib/time'
import { Splash } from './Splash'
import { Alert, Button } from './ui'

/** Si /meta/health no responde: "Conectando con Lumon…", reintento solo con espera creciente y botón manual. */
export function HealthGate({ children, onReady }: { children: ReactNode; onReady: () => void }) {
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [nextIn, setNextIn] = useState(0)
  const timer = useRef<number | null>(null)
  const readyCb = useRef(onReady)
  readyCb.current = onReady

  const check = useCallback(async () => {
    try {
      await request('/meta/health', { auth: false, retries: 0, retryNetwork: false }, (v) => HealthSchema.parse(v))
      setReady(true)
      readyCb.current()
    } catch {
      setFailed(true)
      setAttempt((a) => a + 1)
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  useEffect(() => {
    if (ready || attempt === 0) return
    const delay = backoffDelay(attempt - 1, 1000, 30_000)
    const until = Date.now() + delay
    setNextIn(Math.ceil(delay / 1000))
    const tick = window.setInterval(() => setNextIn(Math.max(0, Math.ceil((until - Date.now()) / 1000))), 500)
    timer.current = window.setTimeout(() => void check(), delay)
    return () => {
      window.clearInterval(tick)
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [attempt, ready, check])

  if (ready) return <>{children}</>
  // Primer intento: un cargador neutro. "Conectando con Lumon…" solo si /meta/health no responde.
  if (!failed && configErrors.length === 0) return <Splash label="Cargando la consola…" />
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-bold">Conectando con Lumon…</h1>
      {configErrors.length > 0 && <Alert>{configErrors.join(' ')}</Alert>}
      {failed ? (
        <>
          <p className="text-slate-200" role="status" aria-live="polite">
            Lumon no responde todavía (intento {attempt}). Reintentando en {nextIn} s.
          </p>
          <Button
            onClick={() => {
              if (timer.current) window.clearTimeout(timer.current)
              void check()
            }}
          >
            Reintentar ahora
          </Button>
        </>
      ) : (
        <p className="text-slate-200" role="status">
          Verificando el servicio…
        </p>
      )}
    </main>
  )
}
