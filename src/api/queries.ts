import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api, ApiError } from './client'
import type { DemoTimeline, Settings } from './types'
import { useStore, selectDemoAt } from '../store'
import { IRELAND_BBOX_STR } from '../lib/geo'

const TEN_MIN = 10 * 60_000

/** Risk points: live /risk (refetched every 2 min) or /demo/risk?at= */
export function useRisk() {
  const demoAt = useStore(selectDemoAt)
  return useQuery({
    queryKey: demoAt ? ['demo', 'risk', demoAt] : ['risk'],
    queryFn: () => (demoAt ? api.demoRisk(demoAt) : api.risk()),
    refetchInterval: demoAt ? false : 2 * 60_000,
    staleTime: demoAt ? Infinity : 60_000,
    placeholderData: (prev) => prev,
  })
}

export function useLeadTimes() {
  const demoAt = useStore(selectDemoAt)
  return useQuery({
    queryKey: demoAt ? ['demo', 'lead-times', demoAt] : ['lead-times'],
    queryFn: () => (demoAt ? api.demoLeadTimes(demoAt) : api.leadTimes()),
    refetchInterval: demoAt ? false : 2 * 60_000,
    staleTime: demoAt ? Infinity : 60_000,
    placeholderData: (prev) => prev,
  })
}

export function useStationDetail(id: string | null) {
  const demoAt = useStore(selectDemoAt)
  return useQuery({
    queryKey: ['station', id, demoAt],
    queryFn: () => api.station(id!, demoAt ?? undefined),
    enabled: !!id,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
}

/**
 * Observed-flood polygons. Live: /satellite/latest for the given bbox, refetched
 * every 10 min (the map debounces bbox changes). Demo: /demo/satellite?at=.
 * Never throws into the UI – errors resolve to an "unavailable" response.
 */
export function useSatellite(bbox: string | null) {
  const demoAt = useStore(selectDemoAt)
  return useQuery({
    queryKey: demoAt ? ['demo', 'satellite', demoAt] : ['satellite', bbox],
    queryFn: async () => {
      try {
        return demoAt ? await api.demoSatellite(demoAt) : await api.satelliteLatest(bbox!)
      } catch (e) {
        return {
          status: 'unavailable' as const,
          reason: e instanceof ApiError ? e.message : 'request failed',
          observed_at: null,
          features: { type: 'FeatureCollection' as const, features: [] },
        }
      }
    },
    enabled: !!demoAt || !!bbox,
    refetchInterval: demoAt ? false : TEN_MIN,
    staleTime: demoAt ? Infinity : TEN_MIN,
    placeholderData: (prev) => prev,
    retry: false,
  })
}

/** Ireland-wide observed flood, used for proximity checks in the sidebar and lead-times table */
export function useSatelliteIreland() {
  return useSatellite(IRELAND_BBOX_STR)
}

export function useWms() {
  return useQuery({
    queryKey: ['satellite', 'wms'],
    queryFn: () => api.satelliteWms().catch(() => ({ available: false, reason: 'request failed' })),
    staleTime: Infinity,
    retry: false,
  })
}

export function useDataStatus() {
  return useQuery({ queryKey: ['data-status'], queryFn: api.dataStatus, staleTime: 60_000, refetchInterval: 5 * 60_000 })
}

export function useSaveSettings() {
  const qc = useQueryClient()
  const pushToast = useStore((s) => s.pushToast)
  return useMutation({
    mutationFn: (s: Settings) => api.saveSettings(s),
    onSuccess: () => {
      pushToast('info', 'Settings saved · recomputing decisions')
      qc.invalidateQueries({ queryKey: ['data-status'] })
      qc.invalidateQueries({ queryKey: ['risk'] })
      qc.invalidateQueries({ queryKey: ['lead-times'] })
      qc.invalidateQueries({ queryKey: ['station'] })
    },
    onError: (e) => pushToast('error', e instanceof Error ? e.message : 'Failed to save settings'),
  })
}

/** Preload every demo step so scrubbing is instant. Returns when all are cached. */
export async function preloadDemo(qc: ReturnType<typeof useQueryClient>, timeline: DemoTimeline, onProgress?: (done: number, total: number) => void) {
  const steps = timeline.steps
  const total = steps.length * 3
  let done = 0
  const tick = () => onProgress?.(++done, total)
  // Limit concurrency so we do not hammer the backend
  const queue = [...steps]
  const worker = async () => {
    while (queue.length) {
      const at = queue.shift()!
      await Promise.all([
        qc.prefetchQuery({ queryKey: ['demo', 'risk', at], queryFn: () => api.demoRisk(at), staleTime: Infinity }).then(tick),
        qc.prefetchQuery({ queryKey: ['demo', 'lead-times', at], queryFn: () => api.demoLeadTimes(at), staleTime: Infinity }).then(tick),
        qc.prefetchQuery({
          queryKey: ['demo', 'satellite', at],
          queryFn: () => api.demoSatellite(at).catch(() => ({ status: 'unavailable' as const, reason: 'request failed', observed_at: null, features: { type: 'FeatureCollection' as const, features: [] } })),
          staleTime: Infinity,
        }).then(tick),
      ])
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
}

/** Surface query errors as toasts (API down etc.) */
export function useErrorToast(error: unknown, label: string) {
  const pushToast = useStore((s) => s.pushToast)
  useEffect(() => {
    if (!error) return
    const msg = error instanceof ApiError && error.status === 0 ? error.message : `${label}: ${(error as Error).message ?? 'request failed'}`
    pushToast('error', msg)
  }, [error, label, pushToast])
}
