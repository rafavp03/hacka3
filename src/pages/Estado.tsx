import { useEffect, useState, type FormEvent } from 'react'
import { loadMe, useCan } from '../auth/authStore'
import { Alert, Button, Card, Field, PageTitle, Select, Spinner } from '../components/ui'
import { env } from '../env'
import { ApiError, errorMessage, fieldErrors, isRecord } from '../lib/errors'
import { request } from '../lib/http'
import { formatDate } from '../lib/time'
import { useQuery } from '../lib/useQuery'

interface Check {
  name: string
  passed: boolean
  detail?: string
}

interface IntegrationStatus {
  deploy: { origin: string | null; verifiedAt: string | null; lastBuildSeen: string | null; lastBuildSeenAt: string | null; pendingChallenge: { origin: string; expiresAt: string } | null }
  storage: { provider: string | null; verifiedAt: string | null; checks: Check[] }
  clearance: { granted: boolean; grantedAt: string | null }
}

interface RosterMember {
  name: string
  code: string
}

interface Clearance {
  granted: boolean
  grantedAt: string | null
  checks: Check[]
  checkedAt: string | null
  workspace: { kind: string; chaosLevel: number }
  roster: { members: RosterMember[]; complete: boolean; locked: boolean }
  round: {
    approved: boolean
    approvedRound: number | null
    nextRoundAt: string | null
    drawnMember: { round: number; name: string; code: string; startsAt: string } | null
    attempts: { round: number; member: RosterMember; result: string | null }[]
  }
}

function asChecks(v: unknown): Check[] {
  if (!Array.isArray(v)) return []
  return v
    .filter(isRecord)
    .map((c) => ({ name: String(c.name ?? ''), passed: c.passed === true, detail: typeof c.detail === 'string' ? c.detail : undefined }))
}

