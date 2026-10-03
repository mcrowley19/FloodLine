const pad = (n: number) => String(n).padStart(2, '0')

export function parseIso(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/** "14:30 UTC" */
export function fmtUtcTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "27 Jan 00:00Z" */
export function fmtUtcShort(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
}

/** "Tue 27 Jan 2026, 00:00 UTC" */
export function fmtUtcLong(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** "Tue 27" */
export function fmtDayLabel(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}`
}

/** "14h ago", "3d ago", "in 2h" */
export function fmtRelative(ms: number, now: number): string {
  const diff = now - ms
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60_000)
  const hours = Math.round(abs / 3_600_000)
  const days = Math.round(abs / 86_400_000)
  let s: string
  if (mins < 2) s = 'just now'
  else if (mins < 60) s = `${mins}m`
  else if (hours < 48) s = `${hours}h`
  else s = `${days}d`
  if (s === 'just now') return s
  return diff >= 0 ? `${s} ago` : `in ${s}`
}

/** "~3h", "~1.5h", "~2d" */
export function fmtHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return '—'
  if (h < 0) return 'passed'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 10) return `${h.toFixed(1).replace(/\.0$/, '')}h`
  if (h < 72) return `${Math.round(h)}h`
  return `${(h / 24).toFixed(1).replace(/\.0$/, '')}d`
}

export function hoursBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / 3_600_000
}
