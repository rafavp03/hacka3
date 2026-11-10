import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { login, useAuth } from '../auth/authStore'
import { safeNext } from '../components/guards'
import { Splash } from '../components/Splash'
import { Alert, Button, Field } from '../components/ui'
import { ApiError, errorMessage, fieldErrors } from '../lib/errors'

export function AuthFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <p className="font-mono text-sm tracking-widest text-cyan-200">LUMON · MACRODATA REFINEMENT</p>
        <h1 className="mt-1 text-3xl font-bold">{title}</h1>
      </div>
      {children}
    </main>
  )
}

export default function LoginPage() {
  const { status, notice } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})

  if (status === 'checking') return <Splash label="Verificando la sesión…" />
  if (status === 'authenticated') return <Navigate to={next} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setFields({})
    try {
      await login(email.trim(), password)
      navigate(next, { replace: true })
    } catch (err) {
      setFields(fieldErrors(err))
      setError(err instanceof ApiError && err.code === 'INVALID_CREDENTIALS' ? 'Email o contraseña incorrectos.' : errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame title="Entrar al piso">
      {notice && <Alert kind="warning">{notice}</Alert>}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={fields.email} />
        <Field
          label="Contraseña"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
        />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" busy={busy}>
          Iniciar sesión
        </Button>
      </form>
      <p className="text-sm text-slate-200">
        ¿Primera vez?{' '}
        <Link to={`/register${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} className="text-cyan-200 underline">
          Registra tu cuadrilla
        </Link>
      </p>
    </AuthFrame>
  )
}
