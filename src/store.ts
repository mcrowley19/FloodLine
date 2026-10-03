import { create } from 'zustand'
import type { DemoTimeline } from './api/types'

export type Mode = 'live' | 'demo'
export type Tab = 'map' | 'lead' | 'data'

export interface LayerToggles {
  observed: boolean
  imagery: boolean
  rivers: boolean
}

export interface Toast {
  id: number
  kind: 'error' | 'info'
  message: string
}

interface State {
  mode: Mode
  tab: Tab
  selectedStationId: string | null
  layers: LayerToggles
  /** demo timeline, loaded when entering demo mode */
  timeline: DemoTimeline | null
  demoIndex: number
  demoPlaying: boolean
  demoLoading: boolean
  /** mobile bottom sheet expanded */
  sheetOpen: boolean
  toasts: Toast[]

  setTab: (tab: Tab) => void
  selectStation: (id: string | null) => void
  toggleLayer: (key: keyof LayerToggles) => void
  enterDemo: (timeline: DemoTimeline) => void
  exitDemo: () => void
  setDemoIndex: (i: number) => void
  stepDemo: (delta: number) => void
  setDemoPlaying: (p: boolean) => void
  setDemoLoading: (l: boolean) => void
  setSheetOpen: (o: boolean) => void
  pushToast: (kind: Toast['kind'], message: string) => void
  dismissToast: (id: number) => void
}

let toastSeq = 1

export const useStore = create<State>((set, get) => ({
  mode: 'live',
  tab: 'map',
  selectedStationId: null,
  layers: { observed: true, imagery: false, rivers: true },
  timeline: null,
  demoIndex: 0,
  demoPlaying: false,
  demoLoading: false,
  sheetOpen: false,
  toasts: [],

  setTab: (tab) => set({ tab }),
  selectStation: (id) => set({ selectedStationId: id, sheetOpen: id ? true : get().sheetOpen }),
  toggleLayer: (key) => set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),
  enterDemo: (timeline) => set({ mode: 'demo', timeline, demoIndex: 0, demoPlaying: false, selectedStationId: null }),
  exitDemo: () => set({ mode: 'live', timeline: null, demoIndex: 0, demoPlaying: false, demoLoading: false }),
  setDemoIndex: (i) => {
    const n = get().timeline?.steps.length ?? 0
    set({ demoIndex: Math.max(0, Math.min(n - 1, i)) })
  },
  stepDemo: (delta) => {
    const n = get().timeline?.steps.length ?? 0
    const next = get().demoIndex + delta
    if (next >= n) set({ demoIndex: n - 1, demoPlaying: false })
    else set({ demoIndex: Math.max(0, next) })
  },
  setDemoPlaying: (demoPlaying) => set({ demoPlaying }),
  setDemoLoading: (demoLoading) => set({ demoLoading }),
  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
  pushToast: (kind, message) => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.message !== message), { id, kind, message }] }))
    setTimeout(() => get().dismissToast(id), 6000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** Current demo timestamp (ISO) or null when live */
export const selectDemoAt = (s: State) => (s.mode === 'demo' && s.timeline ? s.timeline.steps[s.demoIndex] ?? null : null)
