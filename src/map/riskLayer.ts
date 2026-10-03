import { useEffect, useRef } from 'react'
import { Popup, type ExpressionSpecification, type GeoJSONSource, type Map as MLMap, type MapLayerMouseEvent } from 'maplibre-gl'
import type { RiskPoint } from '../api/types'
import { STATUS_COLOR, STATUS_LABEL } from '../lib/status'
import { addLayerOrdered } from './order'

const SOURCE = 'risk'

const colorExpr = [
  'match',
  ['get', 'status'],
  'FILL_NOW', STATUS_COLOR.FILL_NOW,
  'PREPARE', STATUS_COLOR.PREPARE,
  'WATCH', STATUS_COLOR.WATCH,
  STATUS_COLOR.CLEAR,
] as const

/**
 * Radius grows with risk_score and with zoom. `scale`/`add` let the halo and
 * selection ring derive from the same curve while keeping the zoom
 * interpolate at the top level (a MapLibre requirement).
 */
const radiusExpr = (scale = 1, add = 0): ExpressionSpecification => {
  const stop = (base: number, k: number): ExpressionSpecification => ['+', add, ['*', scale, ['+', base, ['*', k, ['get', 'risk_score']]]]]
  return ['interpolate', ['linear'], ['zoom'], 5, stop(2.5, 5), 8, stop(4, 9), 12, stop(7, 16)]
}

export function riskToGeoJSON(points: RiskPoint[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({
        type: 'Feature',
        id: p.station_id,
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          station_id: p.station_id,
          name: p.name,
          county: p.county,
          status: p.status,
          risk_score: Math.max(0, Math.min(1, p.risk_score ?? 0)),
          p24: p.p24 ?? 0,
        },
      })),
  }
}

/**
 * One circle per station, coloured by status, radius by risk score, with a
 * pulsing halo for PREPARE / FILL_NOW. Hover → popup; click → select station.
 */
export function useRiskLayer(map: MLMap | null, points: RiskPoint[] | undefined, selectedId: string | null, onSelect: (id: string) => void) {
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  // source + layers + interactions
  useEffect(() => {
    if (!map) return
    if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data: riskToGeoJSON([]), promoteId: 'station_id' })

    addLayerOrdered(map, {
      id: 'risk-halo',
      type: 'circle',
      source: SOURCE,
      filter: ['in', ['get', 'status'], ['literal', ['FILL_NOW', 'PREPARE']]],
      paint: {
        'circle-color': colorExpr as unknown as string,
        'circle-radius': radiusExpr(),
        'circle-opacity': 0.5,
        'circle-blur': 0.6,
        'circle-pitch-alignment': 'map',
      },
    })
    addLayerOrdered(map, {
      id: 'risk-points',
      type: 'circle',
      source: SOURCE,
      paint: {
        'circle-color': colorExpr as unknown as string,
        'circle-radius': radiusExpr(),
        'circle-opacity': ['match', ['get', 'status'], 'CLEAR', 0.22, 0.95],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['match', ['get', 'status'], 'CLEAR', 0, 1],
        'circle-stroke-opacity': 0.7,
      },
    })
    addLayerOrdered(map, {
      id: 'risk-selected',
      type: 'circle',
      source: SOURCE,
      filter: ['==', ['get', 'station_id'], '__none__'],
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': radiusExpr(1, 5),
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-stroke-opacity': 0.9,
      },
    })

    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: '240px' })
    const onMove = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      map.getCanvas().style.cursor = 'pointer'
      const p = f.properties as { name: string; county: string; status: keyof typeof STATUS_COLOR; p24: number }
      const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number]
      popup
        .setLngLat(coords)
        .setHTML(
          `<div style="font-weight:600;font-size:13px">${esc(p.name)}</div>` +
            `<div style="opacity:.7;font-size:11px;margin-bottom:4px">${esc(p.county)}</div>` +
            `<div style="display:flex;gap:10px;align-items:center">` +
            `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:99px;background:${STATUS_COLOR[p.status] ?? STATUS_COLOR.CLEAR}"></span>${STATUS_LABEL[p.status] ?? p.status}</span>` +
            `<span style="opacity:.85">P24 <b>${Math.round((Number(p.p24) || 0) * 100)}%</b></span></div>`,
        )
        .addTo(map)
    }
    const onLeave = () => {
      map.getCanvas().style.cursor = ''
      popup.remove()
    }
    const onClick = (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.station_id as string | undefined
      if (id) onSelectRef.current(id)
    }
    map.on('mousemove', 'risk-points', onMove)
    map.on('mouseleave', 'risk-points', onLeave)
    map.on('click', 'risk-points', onClick)

    // pulsing halo
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      if (!map.getLayer('risk-halo')) return
      const phase = ((now - start) % 1800) / 1800
      map.setPaintProperty('risk-halo', 'circle-radius', radiusExpr(1 + 1.6 * phase))
      map.setPaintProperty('risk-halo', 'circle-opacity', 0.55 * (1 - phase))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      popup.remove()
      map.off('mousemove', 'risk-points', onMove)
      map.off('mouseleave', 'risk-points', onLeave)
      map.off('click', 'risk-points', onClick)
    }
  }, [map])

  // data
  useEffect(() => {
    if (!map || !points) return
    const src = map.getSource(SOURCE) as GeoJSONSource | undefined
    src?.setData(riskToGeoJSON(points))
  }, [map, points])

  // selection ring
  useEffect(() => {
    if (!map || !map.getLayer('risk-selected')) return
    map.setFilter('risk-selected', ['==', ['get', 'station_id'], selectedId ?? '__none__'])
  }, [map, selectedId])
}

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
