/** Toda la configuración viene de variables de entorno de Vite. Nada está escrito en el código. */
function trimSlash(v: string | undefined): string {
  return (v ?? '').trim().replace(/\/+$/, '')
}

export type StorageProvider = 'SUPABASE' | 'CLOUDINARY'

const supabase = {
  url: trimSlash(import.meta.env.VITE_SUPABASE_URL),
  publishableKey: (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim(),
  bucket: (import.meta.env.VITE_SUPABASE_BUCKET ?? '').trim() || 'lumon-media',
}
const cloudinary = {
  cloudName: (import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ?? '').trim(),
  uploadPreset: (import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET ?? '').trim(),
}

/** VITE_STORAGE_PROVIDER manda; si no está, se deduce de las variables del storage que sí estén cargadas. */
function resolveProvider(): StorageProvider | null {
  const raw = (import.meta.env.VITE_STORAGE_PROVIDER ?? '').trim().toUpperCase()
  if (raw === 'SUPABASE' || raw === 'CLOUDINARY') return raw
  if (supabase.url && supabase.publishableKey) return 'SUPABASE'
  if (cloudinary.cloudName && cloudinary.uploadPreset) return 'CLOUDINARY'
  return null
}

export const env = {
  apiBaseUrl: trimSlash(import.meta.env.VITE_API_BASE_URL),
  wsBaseUrl: trimSlash(import.meta.env.VITE_WS_BASE_URL),
  build: __BUILD_SHA__,
  version: __APP_VERSION__,
  storageProvider: resolveProvider(),
  supabase,
  cloudinary,
} as const

export const configErrors: string[] = []
if (!env.apiBaseUrl) configErrors.push('Falta VITE_API_BASE_URL.')
if (!env.wsBaseUrl) configErrors.push('Falta VITE_WS_BASE_URL.')
