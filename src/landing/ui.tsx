import type { CSSProperties } from 'react'

export type Status = 'FILL NOW' | 'PREPARE' | 'WATCH'

/** Status colours are only ever used for risk. */
export const STATUS: Record<Status, { bg: string; fg: string }> = {
  'FILL NOW': { bg: '#FF5A4E', fg: '#2B0703' },
  PREPARE: { bg: '#FF9A3C', fg: '#2B1403' },
  WATCH: { bg: '#FFD166', fg: '#2B2003' },
}

export function StatusChip({ status, style }: { status: Status; style?: CSSProperties }) {
  return (
    <span className="chip mono" style={{ background: STATUS[status].bg, color: STATUS[status].fg, ...style }}>
      {status}
    </span>
  )
}

export function Logo({ size = 28, ring, fill, text = 22 }: { size?: number; ring: string; fill: string; text?: number }) {
  return (
    <>
      <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <circle cx="14" cy="14" r="12" stroke={ring} strokeWidth="1.8" />
        <path d="M2 15 A12 12 0 0 0 26 15 Z" fill={fill} />
        <path d="M3 15 q2.75 -2.4 5.5 0 t5.5 0 t5.5 0 t5.5 0" stroke={ring} strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span className="hd" style={{ fontSize: text, fontWeight: 700 }}>Floodline</span>
    </>
  )
}

/** The Sentinel-1 satellite glyph used in the data grid and the replay timeline. */
export function SatelliteIcon({ size = 24, stroke = 'currentColor', label }: { size?: number; stroke?: string; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d="M13 7 9 3 5 7l4 4" />
      <path d="m17 11 4 4-4 4-4-4" />
      <path d="m8 12 4 4 6-6-4-4Z" />
      <path d="M16 8l3-3" />
    </svg>
  )
}
