import { useEffect } from 'react'
import type { Map as MLMap } from 'maplibre-gl'
import type { WmsInfo } from '../api/types'
import { addLayerOrdered, removeLayers, setVisible } from './order'

const SOURCE = 's2'
export const S2_MIN_ZOOM = 11
export const COPERNICUS_ATTRIBUTION = 'Contains modified Copernicus Sentinel data'

function tileTemplate(wms: WmsInfo): string | null {
  if (wms.tile_url_template) return wms.tile_url_template
  if (!wms.url) return null
  const v = wms.version ?? '1.1.1'
  const crsParam = v.startsWith('1.3') ? 'CRS' : 'SRS'
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: v,
    REQUEST: 'GetMap',
    LAYERS: wms.layers ?? '',
    STYLES: wms.styles ?? '',
    FORMAT: wms.format ?? 'image/png',
    TRANSPARENT: 'true',
    WIDTH: '256',
    HEIGHT: '256',
    [crsParam]: 'EPSG:3857',
  })
  const sep = wms.url.includes('?') ? '&' : '?'
  return `${wms.url}${sep}${q.toString()}&BBOX={bbox-epsg-3857}`
}

/**
 * Sentinel-2 WMS context imagery. Shown only when the Imagery toggle is on AND
 * zoom ≥ 11; while shown, the land fill drops to 30 % so imagery shows through.
 */
export function useSentinel2Layer(map: MLMap | null, wms: WmsInfo | undefined, enabled: boolean) {
  const available = !!wms?.available && !!tileTemplate(wms)

  useEffect(() => {
    if (!map || !wms || !available) return
    const tiles = tileTemplate(wms)!
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, {
        type: 'raster',
        tiles: [tiles],
        tileSize: 256,
        minzoom: wms.min_zoom ?? 8,
        maxzoom: 16,
        attribution: wms.attribution ?? COPERNICUS_ATTRIBUTION,
      })
    }
    addLayerOrdered(map, {
      id: 's2-wms',
      type: 'raster',
      source: SOURCE,
      minzoom: S2_MIN_ZOOM,
      paint: { 'raster-opacity': 0.95, 'raster-fade-duration': 200 },
    })
    return () => {
      removeLayers(map, ['s2-wms'], SOURCE)
    }
  }, [map, wms, available])

  useEffect(() => {
    if (!map) return
    const on = enabled && available
    setVisible(map, ['s2-wms'], on)
    const applyLand = () => {
      if (!map.getLayer('land')) return
      const showing = on && map.getZoom() >= S2_MIN_ZOOM
      map.setPaintProperty('land', 'fill-opacity', showing ? 0.3 : 1)
    }
    applyLand()
    map.on('zoom', applyLand)
    map.once('idle', applyLand)
    return () => {
      map.off('zoom', applyLand)
      map.off('idle', applyLand)
    }
  }, [map, enabled, available])
}
