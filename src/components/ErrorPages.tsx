import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isRouteErrorResponse, Link, useNavigate, useRouteError } from 'react-router'
import { Button } from './ui'

export function NotFound() {
  return (
    <section className="mx-auto max-w-lg py-16 text-center">
      <p className="font-mono text-5xl text-cyan-200">404</p>
      <h1 className="mt-2 mb-3 text-2xl font-bold">Esta sala no existe</h1>
      <p className="mb-6 text-slate-200">La ruta que buscas no está en el piso separado.</p>
      <Link to="/files" className="text-cyan-200 underline">
        Ir a los archivos de datos
      </Link>
    </section>
  )
}

function ErrorView({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <section role="alert" className="mx-auto max-w-lg py-16 text-center">
      <h1 className="mb-3 text-2xl font-bold">Algo falló en esta vista</h1>
      <p className="mb-6 break-words text-slate-200">{message}</p>
      <div className="flex justify-center gap-3">
        <Button onClick={onBack}>Volver</Button>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Recargar
        </Button>
      </div>
    </section>
  )
}

/** errorElement de las rutas: un error de render no deja la app en blanco. */
export function RouteError() {
  const error = useRouteError()
  const navigate = useNavigate()
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />
  const message = error instanceof Error ? error.message : 'Error inesperado.'
  return <ErrorView message={message} onBack={() => navigate('/files')} />
}

interface BoundaryState {
  error: Error | null
}

/** Límite de errores para piezas sueltas (por ejemplo, el modal global). */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, BoundaryState> {
  override state: BoundaryState = { error: null }
  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack)
  }
  override componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  override render() {
    if (this.state.error)
      return <ErrorView message={this.state.error.message} onBack={() => this.setState({ error: null })} />
    return this.props.children
  }
}
