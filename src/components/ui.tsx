import type { ReactNode } from 'react'
import type { Status } from '../api/types'
import { STATUS_COLOR, STATUS_LABEL, STATUS_PILL } from '../lib/status'

export function StatusPill({ status, small }: { status: Status; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap ${STATUS_PILL[status] ?? STATUS_PILL.CLEAR} ${small ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]'}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[status] ?? STATUS_COLOR.CLEAR }} />
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55">{children}</h3>
      {right}
    </div>
  )
}

export function Glass({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`glass ${className}`}>{children}</div>
}

/** Probability bar (0..1) coloured by status */
export function PBar({ value, status, className = '' }: { value: number; status: Status; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round((value || 0) * 100)))
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-white/10 ${className}`} title={`P24 ${pct}%`}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: STATUS_COLOR[status] ?? STATUS_COLOR.CLEAR }} />
    </div>
  )
}

export function Toggle({ label, checked, onChange, color }: { label: string; checked: boolean; onChange: () => void; color?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/80 transition hover:bg-white/10"
    >
      <span className={`relative h-3.5 w-6 rounded-full transition ${checked ? '' : 'bg-white/15'}`} style={checked ? { background: color ?? '#4FC3F7' } : undefined}>
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all ${checked ? 'left-3' : 'left-0.5'}`} />
      </span>
      {label}
    </button>
  )
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/15 px-4 py-8 text-center">
      <div className="text-sm font-medium text-white/80">{title}</div>
      {body && <div className="text-xs text-white/50">{body}</div>}
    </div>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/45">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-white/55">{sub}</div>}
    </div>
  )
}
