import { useStore, createStore } from '../lib/store'
import { request } from '../lib/http'
import { ApiError, NetworkError, SessionEndedError } from '../lib/errors'
import { MeSchema, RegisterResponseSchema, TokenPairSchema, type Me, type Permission } from '../lib/schemas'
import { backoffDelay, sleep } from '../lib/time'
import { hasStoredSession, logout as sessionLogout, onPeerLogin, onSessionEnded, requestTokenFromPeers, startSession } from './session'

export type AuthStatus = 'checking' | 'authenticated' | 'anonymous'

export interface AuthState {
  status: AuthStatus
  me: Me | null
  notice: string | null
}

export const authStore = createStore<AuthState>({ status: 'checking', me: null, notice: null })

const REASONS: Record<string, string | null> = {
  LOGOUT: 'Se cerró la sesión.',
  REFRESH_REUSED:
    'Tu sesión fue revocada por seguridad: se presentó un refresh token ya usado. Vuelve a iniciar sesión.',
  SESSION_REVOKED: 'Tu sesión fue revocada en el servidor. Vuelve a iniciar sesión.',
  TOKEN_INVALID: 'Tu sesión ya no es válida. Vuelve a iniciar sesión.',
  REFRESH_INVALID: 'Tu sesión expiró. Vuelve a iniciar sesión.',
  NO_SESSION: null,
}

onSessionEnded((reason) => {
  authStore.set({ status: 'anonymous', me: null, notice: reason in REASONS ? (REASONS[reason] ?? null) : 'La sesión terminó.' })
})

onPeerLogin(() => {
  if (authStore.get().status !== 'authenticated') void loadMe().catch(() => undefined)
})

export async function loadMe(signal?: AbortSignal): Promise<Me> {
  const { data } = await request('/auth/me', { signal }, (v) => MeSchema.parse(v))
  authStore.set((s) => ({ ...s, status: 'authenticated', me: data, notice: null }))
  return data
}

let bootstrapped = false
/** Restaura la sesión al cargar (sin mostrar el login mientras se verifica). */
export async function bootstrap(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true
  if (!(await hasStoredSession())) {
    authStore.set((s) => ({ ...s, status: 'anonymous', me: null }))
    return
  }
  await requestTokenFromPeers()
  for (let attempt = 0; ; attempt++) {
    try {
      await loadMe()
      return
    } catch (e) {
      if (e instanceof SessionEndedError) return
      const transient = e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)
      if (!transient || attempt >= 5) {
        authStore.set({ status: 'anonymous', me: null, notice: 'No se pudo restaurar la sesión. Inicia sesión de nuevo.' })
        return
      }
      await sleep(backoffDelay(attempt, 800))
    }
  }
}

export async function login(email: string, password: string): Promise<void> {
  const { data } = await request(
    '/auth/login',
    { method: 'POST', body: { email, password }, auth: false },
    (v) => TokenPairSchema.parse(v),
  )
  await startSession(data)
  await loadMe()
}

export async function register(teamName: string, email: string, password: string): Promise<string> {
  const { data } = await request(
    '/auth/register',
    { method: 'POST', body: { teamName, email, password }, auth: false },
    (v) => RegisterResponseSchema.parse(v),
  )
  await startSession(data)
  await loadMe()
  return data.team.code
}

export async function logout(): Promise<void> {
  await sessionLogout()
}

export function useAuth(): AuthState {
  return useStore(authStore)
}

export function useMe(): Me | null {
  return useStore(authStore, (s) => s.me)
}

export function hasPermission(me: Me | null, perm: Permission): boolean {
  return !!me && me.permissions.includes(perm)
}

export function useCan(perm: Permission): boolean {
  return useStore(authStore, (s) => hasPermission(s.me, perm))
}
