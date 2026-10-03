import { useEffect, useRef } from 'react'
import { Popup, type GeoJSONSource, type Map as MLMap, type MapLayerMouseEvent } from 'maplibre-gl'
import type { FloodFeatureCollection } from '../api/types'
import { addLayerOrdered, setVisible } from './order'
import { ensureHatchImage, HATCH_IMAGE_ID } from './hatch'
import { fmtUtcLong, parseIso } from '../lib/time'
import { FLOOD } from './observedFloodLayer'

const SOURCE = 'demo-sat'
const IDS = ['demo-sat-fill', 'demo-sat-hatch', 'demo-sat-line']
const EMPTY: FloodFeatureCollection = { type: 'FeatureCollection', features: [] }
const FADE_MS = 300

const op = ['coalesce', ['feature-state', 'o'], 0] as const

/**
 * Demo-mode satellite polygons (EMSR860). Opacity is driven per feature through
 * feature-state so each polygon fades in over 300 ms once the scrubber crosses
 * its acquisition_utc.
 */
export function useDemoSatelliteLayer(map: MLMap | null, fc: FloodFeatureCollection | null | undefined, atMs: number | null, visible: boolean) {
  const opacities = useRef(new Map<string, number>())
  const raf = useRef(0)

  useEffect(() => {
    if (!map) return
    let cancelled = false
    if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data: EMPTY, promoteId: 'id' })
    ensureHatchImage(map).then(() => {
      if (cancelled) return
      addLayerOrdered(map, {
        id: 'demo-sat-fill',
        type: 'fill',
        source: SOURCE,
        paint: { 'fill-color': FLOOD, 'fill-opacity': ['*', 0.35, op] as unknown as number },
      })
      addLayerOrdered(map, {
        id: 'demo-sat-hatch',
        type: 'fill',
        source: SOURCE,
        paint: { 'fill-pattern': HATCH_IMAGE_ID, 'fill-opacity': ['*', 0.55, op] as unknown as number },
      })
      addLayerOrdered(map, {
        id: 'demo-sat-line',
        type: 'line',
        source: SOURCE,
        paint: { 'line-color': FLOOD, 'line-width': 1, 'line-opacity': ['*', 0.9, op] as unknown as number },
      })
    })

    const popup = new Popup({ closeButton: true, closeOnClick: true, offset: 8, maxWidth: '260px' })
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.find((x) => (opacities.current.get(String(x.id)) ?? 0) > 0.05)
      if (!f) return
      const p = f.properties as Record<string, unknown>
      const acq = parseIso(p.acquisition_utc as string | undefined)
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-weight:600;font-size:13px">${String(p.aoi_name ?? 'EMSR860 AOI')}</div>` +
            `<div style="opacity:.75;font-size:11px">Acquired ${acq ? fmtUtcLong(acq) : 'unknown'}</div>`,
        )
        .addTo(map)
    }
    const onEnter = () => (map.getCanvas().style.cursor = 'pointer')
    const onLeave = () => (map.getCanvas().style.cursor = '')
    map.on('click', 'demo-sat-fill', onClick)
    map.on('mouseenter', 'demo-sat-fill', onEnter)
    map.on('mouseleave', 'demo-sat-fill', onLeave)
    return () => {
      cancelled = true
      popup.remove()
      map.off('click', 'demo-sat-fill', onClick)
      map.off('mouseenter', 'demo-sat-fill', onEnter)
      map.off('mouseleave', 'demo-sat-fill', onLeave)
    }
  }, [map])

  // data
  useEffect(() => {
    if (!map) return
    const src = map.getSource(SOURCE) as GeoJSONSource | undefined
    src?.setData(fc ?? EMPTY)
    // re-apply known opacities so already-visible polygons do not flash
    for (const f of fc?.features ?? []) {
      const id = String(f.id ?? f.properties?.id)
      map.setFeatureState({ source: SOURCE, id }, { o: opacities.current.get(id) ?? 0 })
    }
  }, [map, fc])

  // fade toward targets whenever the scrubber time or data changes
  useEffect(() => {
    if (!map) return
    const targets = new Map<string, number>()
    for (const f of fc?.features ?? []) {
      const id = String(f.id ?? f.properties?.id)
      const acq = parseIso(f.properties?.acquisition_utc)
      targets.set(id, visible && atMs != null && (acq == null || acq <= atMs) ? 1 : 0)
    }
    const from = new Map<string, number>()
    for (const id of targets.keys()) from.set(id, opacities.current.get(id) ?? 0)
    const needs = [...targets].filter(([id, t]) => Math.abs((from.get(id) ?? 0) - t) > 0.001)
    if (needs.length === 0) return
    const start = performance.now()
    cancelAnimationFrame(raf.current)
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / FADE_MS)
      const ease = k * (2 - k)
      for (const [id, t] of needs) {
        const o = (from.get(id) ?? 0) + ((t - (from.get(id) ?? 0)) * ease)
        opacities.current.set(id, o)
        if (map.getSource(SOURCE)) map.setFeatureState({ source: SOURCE, id }, { o })
      }
      if (k < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
  }, [map, fc, atMs, visible])

  useEffect(() => {
    if (!map) return
    const apply = () => setVisible(map, IDS, visible)
    apply()
    map.once('idle', apply)
    return () => {
      map.off('idle', apply)
    }
  }, [map, visible])
}
