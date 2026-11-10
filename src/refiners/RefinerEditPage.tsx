import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { NotFound } from '../components/ErrorPages'
import { Alert, Button, Field, PageTitle, Select, Spinner, TextArea } from '../components/ui'
import { ApiError, errorMessage, fieldErrors } from '../lib/errors'
import type { Department, Refiner } from '../lib/schemas'
import { useStore } from '../lib/store'
import { intParam } from '../lib/urlState'
import { conflictFrom, getDepartments, getRefiner, patchRefiner, type RefinerPatch, type VersionedRefiner } from './api'
import { lastRefinerUpdate } from './refinerStore'

interface Form {
  title: string
  extension: string
  bio: string
  departmentId: number
}

type FieldKey = keyof Form
const FIELDS: { key: FieldKey; label: string }[] = [
  { key: 'title', label: 'Título' },
  { key: 'extension', label: 'Anexo' },
  { key: 'bio', label: 'Biografía' },
  { key: 'departmentId', label: 'Departamento' },
]

function formOf(r: Refiner): Form {
  return { title: r.title, extension: r.extension, bio: r.bio, departmentId: r.department.id }
}

function diff(form: Form, base: Form): RefinerPatch {
  const p: RefinerPatch = {}
  if (form.title !== base.title) p.title = form.title
  if (form.extension !== base.extension) p.extension = form.extension
  if (form.bio !== base.bio) p.bio = form.bio
  if (form.departmentId !== base.departmentId) p.departmentId = form.departmentId
  return p
}

export default function RefinerEditPage() {
  const { id } = useParams()
  const refinerId = intParam(id ?? null, -1, 1)
  if (refinerId < 1) return <NotFound />
  return <Editor key={refinerId} id={refinerId} />
}

function Editor({ id }: { id: number }) {
  const [base, setBase] = useState<VersionedRefiner | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [conflict, setConflict] = useState<VersionedRefiner | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const ctl = new AbortController()
    setLoadError(null)
    getRefiner(id, ctl.signal)
      .then((v) => {
        setBase(v)
        setForm(formOf(v.refiner))
      })
      .catch((e: unknown) => !ctl.signal.aborted && setLoadError(e))
    getDepartments().then(setDepartments).catch(() => undefined)
    return () => ctl.abort()
  }, [id, nonce])

  // Aviso si el expediente cambia mientras se edita.
  const update = useStore(lastRefinerUpdate)
  const staleBy = update && base && update.id === id && update.version > base.refiner.version ? update : null

  if (loadError instanceof ApiError && loadError.status === 404) return <NotFound />
  if (loadError)
    return (
      <Alert>
        {errorMessage(loadError)}{' '}
        <Button variant="ghost" onClick={() => setNonce((n) => n + 1)}>
          Reintentar
        </Button>
      </Alert>
    )
  if (!base || !form) return <Spinner label="Cargando expediente…" />

  const save = async (patch: RefinerPatch, etag: string) => {
    if (Object.keys(patch).length === 0) {
      setMsg({ kind: 'info', text: 'No hay cambios para guardar.' })
      return
    }
    setBusy(true)
    setMsg(null)
    setFields({})
    try {
      const saved = await patchRefiner(id, etag, patch)
      setBase(saved)
      setForm(formOf(saved.refiner))
      setConflict(null)
      setMsg({ kind: 'success', text: `Guardado (versión ${saved.refiner.version}).` })
    } catch (e) {
      const c = conflictFrom(e)
      if (c) {
        setConflict(c)
        return
      }
      setFields(fieldErrors(e))
      setMsg({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void save(diff(form, formOf(base.refiner)), base.etag)
  }

  if (conflict)
    return (
      <ConflictView
        mine={form}
        server={conflict.refiner}
        departments={departments}
        busy={busy}
        onCancel={() => {
          setBase(conflict)
          setForm(formOf(conflict.refiner))
          setConflict(null)
          setMsg({ kind: 'info', text: 'Se descartaron tus cambios y se cargó la versión del servidor.' })
        }}
        onResolve={(resolved) => void save(diff(resolved, formOf(conflict.refiner)), conflict.etag)}
      />
    )

  const r = base.refiner
  return (
    <>
      <PageTitle actions={<Link to="/refiners" className="text-sm text-cyan-200 underline">Volver al directorio</Link>}>
        Editar expediente: {r.fullName}
      </PageTitle>
      <p className="mb-4 text-sm text-slate-300">Versión leída: {r.version}</p>
      {staleBy && (
        <div className="mb-4">
          <Alert kind="warning" title="El expediente cambió mientras editabas">
            {staleBy.updatedBy.displayName} lo actualizó a la versión {staleBy.version}
            {staleBy.changes.length ? ` (cambió: ${staleBy.changes.join(', ')})` : ''}. Si guardas, verás el conflicto campo por campo antes de sobrescribir nada.
          </Alert>
        </div>
      )}
      <form onSubmit={submit} className="flex max-w-2xl flex-col gap-4" noValidate>
        <Field label="Título" value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} error={fields.title} />
        <Field
          label="Anexo"
          value={form.extension}
          inputMode="numeric"
          pattern="[0-9]{3,6}"
          hint="De 3 a 6 dígitos."
          onChange={(e) => setForm({ ...form, extension: e.target.value })}
          error={fields.extension}
        />
        <Select label="Departamento" value={String(form.departmentId)} onChange={(e) => setForm({ ...form, departmentId: Number(e.target.value) })} error={fields.departmentId}>
          {!departments.some((d) => d.id === form.departmentId) && <option value={form.departmentId}>{r.department.name}</option>}
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <TextArea label="Biografía" rows={6} maxLength={2000} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} error={fields.bio} />
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <div className="flex gap-3">
          <Button type="submit" busy={busy}>
            Guardar
          </Button>
          <Button variant="secondary" onClick={() => setForm(formOf(r))}>
            Deshacer cambios
          </Button>
        </div>
      </form>
    </>
  )
}

