/** Toda la configuración viene de variables de entorno de Vite. Nada está escrito en el código. */
function trimSlash(v: string | undefined): string {
  return (v ?? '').trim().replace(/\/+$/, '')
}

export type StorageProvider = 'SUPABASE' | 'CLOUDINARY'

const providerRaw = (import.meta.env.VITE_STORAGE_PROVIDER ?? '').trim().toUpperCase()

export const env = {
  apiBaseUrl: trimSlash(import.meta.env.VITE_API_BASE_URL),
  wsBaseUrl: trimSlash(import.meta.env.VITE_WS_BASE_URL),
  build: __BUILD_SHA__,
  version: __APP_VERSION__,
  storageProvider: (providerRaw === 'SUPABASE' || providerRaw === 'CLOUDINARY' ? providerRaw : null) as StorageProvider | null,
  supabase: {
    url: trimSlash(import.meta.env.VITE_SUPABASE_URL),
    publishableKey: (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim(),
    bucket: (import.meta.env.VITE_SUPABASE_BUCKET ?? '').trim() || 'lumon-media',
  },
  cloudinary: {
    cloudName: (import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ?? '').trim(),
    uploadPreset: (import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET ?? '').trim(),
  },
} as const

export const configErrors: string[] = []
if (!env.apiBaseUrl) configErrors.push('Falta VITE_API_BASE_URL.')
if (!env.wsBaseUrl) configErrors.push('Falta VITE_WS_BASE_URL.')
