import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { bootstrap } from './auth/authStore'
import { HealthGate } from './components/HealthGate'
import { ErrorBoundary } from './components/ErrorPages'
import { ContingencyModal } from './events/ContingencyModal'
import './events/contingency'
import './refiners/refinerStore'
import { router } from './router'
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Falta #root')

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <HealthGate onReady={() => void bootstrap()}>
        <div id="root-app">
          <RouterProvider router={router} />
        </div>
        <ContingencyModal />
      </HealthGate>
    </ErrorBoundary>
  </StrictMode>,
)
