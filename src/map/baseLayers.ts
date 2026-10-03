import { useEffect } from 'react'
import type { Map as MLMap } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { addLayerOrdered } from './order'

export const SEA = '#0B2A4A'
export const LAND = '#2C3A2E'

/**
 * Sea background + Ireland land fill + faint county borders.
 * The "sea" background layer is part of the initial style; this hook adds the
 * land and county layers from the bundled GeoJSON.
 */
export function useBaseLayers(map: MLMap | null, ireland: FeatureCollection | null) {
  useEffect(() => {
    if (!map || !ireland) return
    if (!map.getSource('ireland')) map.addSource('ireland', { type: 'geojson', data: ireland })
    addLayerOrdered(map, {
      id: 'land',
      type: 'fill',
      source: 'ireland',
      filter: ['==', ['get', 'kind'], 'island'],
      paint: { 'fill-color': LAND, 'fill-opacity': 1, 'fill-opacity-transition': { duration: 300 } },
    })
    addLayerOrdered(map, {
      id: 'county-line',
      type: 'line',
      source: 'ireland',
      filter: ['!=', ['get', 'kind'], 'island'],
      paint: {
        'line-color': '#ffffff',
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.05, 9, 0.12],
        'line-width': 0.6,
      },
    })
  }, [map, ireland])
}
