import { useStore } from '../lib/store'
import { Button, ProgressBar } from '../components/ui'
import type { UploadJob } from './upload'

const LABEL: Record<string, string> = {
  ticket: 'Pidiendo permiso de subida…',
  uploading: 'Subiendo…',
  confirming: 'Lumon está verificando la imagen…',
  done: 'Confirmada',
  error: 'Error',
  canceled: 'Cancelada',
}

export function UploadProgress({ job, name }: { job: UploadJob; name: string }) {
  const s = useStore(job.state)
  const active = s.stage === 'ticket' || s.stage === 'uploading' || s.stage === 'confirming'
  return (
    <div className="flex flex-col gap-2 text-sm" aria-live="polite">
      <ProgressBar value={s.progress} label={`Subida de ${name}`} />
      <p className={s.stage === 'error' ? 'text-rose-300' : s.stage === 'done' ? 'text-emerald-300' : 'text-slate-200'}>
        {LABEL[s.stage]}
        {s.error ? ` ${s.error}` : ''}
      </p>
      <div className="flex gap-2">
        {active && (
          <Button variant="secondary" onClick={() => job.cancel()}>
            Cancelar
          </Button>
        )}
        {(s.stage === 'error' || s.stage === 'canceled') && (
          <Button variant="secondary" onClick={() => job.retry()}>
            Reintentar
          </Button>
        )}
      </div>
    </div>
  )
}