function display(key: FieldKey, f: Form, departments: Department[], server?: Refiner): string {
  if (key === 'departmentId') return departments.find((d) => d.id === f.departmentId)?.name ?? (server && server.department.id === f.departmentId ? server.department.name : `#${f.departmentId}`)
  return String(f[key])
}

/** 412: lo que escribió el usuario vs lo que hay ahora, campo por campo; se elige antes de reintentar. */
function ConflictView({
  mine,
  server,
  departments,
  busy,
  onCancel,
  onResolve,
}: {
  mine: Form
  server: Refiner
  departments: Department[]
  busy: boolean
  onCancel: () => void
  onResolve: (f: Form) => void
}) {
  const theirs = formOf(server)
  const differing = useMemo(() => FIELDS.filter((f) => mine[f.key] !== theirs[f.key]), [mine, theirs])
  const [choice, setChoice] = useState<Record<string, 'mine' | 'server'>>(() => Object.fromEntries(differing.map((f) => [f.key, 'mine'])))
  const resolved: Form = { ...theirs }
  for (const f of differing) if (choice[f.key] === 'mine') (resolved as unknown as Record<string, unknown>)[f.key] = mine[f.key]

  return (
    <section aria-labelledby="conflict-title">
      <h1 id="conflict-title" className="mb-2 text-2xl font-bold">
        Conflicto de versión
      </h1>
      <Alert kind="warning">
        Alguien cambió el expediente de {server.fullName} desde que lo leíste (ahora está en la versión {server.version}). Nada se guardó. Elige, campo por campo, qué valor conservar.
      </Alert>
      {differing.length === 0 && <p className="mt-4 text-slate-200">Tus cambios ya coinciden con la versión del servidor.</p>}
      <div className="mt-4 flex flex-col gap-4">
        {differing.map((f) => (
          <fieldset key={f.key} className="rounded-lg border border-slate-700 p-3">
            <legend className="px-1 font-semibold">{f.label}</legend>
            <div className="grid gap-3 md:grid-cols-2">
              {(['mine', 'server'] as const).map((side) => (
                <label key={side} className={`flex cursor-pointer gap-2 rounded-md border p-2 ${choice[f.key] === side ? 'border-cyan-300 bg-slate-800' : 'border-slate-700'}`}>
                  <input type="radio" name={`c-${f.key}`} checked={choice[f.key] === side} onChange={() => setChoice((c) => ({ ...c, [f.key]: side }))} />
                  <span className="min-w-0">
                    <span className="block text-xs text-slate-300">{side === 'mine' ? 'Lo que escribiste' : `En el servidor (v${server.version})`}</span>
                    <span className="block break-words whitespace-pre-wrap">{display(f.key, side === 'mine' ? mine : theirs, departments, server) || '(vacío)'}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button busy={busy} onClick={() => onResolve(resolved)} disabled={differing.length === 0}>
          Guardar sobre la versión {server.version}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Descartar lo mío y usar la del servidor
        </Button>
      </div>
    </section>
  )
}
