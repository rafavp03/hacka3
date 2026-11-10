import { Spinner } from './ui'

export function Splash({ label }: { label: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center text-slate-200">
      <Spinner label={label} />
    </div>
  )
}
