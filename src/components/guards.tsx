import type { ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import { hasPermission, useAuth } from '../auth/authStore'
import type { Permission } from '../lib/schemas'
import { Splash } from './Splash'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'checking') return <Splash label="Verificando la sesión…" />
  if (status === 'anonymous') {
    const next = location.pathname + location.search + location.hash
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }
  return <>{children}</>
}

export function RequirePermission({ perm, children }: { perm: Permission | Permission[]; children: ReactNode }) {
  const { me } = useAuth()
  const perms = Array.isArray(perm) ? perm : [perm]
  const missing = perms.filter((p) => !hasPermission(me, p))
  if (missing.length > 0) return <NoPermission missing={missing} />
  return <>{children}</>
}

export function NoPermission({ missing }: { missing: string[] }) {
  return (
    <section className="mx-auto max-w-lg py-16 text-center">
      <h1 className="mb-3 text-2xl font-bold">Sin permiso</h1>
      <p className="mb-6 text-slate-200">
        Tu rol no tiene acceso a esta sección. Falta: <code className="text-cyan-200">{missing.join(', ')}</code>.
      </p>
      <Link to="/files" className="text-cyan-200 underline">
        Volver a los archivos
      </Link>
    </section>
  )
}

/** Valida el destino de `?next=` (solo rutas internas). */
export function safeNext(raw: string | null): string {
  if (!raw) return '/files'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/files'
  if (raw.startsWith('/login') || raw.startsWith('/register')) return '/files'
  return raw
}
