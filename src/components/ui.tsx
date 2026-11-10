import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-cyan-300 text-slate-950 hover:bg-cyan-200 disabled:bg-slate-600 disabled:text-slate-300',
  secondary: 'border border-slate-500 text-slate-100 hover:bg-slate-800 disabled:text-slate-400',
  danger: 'bg-rose-300 text-slate-950 hover:bg-rose-200 disabled:bg-slate-600',
  ghost: 'text-cyan-200 hover:bg-slate-800 disabled:text-slate-500',
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', busy = false, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  )
})

export function Spinner({ small = false, label }: { small?: boolean; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none ${small ? 'h-3.5 w-3.5' : 'h-5 w-5'}`}
      />
      {label && <span>{label}</span>}
    </span>
  )
}

export function Alert({ kind = 'error', children, title }: { kind?: 'error' | 'info' | 'success' | 'warning'; children: ReactNode; title?: string }) {
  const styles = {
    error: 'border-rose-400 bg-rose-950/60 text-rose-100',
    info: 'border-cyan-400 bg-cyan-950/50 text-cyan-50',
    success: 'border-emerald-400 bg-emerald-950/50 text-emerald-50',
    warning: 'border-amber-400 bg-amber-950/50 text-amber-50',
  }[kind]
  return (
    <div role={kind === 'error' || kind === 'warning' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${styles}`}>
      {title && <p className="font-semibold">{title}</p>}
      <div>{children}</div>
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-slate-500 bg-slate-900 px-3 py-2 text-slate-100 placeholder:text-slate-400 focus:border-cyan-300 focus:outline-2 focus:outline-cyan-300 aria-[invalid=true]:border-rose-400'

export function Field({
  label,
  error,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId()
  const errId = `${id}-err`
  const hintId = `${id}-hint`
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-200">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errId : '', hint ? hintId : ''].filter(Boolean).join(' ') || undefined}
        className={inputCls}
      />
      {hint && (
        <p id={hintId} className="text-xs text-slate-300">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  )
}

export function TextArea({ label, error, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-200">
        {label}
      </label>
      <textarea id={id} {...rest} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} className={inputCls} />
      {error && (
        <p id={`${id}-err`} className="text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  )
}

export function Select({
  label,
  error,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; children: ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-200">
        {label}
      </label>
      <select id={id} {...rest} aria-invalid={error ? true : undefined} className={inputCls}>
        {children}
      </select>
      {error && <p className="text-sm text-rose-300">{error}</p>}
    </div>
  )
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold tracking-tight text-slate-50">{children}</h1>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-slate-700 bg-slate-900/70 p-4 ${className}`}>{children}</section>
}

export function ProgressBar({ value, label, className = '' }: { value: number; label: string; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 1000) / 10))
  return (
    <div className={className}>
      <div className="mb-1 flex justify-between text-xs text-slate-200">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded bg-slate-700">
        <div className="h-full bg-cyan-300 transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
