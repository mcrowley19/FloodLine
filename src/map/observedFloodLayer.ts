import { useEffect } from 'react'
import { Popup, type GeoJSONSource, type Map as MLMap, type MapLayerMouseEvent } from 'maplibre-gl'
import type { FloodFeatureCollection } from '../api/types'
import { addLayerOrdered, setVisible } from './order'
import { ensureHatchImage, HATCH_IMAGE_ID } from './hatch'
import { fmtUtcLong, parseIso } from '../lib/time'

export const FLOOD = '#7FE3FF'
const SOURCE = 'observed'
const IDS = ['observed-fill', 'observed-hatch', 'observed-line']
const EMPTY: FloodFeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Live Sentinel-1 observed-flood polygons: hatched cyan fill at 35 % with a
 * 1 px cyan outline. Visible from zoom 8 upward.
 */
export function useObservedFloodLayer(map: MLMap | null, fc: FloodFeatureCollection | null | undefined, visible: boolean) {
  useEffect(() => {
    if (!map) return
    let cancelled = false
    if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'geojson', data: EMPTY, promoteId: 'id' })
    ensureHatchImage(map).then(() => {
      if (cancelled) return
      addLayerOrdered(map, {
        id: 'observed-fill',
        type: 'fill',
        source: SOURCE,
        minzoom: 8,
        paint: { 'fill-color': FLOOD, 'fill-opacity': 0.35 },
      })
      addLayerOrdered(map, {
        id: 'observed-hatch',
        type: 'fill',
        source: SOURCE,
        minzoom: 8,
        paint: { 'fill-pattern': HATCH_IMAGE_ID, 'fill-opacity': 0.55 },
      })
      addLayerOrdered(map, {
        id: 'observed-line',
        type: 'line',
        source: SOURCE,
        minzoom: 8,
        paint: { 'line-color': FLOOD, 'line-width': 1, 'line-opacity': 0.9 },
      })
    })

    const popup = new Popup({ closeButton: true, closeOnClick: true, offset: 8, maxWidth: '260px' })
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      const p = f.properties as Record<string, unknown>
      const acq = parseIso(p.acquisition_utc as string | undefined)
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-weight:600;font-size:13px">${String(p.aoi_name ?? 'Observed flooding')}</div>` +
            `<div style="opacity:.75;font-size:11px">${String(p.source ?? 'Sentinel-1')}${acq ? ' · ' + fmtUtcLong(acq) : ''}</div>`,
        )
        .addTo(map)
    }
    const onEnter = () => (map.getCanvas().style.cursor = 'pointer')
    const onLeave = () => (map.getCanvas().style.cursor = '')
    map.on('click', 'observed-fill', onClick)
    map.on('mouseenter', 'observed-fill', onEnter)
    map.on('mouseleave', 'observed-fill', onLeave)
    return () => {
      cancelled = true
      popup.remove()
      map.off('click', 'observed-fill', onClick)
      map.off('mouseenter', 'observed-fill', onEnter)
      map.off('mouseleave', 'observed-fill', onLeave)
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const src = map.getSource(SOURCE) as GeoJSONSource | undefined
    src?.setData(fc ?? EMPTY)
  }, [map, fc])

  useEffect(() => {
    if (!map) return
    const apply = () => setVisible(map, IDS, visible)
    apply()
    // layers are added asynchronously after the hatch image loads
    map.once('idle', apply)
    return () => {
      map.off('idle', apply)
    }
  }, [map, visible])
}
