import { SessionEndedError } from '../lib/errors'
import { rawFetch, readJson, toApiError } from '../lib/httpCore'
import { idbDel, idbGet, idbSet } from '../lib/idb'
import { TokenPairSchema, type TokenPair } from '../lib/schemas'

/**
 * Tokens de la sesión.
 * - El access token vive SOLO en memoria (esta variable). Entre pestañas viaja por BroadcastChannel, que no persiste.
 * - El refresh token (un solo uso) se guarda en IndexedDB.
 * - Todo refresh ocurre dentro del Web Lock `lumon-refresh` y lee el refresh token vigente justo antes de usarlo, así
 *   ninguna pestaña presenta uno ya usado (sin REFRESH_REUSED). Dentro de una pestaña, las requests que reciben
 *   TOKEN_EXPIRED a la vez comparten la misma promesa: un solo POST /auth/refresh.
 */
const RT_KEY = 'refreshToken'

type AuthMessage =
  | { type: 'token'; accessToken: string }
  | { type: 'login'; accessToken: string }
  | { type: 'token-request'; id: string }
  | { type: 'token-response'; id: string; accessToken: string }
  | { type: 'ended'; reason: string }

const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lumon-auth') : null

let accessToken: string | null = null
let refreshing: Promise<string> | null = null

type EndedListener = (reason: string) => void
type LoginListener = () => void
const endedListeners = new Set<EndedListener>()
const loginListeners = new Set<LoginListener>()

export function onSessionEnded(l: EndedListener): () => void {
  endedListeners.add(l)
  return () => endedListeners.delete(l)
}
/** Otra pestaña inició sesión. */
export function onPeerLogin(l: LoginListener): () => void {
  loginListeners.add(l)
  return () => loginListeners.delete(l)
}

function post(msg: AuthMessage) {
  try {
    channel?.postMessage(msg)
  } catch {
    /* canal cerrado */
  }
}

const pendingPeerRequests = new Map<string, (token: string) => void>()

channel?.addEventListener('message', (ev: MessageEvent<AuthMessage>) => {
  const msg = ev.data
  switch (msg.type) {
    case 'token':
      if (accessToken !== null) accessToken = msg.accessToken
      break
    case 'login':
      accessToken = msg.accessToken
      for (const l of [...loginListeners]) l()
      break
    case 'token-request':
      if (accessToken) post({ type: 'token-response', id: msg.id, accessToken })
      break
    case 'token-response': {
      const resolve = pendingPeerRequests.get(msg.id)
      if (resolve) {
        pendingPeerRequests.delete(msg.id)
        resolve(msg.accessToken)
      }
      break
    }
    case 'ended':
      accessToken = null
      for (const l of [...endedListeners]) l(msg.reason)
      break
  }
})

export function getAccessToken(): string | null {
  return accessToken
}

export async function hasStoredSession(): Promise<boolean> {
  try {
    return (await idbGet(RT_KEY)) !== null
  } catch {
    return false
  }
}

export async function startSession(pair: TokenPair): Promise<void> {
  accessToken = pair.accessToken
  await idbSet(RT_KEY, pair.refreshToken)
  post({ type: 'login', accessToken: pair.accessToken })
}

/** Pide el access token vigente a otra pestaña abierta (evita rotar el refresh token al abrir pestañas). */
export function requestTokenFromPeers(timeoutMs = 350): Promise<string | null> {
  if (!channel) return Promise.resolve(null)
  const id = Math.random().toString(36).slice(2)
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pendingPeerRequests.delete(id)
      resolve(null)
    }, timeoutMs)
    pendingPeerRequests.set(id, (token) => {
      clearTimeout(t)
      accessToken = token
      resolve(token)
    })
    post({ type: 'token-request', id })
  })
}

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(name, { mode: 'exclusive' }, fn) as Promise<T>
  }
  return fn()
}

/**
 * Rota los tokens. `staleToken` es el token con el que la request recibió TOKEN_EXPIRED: si mientras tanto llegó uno
 * nuevo (de esta u otra pestaña), se usa ese sin volver a refrescar.
 */
export function refresh(staleToken: string | null): Promise<string> {
  if (refreshing) return refreshing
  refreshing = withLock('lumon-refresh', async () => {
    if (accessToken && accessToken !== staleToken) return accessToken
    const rt = await idbGet(RT_KEY)
    if (!rt) {
      await endSession('NO_SESSION')
      throw new SessionEndedError('NO_SESSION')
    }
    const res = await rawFetch('/auth/refresh', { method: 'POST', body: { refreshToken: rt } })
    if (res.ok) {
      const pair = TokenPairSchema.parse(await readJson(res))
      await idbSet(RT_KEY, pair.refreshToken)
      accessToken = pair.accessToken
      post({ type: 'token', accessToken: pair.accessToken })
      return pair.accessToken
    }
    const err = await toApiError(res)
    if (res.status === 401) {
      await endSession(err.code)
      throw new SessionEndedError(err.code)
    }
    throw err
  }).finally(() => {
    refreshing = null
  })
  return refreshing
}

/** Access token para una request: el de memoria, o uno nuevo con refresh si no hay. */
export async function ensureAccessToken(): Promise<string> {
  if (accessToken) return accessToken
  return refresh(null)
}

/** Termina la sesión localmente en todas las pestañas. */
export async function endSession(reason: string): Promise<void> {
  accessToken = null
  try {
    await idbDel(RT_KEY)
  } catch {
    /* sin IndexedDB */
  }
  post({ type: 'ended', reason })
  for (const l of [...endedListeners]) l(reason)
}

/** Logout: revoca la sesión en el servidor y la cierra en todas las pestañas. */
export async function logout(): Promise<void> {
  let rt: string | null = null
  try {
    rt = await idbGet(RT_KEY)
  } catch {
    rt = null
  }
  // Primero se avisa a todas las pestañas (cierre en < 2 s aunque la red tarde).
  const serverLogout = rt
    ? rawFetch('/auth/logout', { method: 'POST', body: { refreshToken: rt } }).catch(() => undefined)
    : Promise.resolve(undefined)
  await endSession('LOGOUT')
  await serverLogout
}
