import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { hasPermission, logout, useAuth } from '../auth/authStore'
import { streamStatus } from '../events/eventBus'
import { startEvents, stopEvents } from '../events/sse'
import { useStore } from '../lib/store'
import { ErrorBoundary } from './ErrorPages'
import { Button } from './ui'

const STATE_LABEL: Record<string, string> = {
  idle: 'Sin conectar',
  connecting: 'Conectando…',
  open: 'En vivo',
  reconnecting: 'Reconectando…',
  blocked: 'Piso cerrado',
  stopped: 'Detenido',
}

export function StreamIndicator() {
  const s = useStore(streamStatus)
  const color =
    s.state === 'open' ? 'bg-emerald-400' : s.state === 'blocked' ? 'bg-slate-400' : s.state === 'reconnecting' ? 'bg-amber-400' : 'bg-slate-500'
  return (
    <span className="inline-flex items-center gap-2 text-xs text-slate-200" role="status" aria-live="polite" title={s.detail ?? undefined}>
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${color}`} />
      Eventos: {STATE_LABEL[s.state]}
      {s.role === 'follower' && s.state === 'open' ? ' (vía otra pestaña)' : ''}
    </span>
  )
}

export function Layout() {
  const { me, status } = useAuth()
  const location = useLocation()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (status === 'authenticated') startEvents()
    else stopEvents()
  }, [status])

  const links = [
    { to: '/files', label: 'Archivos', perm: 'files:read' as const },
    { to: '/refiners', label: 'Expedientes', perm: 'refiners:read' as const },
    { to: '/incidents', label: 'Incidencias', perm: 'incidents:read' as const },
    { to: '/estado', label: 'Estado', perm: null },
  ].filter((l) => l.perm === null || hasPermission(me, l.perm))

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-cyan-300 focus:px-3 focus:py-2 focus:text-slate-950">
        Saltar al contenido
      </a>
      <header className="border-b border-slate-700 bg-slate-900">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6">
            <NavLink to="/files" className="font-mono text-lg font-bold tracking-widest text-cyan-200">
              MDR
            </NavLink>
            <nav aria-label="Principal">
              <ul className="flex flex-wrap gap-1">
                {links.map((l) => (
                  <li key={l.to}>
                    <NavLink
                      to={l.to}
                      className={({ isActive }) =>
                        `rounded px-3 py-1.5 text-sm ${isActive ? 'bg-slate-700 text-white' : 'text-slate-200 hover:bg-slate-800'}`
                      }
                    >
                      {l.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <StreamIndicator />
            {me && (
              <span className="text-sm text-slate-200">
                {me.displayName} · <span className="text-slate-300">{me.role.name}</span> · <span className="font-mono">{me.team.code}</span>
              </span>
            )}
            <Button
              variant="secondary"
              busy={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await logout()
                } finally {
                  setBusy(false)
                }
              }}
            >
              Cerrar sesión
            </Button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 focus:outline-none">
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}
