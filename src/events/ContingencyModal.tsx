import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../lib/errors'
import { request } from '../lib/http'
import { useStore } from '../lib/store'
import { Alert, Button } from '../components/ui'
import { contingencyStore, resolveContingency } from './contingency'

/** Modal que interrumpe en todas las pestañas: foco atrapado, anunciado y solo se cierra al confirmar. */
export function ContingencyModal() {
  const list = useStore(contingencyStore)
  const current = list[0]
  const dialogRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!current) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setError(null)
    buttonRef.current?.focus()
    const root = document.getElementById('root-app')
    root?.setAttribute('inert', '')
    root?.setAttribute('aria-hidden', 'true')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault() // no se cierra sin confirmar
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!first || !last) return
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (!dialogRef.current.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      root?.removeAttribute('inert')
      root?.removeAttribute('aria-hidden')
      previouslyFocused?.focus()
    }
  }, [current])

  if (!current) return null

  const ack = async () => {
    setBusy(true)
    setError(null)
    try {
      await request(`/contingency/${encodeURIComponent(String(current.id))}/ack`, { method: 'POST', retries: 2, retryNetwork: true })
      resolveContingency(current.id)
    } catch (e) {
      setError(`No se pudo confirmar: ${errorMessage(e)} Vuelve a intentarlo.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="contingency-title"
        aria-describedby="contingency-desc"
        className="w-full max-w-md rounded-lg border-2 border-amber-300 bg-slate-900 p-6 shadow-2xl"
      >
        <h2 id="contingency-title" className="mb-2 text-xl font-bold text-amber-200">
          Contingencia de horas extra activada
        </h2>
        <p id="contingency-desc" className="mb-4 whitespace-pre-wrap break-words text-slate-100">
          {current.message || 'Se activó una contingencia para tu usuario. Confírmala para continuar.'}
        </p>
        {error && (
          <div className="mb-4">
            <Alert>{error}</Alert>
          </div>
        )}
        <Button ref={buttonRef} onClick={() => void ack()} busy={busy} className="w-full">
          Confirmar contingencia
        </Button>
      </div>
    </div>
  )
}
