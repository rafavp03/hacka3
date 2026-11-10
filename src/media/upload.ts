import { env } from '../env'
import { ApiError, errorMessage, isRecord } from '../lib/errors'
import { request } from '../lib/http'
import { MediaSchema, MediaTicketSchema, type Media, type MediaTicket } from '../lib/schemas'
import { createStore, type Store } from '../lib/store'
import { isAbortError } from '../lib/time'
import type { PreparedImage } from './image'

export type UploadStage = 'ticket' | 'uploading' | 'confirming' | 'done' | 'error' | 'canceled'

export interface UploadState {
  stage: UploadStage
  /** 0..1, real (eventos de progreso de XMLHttpRequest). */
  progress: number
  error: string | null
  media: Media | null
}

class StorageError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Sube el archivo exacto a la ruta del ticket con XMLHttpRequest (para tener progreso de subida). */
function uploadToStorage(ticket: MediaTicket, blob: Blob, onProgress: (p: number) => void, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let publicUrl = ''
    if (ticket.provider === 'SUPABASE') {
      const bucket = ticket.bucket ?? env.supabase.bucket
      const path = (ticket.objectPath ?? '').split('/').map(encodeURIComponent).join('/')
      xhr.open('POST', `${env.supabase.url}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`)
      xhr.setRequestHeader('apikey', env.supabase.publishableKey)
      // La clave publicable nueva (sb_publishable_…) no es un JWT: va solo en `apikey`. El JWT anon antiguo, también como Bearer.
      if (env.supabase.publishableKey.startsWith('eyJ')) {
        xhr.setRequestHeader('Authorization', `Bearer ${env.supabase.publishableKey}`)
      }
      xhr.setRequestHeader('Content-Type', 'image/webp')
      xhr.setRequestHeader('x-upsert', 'false')
      publicUrl = `${env.supabase.url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${path}`
    } else {
      xhr.open('POST', `https://api.cloudinary.com/v1_1/${encodeURIComponent(env.cloudinary.cloudName)}/image/upload`)
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      const ok = xhr.status >= 200 && xhr.status < 300
      if (ticket.provider === 'SUPABASE') {
        // Reintento de una subida que ya había llegado: el archivo existe en la ruta del ticket.
        const duplicate = (xhr.status === 409 || xhr.status === 400) && /duplicate|already exists/i.test(xhr.responseText)
        if (ok || duplicate) resolve(publicUrl)
        else reject(new StorageError(xhr.status, `El storage rechazó la subida (${xhr.status}).`))
        return
      }
      try {
        const body = JSON.parse(xhr.responseText) as unknown
        if (ok && isRecord(body) && typeof body.secure_url === 'string') resolve(body.secure_url)
        else {
          const msg = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' ? body.error.message : `HTTP ${xhr.status}`
          reject(new StorageError(xhr.status, `Cloudinary rechazó la subida: ${msg}`))
        }
      } catch {
        reject(new StorageError(xhr.status, `Cloudinary respondió algo inesperado (${xhr.status}).`))
      }
    }
    xhr.onerror = () => reject(new StorageError(0, 'Falló la red durante la subida.'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    if (ticket.provider === 'SUPABASE') {
      xhr.send(blob)
    } else {
      const form = new FormData()
      form.append('file', blob, 'image.webp')
      form.append('upload_preset', env.cloudinary.uploadPreset)
      form.append('public_id', ticket.uploadPublicId ?? '')
      xhr.send(form)
    }
  })
}

/**
 * Una subida: ticket → storage (con progreso) → confirmación. Se puede cancelar y reintentar: el reintento reusa el
 * ticket y la subida ya hecha cuando sirven, y si no, empieza de nuevo.
 */
export class UploadJob {
  readonly image: PreparedImage
  readonly state: Store<UploadState> = createStore<UploadState>({ stage: 'ticket', progress: 0, error: null, media: null })
  private ticket: MediaTicket | null = null
  private uploadedUrl: string | null = null
  private ctl: AbortController | null = null

  constructor(image: PreparedImage) {
    this.image = image
  }

  start() {
    void this.run()
  }

  cancel() {
    this.ctl?.abort()
    this.state.set((s) => (s.stage === 'done' ? s : { ...s, stage: 'canceled', error: null }))
  }

  retry() {
    const s = this.state.get().stage
    if (s === 'error' || s === 'canceled') void this.run()
  }

  private async run() {
    const ctl = new AbortController()
    this.ctl = ctl
    const set = (patch: Partial<UploadState>) => this.state.set((s) => ({ ...s, ...patch }))
    try {
      if (!this.ticket || Date.parse(this.ticket.expiresAt) - Date.now() < 30_000) {
        this.uploadedUrl = null
        set({ stage: 'ticket', error: null, progress: 0 })
        const { data } = await request(
          '/media/tickets',
          {
            method: 'POST',
            signal: ctl.signal,
            retries: 3,
            retryNetwork: true,
            body: {
              purpose: this.image.purpose,
              contentType: 'image/webp',
              bytes: this.image.blob.size,
              sha256: this.image.sha256,
              width: this.image.width,
              height: this.image.height,
            },
          },
          (v) => MediaTicketSchema.parse(v),
        )
        this.ticket = data
      }
      if (!this.uploadedUrl) {
        set({ stage: 'uploading', error: null, progress: 0 })
        this.uploadedUrl = await uploadToStorage(this.ticket, this.image.blob, (p) => set({ progress: p }), ctl.signal)
        set({ progress: 1 })
      }
      set({ stage: 'confirming', error: null })
      const { data: media } = await request(
        `/media/tickets/${encodeURIComponent(this.ticket.ticketId)}/confirm`,
        { method: 'POST', signal: ctl.signal, body: { url: this.uploadedUrl }, retries: 3, retryNetwork: true },
        (v) => MediaSchema.parse(v),
      )
      set({ stage: 'done', media, error: null, progress: 1 })
    } catch (e) {
      if (isAbortError(e) || ctl.signal.aborted) {
        set({ stage: 'canceled', error: null })
        return
      }
      let text = errorMessage(e)
      if (e instanceof ApiError) {
        const reason = isRecord(e.details) && typeof e.details.reason === 'string' ? e.details.reason : null
        if (e.code === 'MEDIA_VERIFICATION_FAILED') {
          text = `Lumon rechazó la imagen${reason ? ` (${reason})` : ''}.`
          // Hay que volver a empezar con un ticket nuevo.
          this.ticket = null
          this.uploadedUrl = null
        }
        if (e.code === 'TICKET_EXPIRED') {
          this.ticket = null
          this.uploadedUrl = null
          text = 'El ticket venció. Reintenta para pedir uno nuevo.'
        }
      }
      if (e instanceof StorageError && e.status >= 400 && e.status < 500) {
        this.ticket = null
        this.uploadedUrl = null
      }
      set({ stage: 'error', error: text })
    }
  }
}