function Checks({ checks }: { checks: Check[] }) {
  if (checks.length === 0) return <p className="text-sm text-slate-300">Sin comprobaciones todavía.</p>
  return (
    <ul className="mt-2 flex flex-col gap-1 text-sm">
      {checks.map((c) => (
        <li key={c.name} className="flex gap-2">
          <span aria-hidden="true" className={c.passed ? 'text-emerald-300' : 'text-rose-300'}>
            {c.passed ? '✔' : '✘'}
          </span>
          <span>
            <strong className="font-mono">{c.name}</strong> — {c.passed ? 'aprobada' : 'pendiente'}
            {c.detail ? `: ${c.detail}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

export default function EstadoPage() {
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking')
  useEffect(() => {
    const ctl = new AbortController()
    request('/meta/health', { auth: false, signal: ctl.signal, retries: 1 })
      .then(() => setHealth('ok'))
      .catch(() => !ctl.signal.aborted && setHealth('down'))
    return () => ctl.abort()
  }, [])

  const integrations = useQuery<IntegrationStatus>('integrations', async (signal) => (await request<IntegrationStatus>('/integrations/status', { signal })).data, false)
  const clearance = useQuery<Clearance>('clearance', async (signal) => (await request<Clearance>('/clearance', { signal })).data, false)

  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<{ granted: boolean; checks: Check[] } | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  const runCheck = async () => {
    setChecking(true)
    setCheckError(null)
    try {
      const { data } = await request<unknown>('/clearance/check', { method: 'POST', retries: 2 })
      const d = isRecord(data) ? data : {}
      setCheckResult({ granted: d.granted === true, checks: asChecks(d.checks) })
      clearance.reload()
      integrations.reload()
      await loadMe().catch(() => undefined)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CHECK_FROM_APP_REQUIRED')
        setCheckError('La revisión solo cuenta desde la app desplegada en el dominio verificado (no desde localhost ni Swagger).')
      else setCheckError(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  const deploy = integrations.data?.deploy
  const buildMismatch = deploy?.lastBuildSeen && env.build !== 'dev' && deploy.lastBuildSeen !== env.build

  return (
    <>
      <PageTitle>Estado</PageTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-lg font-semibold">Build y servicio</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-300">Build desplegado</dt>
            <dd className="font-mono">{env.build}</dd>
            <dt className="text-slate-300">Versión</dt>
            <dd>{env.version}</dd>
            <dt className="text-slate-300">API</dt>
            <dd role="status">{health === 'checking' ? 'verificando…' : health === 'ok' ? 'responde' : 'no responde'}</dd>
            <dt className="text-slate-300">Origen</dt>
            <dd className="break-all">{window.location.origin}</dd>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-2 text-lg font-semibold">Piso de Pruebas</h2>
          {clearance.loading && <Spinner small label="Cargando clearance…" />}
          {clearance.error !== null && <Alert>{errorMessage(clearance.error)}</Alert>}
          {clearance.data && (
            <div className="text-sm">
              <p>
                Estado: <strong>{clearance.data.granted ? `abierto (${formatDate(clearance.data.grantedAt)})` : 'cerrado'}</strong>
              </p>
              <p>
                Workspace: {clearance.data.workspace.kind} · caos {clearance.data.workspace.chaosLevel}
              </p>
              <p>
                Ronda de control: {clearance.data.round.approved ? `aprobada (ronda ${clearance.data.round.approvedRound ?? '—'})` : 'sin aprobar'}
                {clearance.data.round.nextRoundAt ? ` · próxima: ${formatDate(clearance.data.round.nextRoundAt)}` : ''}
              </p>
              {clearance.data.round.drawnMember && (
                <p className="text-amber-200">
                  Sorteado en la ronda {clearance.data.round.drawnMember.round}: {clearance.data.round.drawnMember.name}
                </p>
              )}
              <Checks checks={asChecks(clearance.data.checks)} />
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2">
            <Button onClick={() => void runCheck()} busy={checking}>
              Abrir el Piso de Pruebas
            </Button>
            {checkError && <Alert>{checkError}</Alert>}
            {checkResult && (
              <Alert kind={checkResult.granted ? 'success' : 'warning'} title={checkResult.granted ? 'Piso de Pruebas abierto' : 'Todavía no'}>
                <Checks checks={checkResult.checks} />
              </Alert>
            )}
          </div>
        </Card>

        <Card>
          <h2 className="mb-2 text-lg font-semibold">Integraciones</h2>
          {integrations.loading && <Spinner small label="Cargando integraciones…" />}
          {integrations.error !== null && <Alert>{errorMessage(integrations.error)}</Alert>}
          {integrations.data && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-300">Dominio</dt>
              <dd className="break-all">
                {deploy?.origin ?? 'sin verificar'} {deploy?.verifiedAt ? `(verificado ${formatDate(deploy.verifiedAt)})` : ''}
              </dd>
              <dt className="text-slate-300">Último build visto</dt>
              <dd className="font-mono">
                {deploy?.lastBuildSeen ?? '—'} {deploy?.lastBuildSeenAt ? `· ${formatDate(deploy.lastBuildSeenAt)}` : ''}
              </dd>
              <dt className="text-slate-300">Storage</dt>
              <dd>
                {integrations.data.storage.provider ?? 'sin registrar'} {integrations.data.storage.verifiedAt ? `(verificado ${formatDate(integrations.data.storage.verifiedAt)})` : ''}
              </dd>
            </dl>
          )}
          {buildMismatch && (
            <div className="mt-2">
              <Alert kind="warning">El backend vio el build {deploy?.lastBuildSeen}, distinto a este ({env.build}).</Alert>
            </div>
          )}
          {integrations.data && <Checks checks={asChecks(integrations.data.storage.checks)} />}
        </Card>

        <DeploySetup onDone={integrations.reload} />
        <StorageSetup onDone={integrations.reload} />
        <ChaosSetup current={clearance.data?.workspace.chaosLevel ?? null} onDone={clearance.reload} />
        <RosterSetup roster={clearance.data?.roster ?? null} onDone={clearance.reload} />
      </div>
    </>
  )
}

function DeploySetup({ onDone }: { onDone: () => void }) {
  const [origin, setOrigin] = useState(window.location.protocol === 'https:' ? window.location.origin : 'https://')
  const [token, setToken] = useState<{ token: string; path: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState<'challenge' | 'verify' | null>(null)
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const challenge = async (e: FormEvent) => {
    e.preventDefault()
    setBusy('challenge')
    setMsg(null)
    try {
      const { data } = await request<{ token: string; wellKnownPath: string; expiresAt: string }>('/integrations/deploy/challenge', {
        method: 'POST',
        body: { origin: origin.trim() },
      })
      setToken({ token: data.token, path: data.wellKnownPath, expiresAt: data.expiresAt })
    } catch (err) {
      const f = fieldErrors(err)
      setMsg({ kind: 'error', text: f.origin ?? errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const verify = async () => {
    setBusy('verify')
    setMsg(null)
    try {
      const { data } = await request<{ origin: string }>('/integrations/deploy/verify', { method: 'POST' })
      setMsg({ kind: 'success', text: `Origen ${data.origin} verificado.` })
      onDone()
    } catch (err) {
      const d = err instanceof ApiError && isRecord(err.details) ? err.details : null
      setMsg({ kind: 'error', text: `${errorMessage(err)}${d?.reason ? ` (${String(d.reason)}${d.hint ? `: ${String(d.hint)}` : ''})` : ''}` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <h2 className="mb-2 text-lg font-semibold">Verificar el dominio</h2>
      <form onSubmit={challenge} className="flex flex-col gap-2">
        <Field label="Origen de producción" value={origin} onChange={(e) => setOrigin(e.target.value)} hint="Solo https://dominio, sin ruta." />
        <Button type="submit" busy={busy === 'challenge'} variant="secondary">
          1. Pedir token
        </Button>
      </form>
      {token && (
        <div className="mt-3 text-sm">
          <p>
            2. Publiquen este texto en <code className="break-all">{token.path}</code> (variable de build <code>LUMON_VERIFICATION_TOKEN</code>) y
            redesplieguen. Vence {formatDate(token.expiresAt)}.
          </p>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-950 p-2 font-mono text-xs select-all">{token.token}</pre>
        </div>
      )}
      <Button className="mt-3" onClick={() => void verify()} busy={busy === 'verify'} variant="secondary">
        3. Verificar
      </Button>
      {msg && (
        <div className="mt-2">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
    </Card>
  )
}

function StorageSetup({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const provider = env.storageProvider
  const body =
    provider === 'SUPABASE'
      ? { provider: 'SUPABASE', projectUrl: env.supabase.url, bucket: env.supabase.bucket, publicKey: env.supabase.publishableKey }
      : provider === 'CLOUDINARY'
        ? { provider: 'CLOUDINARY', cloudName: env.cloudinary.cloudName, uploadPreset: env.cloudinary.uploadPreset }
        : null

  const register = async () => {
    if (!body) return
    setBusy(true)
    setMsg(null)
    try {
      const { data } = await request<{ checks: unknown }>('/integrations/storage', { method: 'PUT', body })
      setChecks(asChecks(data.checks))
      setMsg({ kind: 'success', text: 'Storage verificado.' })
      onDone()
    } catch (err) {
      if (err instanceof ApiError && isRecord(err.details)) setChecks(asChecks(err.details.checks))
      setMsg({ kind: 'error', text: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <h2 className="mb-2 text-lg font-semibold">Storage de imágenes</h2>
      {body ? (
        <p className="text-sm text-slate-200">
          Proveedor: <strong>{provider}</strong> (configurado con variables VITE_*; solo datos públicos).
        </p>
      ) : (
        <Alert kind="warning">Configura VITE_STORAGE_PROVIDER y sus variables para registrar el storage.</Alert>
      )}
      <Button className="mt-3" onClick={() => void register()} busy={busy} disabled={!body} variant="secondary">
        Registrar y probar storage
      </Button>
      {msg && (
        <div className="mt-2">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      {checks && <Checks checks={checks} />}
    </Card>
  )
}

function ChaosSetup({ current, onDone }: { current: number | null; onDone: () => void }) {
  const [level, setLevel] = useState('1')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  useEffect(() => {
    if (current !== null) setLevel(String(current))
  }, [current])
  const apply = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await request('/workspace/chaos', { method: 'PUT', body: { level: Number(level) } })
      setMsg({ kind: 'success', text: `Caos ${level} aplicado.` })
      onDone()
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <h2 className="mb-2 text-lg font-semibold">Modo caos</h2>
      <Select label="Nivel" value={level} onChange={(e) => setLevel(e.target.value)}>
        <option value="0">0 · sin caos</option>
        <option value="1">1 · mínimo de la evaluación</option>
        <option value="2">2 · agresivo</option>
      </Select>
      <Button className="mt-3" onClick={() => void apply()} busy={busy} variant="secondary">
        Aplicar
      </Button>
      {msg && (
        <div className="mt-2">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
    </Card>
  )
}

function RosterSetup({ roster, onDone }: { roster: Clearance['roster'] | null; onDone: () => void }) {
  const canManage = useCan('team:manage')
  const [members, setMembers] = useState<RosterMember[]>([
    { name: '', code: '' },
    { name: '', code: '' },
    { name: '', code: '' },
  ])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  useEffect(() => {
    if (roster && roster.members.length === 3) setMembers(roster.members.map((m) => ({ name: m.name, code: m.code })))
  }, [roster])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    setFields({})
    try {
      await request('/team/roster', { method: 'PUT', body: { members: members.map((m) => ({ name: m.name.trim(), code: m.code.trim() })) } })
      setMsg({ kind: 'success', text: 'Integrantes inscritos.' })
      onDone()
    } catch (err) {
      setFields(fieldErrors(err))
      setMsg({ kind: 'error', text: err instanceof ApiError && err.code === 'ROSTER_LOCKED' ? 'El roster ya está bloqueado (el equipo entró a un sorteo).' : errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <h2 className="mb-2 text-lg font-semibold">Integrantes (rondas de control)</h2>
      {roster?.locked && <Alert kind="info">Roster bloqueado: el equipo ya entró a un sorteo.</Alert>}
      <form onSubmit={save} className="flex flex-col gap-2">
        {members.map((m, i) => (
          <fieldset key={i} className="grid grid-cols-2 gap-2">
            <legend className="sr-only">Integrante {i + 1}</legend>
            <Field
              label={`Nombre ${i + 1}`}
              value={m.name}
              disabled={!canManage || roster?.locked}
              error={fields[`members.${i}.name`]}
              onChange={(e) => setMembers((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <Field
              label={`Código ${i + 1}`}
              value={m.code}
              disabled={!canManage || roster?.locked}
              error={fields[`members.${i}.code`]}
              onChange={(e) => setMembers((list) => list.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}
            />
          </fieldset>
        ))}
        {canManage ? (
          <Button type="submit" busy={busy} disabled={roster?.locked} variant="secondary">
            Guardar integrantes
          </Button>
        ) : (
          <p className="text-sm text-slate-300">Se necesita el permiso team:manage para editar.</p>
        )}
      </form>
      {msg && (
        <div className="mt-2">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
    </Card>
  )
}
