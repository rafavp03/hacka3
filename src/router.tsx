import { createBrowserRouter, Navigate, Outlet } from 'react-router'
import { RouteError, NotFound } from './components/ErrorPages'
import { RequireAuth, RequirePermission } from './components/guards'
import { Layout } from './components/Layout'
import { Splash } from './components/Splash'
import LoginPage from './pages/Login'
import type { Permission } from './lib/schemas'
import type { ComponentType } from 'react'

/** Rutas con code splitting: la grilla, el storage y el resto no entran en el bundle inicial de /login. */
function lazyPage(load: () => Promise<{ default: ComponentType }>, perm?: Permission | Permission[]) {
  return async () => {
    const mod = await load()
    const Page = mod.default
    return {
      Component: perm
        ? () => (
            <RequirePermission perm={perm}>
              <Page />
            </RequirePermission>
          )
        : Page,
    }
  }
}

export const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    hydrateFallbackElement: <Splash label="Cargando…" />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', lazy: lazyPage(() => import('./pages/Register')) },
      {
        element: (
          <RequireAuth>
            <Layout />
          </RequireAuth>
        ),
        children: [
          {
            errorElement: <RouteError />,
            element: <Outlet />,
            children: [
              { path: '/', element: <Navigate to="/files" replace /> },
              { path: '/files', lazy: lazyPage(() => import('./pages/Files'), 'files:read') },
              { path: '/files/:id/refine', lazy: lazyPage(() => import('./grid/RefinePage'), 'files:read') },
              { path: '/estado', lazy: lazyPage(() => import('./pages/Estado')) },
              { path: '/refiners', lazy: lazyPage(() => import('./refiners/RefinersPage'), 'refiners:read') },
              { path: '/refiners/:id/edit', lazy: lazyPage(() => import('./refiners/RefinerEditPage'), ['refiners:read', 'refiners:write']) },
              { path: '/refiners/:id/badge', lazy: lazyPage(() => import('./media/BadgeEditorPage'), ['refiners:read', 'refiners:write', 'media:upload']) },
              { path: '/incidents', lazy: lazyPage(() => import('./media/IncidentsPage'), 'incidents:read') },
              { path: '/incidents/new', lazy: lazyPage(() => import('./media/IncidentNewPage'), ['incidents:create', 'media:upload']) },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
    ],
  },
])
