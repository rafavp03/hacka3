/**
 * Procesado de imágenes en el navegador, sin librerías: recorte y escalado con canvas, WebP con toBlob y SHA-256 con
 * SubtleCrypto. Re-codificar desde un canvas descarta los metadatos del original (EXIF, XMP, ubicación).
 */
export class WebpUnsupportedError extends Error {
  constructor() {
    super('Tu navegador no puede generar imágenes WebP. Usa un navegador actualizado (Chrome, Edge, Firefox o Safari 16+).')
    this.name = 'WebpUnsupportedError'
  }
}

export const BADGE_SIZE = 512
export const BADGE_MAX_BYTES = 122_880
export const INCIDENT_MIN_SIDE = 800
export const INCIDENT_MAX_SIDE = 1600
export const INCIDENT_MAX_BYTES = 307_200
const ACCEPTED = /^image\/(png|jpeg|webp|gif|bmp|avif|heic|heif)$/

export function isImageFile(f: File | Blob): boolean {
  return ACCEPTED.test(f.type)
}

export async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  if (!isImageFile(file)) throw new Error('El archivo no es una imagen compatible (PNG, JPEG, WebP…).')
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('No se pudo leer la imagen.')
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new WebpUnsupportedError())), 'image/webp', quality)
  })
}

export async function encodeWebp(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob | null> {
  for (const q of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34]) {
    const blob = await canvasToBlob(canvas, q)
    // Si el navegador no sabe WebP, toBlob devuelve PNG.
    if (blob.type !== 'image/webp') throw new WebpUnsupportedError()
    if (blob.size <= maxBytes) return blob
  }
  return null
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface PreparedImage {
  purpose: 'BADGE' | 'INCIDENT'
  blob: Blob
  width: number
  height: number
  sha256: string
  previewUrl: string
}

export interface Crop {
  /** Esquina superior izquierda y lado del cuadrado, en píxeles de la imagen original. */
  sx: number
  sy: number
  size: number
}

function newCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas no disponible.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return { canvas, ctx }
}

/** Fotocheck: exactamente 512 × 512, WebP, ≤ 120 KB. */
export async function makeBadge(bitmap: ImageBitmap, crop: Crop): Promise<PreparedImage> {
  const { canvas, ctx } = newCanvas(BADGE_SIZE, BADGE_SIZE)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, BADGE_SIZE, BADGE_SIZE)
  ctx.drawImage(bitmap, crop.sx, crop.sy, crop.size, crop.size, 0, 0, BADGE_SIZE, BADGE_SIZE)
  const blob = await encodeWebp(canvas, BADGE_MAX_BYTES)
  if (!blob) throw new Error('No se pudo dejar el fotocheck por debajo de 120 KB.')
  return { purpose: 'BADGE', blob, width: BADGE_SIZE, height: BADGE_SIZE, sha256: await sha256Hex(blob), previewUrl: URL.createObjectURL(blob) }
}

/** Foto de incidencia: lado mayor entre 800 y 1600, WebP, ≤ 300 KB. */
export async function makeIncidentPhoto(bitmap: ImageBitmap): Promise<PreparedImage> {
  const long = Math.max(bitmap.width, bitmap.height)
  let target = Math.min(INCIDENT_MAX_SIDE, Math.max(INCIDENT_MIN_SIDE, long))
  for (;;) {
    const scale = target / long
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const { canvas, ctx } = newCanvas(w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await encodeWebp(canvas, INCIDENT_MAX_BYTES)
    if (blob) return { purpose: 'INCIDENT', blob, width: w, height: h, sha256: await sha256Hex(blob), previewUrl: URL.createObjectURL(blob) }
    if (target <= INCIDENT_MIN_SIDE) throw new Error('No se pudo dejar la foto por debajo de 300 KB.')
    target = Math.max(INCIDENT_MIN_SIDE, Math.round(target * 0.85))
  }
}
