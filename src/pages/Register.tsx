import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { register, useAuth } from '../auth/authStore'
import { safeNext } from '../components/guards'
import { Splash } from '../components/Splash'
import { Alert, Button, Field } from '../components/ui'
import { ApiError, errorMessage, fieldErrors } from '../lib/errors'
import { AuthFrame } from './Login'

const SERVER_FIELD_MESSAGES: Record<string, { field: string; message: string }> = {
  EMAIL_TAKEN: { field: 'email', message: 'Ese email ya está registrado.' },
  TEAM_NAME_TAKEN: { field: 'teamName', message: 'Ese nombre de cuadrilla ya existe.' },
}

export default function RegisterPage() {
  const { status } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  // Tras registrar se va a /estado (inscribir integrantes y configurar integraciones), salvo que hubiera un destino.
  const target = params.get('next') ? next : '/estado'
  const navigate = useNavigate()
  const [teamName, setTeamName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})

  if (status === 'checking') return <Splash label="Verificando la sesión…" />
  if (status === 'authenticated') return <Navigate to={target} replace />

  const validate = (): Record<string, string> => {
    const f: Record<string, string> = {}
    if (teamName.trim().length < 3 || teamName.trim().length > 40) f.teamName = 'Entre 3 y 40 caracteres.'
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) f.email = 'Email inválido.'
    if (password.length < 8 || password.length > 72) f.password = 'Entre 8 y 72 caracteres.'
    return f
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const local = validate()
    setFields(local)
    if (Object.keys(local).length > 0) return
    setBusy(true)
    try {
      await register(teamName.trim(), email.trim(), password)
      navigate(target, { replace: true })
    } catch (err) {
      const f = fieldErrors(err)
      if (err instanceof ApiError) {
        const known = SERVER_FIELD_MESSAGES[err.code]
        if (known) f[known.field] = known.message
      }
      setFields(f)
      if (Object.keys(f).length === 0) setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame title="Registrar la cuadrilla">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Nombre de la cuadrilla" required value={teamName} onChange={(e) => setTeamName(e.target.value)} error={fields.teamName} autoComplete="organization" />
        <Field label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={fields.email} autoComplete="email" />
        <Field
          label="Contraseña"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
          autoComplete="new-password"
          hint="Entre 8 y 72 caracteres."
        />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" busy={busy}>
          Registrar y entrar
        </Button>
      </form>
      <p className="text-sm text-slate-200">
        ¿Ya tienen cuenta?{' '}
        <Link to="/login" className="text-cyan-200 underline">
          Inicia sesión
        </Link>
      </p>
    </AuthFrame>
  )
}
