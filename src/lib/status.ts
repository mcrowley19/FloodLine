import type { Status } from '../api/types'

export const STATUS_COLOR: Record<Status, string> = {
  CLEAR: '#4FC3F7',
  WATCH: '#F5B942',
  PREPARE: '#FF8A3D',
  FILL_NOW: '#FF4D4F',
}

export const STATUS_LABEL: Record<Status, string> = {
  CLEAR: 'Clear',
  WATCH: 'Watch',
  PREPARE: 'Prepare',
  FILL_NOW: 'Fill now',
}

export const STATUS_RANK: Record<Status, number> = { FILL_NOW: 0, PREPARE: 1, WATCH: 2, CLEAR: 3 }

/** Tailwind-ish classes for a status pill */
export const STATUS_PILL: Record<Status, string> = {
  CLEAR: 'bg-sky-400/10 text-sky-200/70 border-sky-300/20',
  WATCH: 'bg-amber-400/15 text-amber-200 border-amber-300/30',
  PREPARE: 'bg-orange-500/15 text-orange-200 border-orange-300/30',
  FILL_NOW: 'bg-red-500/20 text-red-100 border-red-300/40',
}

export const isStatus = (s: unknown): s is Status => s === 'CLEAR' || s === 'WATCH' || s === 'PREPARE' || s === 'FILL_NOW'
