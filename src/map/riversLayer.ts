import { useEffect } from 'react'
import type { Map as MLMap, ExpressionSpecification } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { addLayerOrdered, setVisible } from './order'

const RIVER = '#4FC3F7'
const IDS = ['rivers-glow', 'rivers']

const width = (major: number, minor: number): ExpressionSpecification => ['case', ['==', ['get', 'major'], 1], major, minor]

/** Bright blue river lines with a faint outer glow; width scales with zoom. */
export function useRiversLayer(map: MLMap | null, rivers: FeatureCollection | null, visible: boolean) {
  useEffect(() => {
    if (!map || !rivers) return
    if (!map.getSource('rivers')) map.addSource('rivers', { type: 'geojson', data: rivers })
    addLayerOrdered(map, {
      id: 'rivers-glow',
      type: 'line',
      source: 'rivers',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': RIVER,
        'line-opacity': 0.22,
        'line-blur': 4,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, width(3, 1.5), 8, width(6, 3.5), 12, width(12, 7), 15, width(20, 12)],
      },
    })
    addLayerOrdered(map, {
      id: 'rivers',
      type: 'line',
      source: 'rivers',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': RIVER,
        'line-opacity': 0.9,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, width(1, 0.5), 8, width(2, 1.1), 12, width(3.5, 2.2), 15, width(6, 3.5)],
      },
    })
  }, [map, rivers])

  useEffect(() => {
    if (!map) return
    setVisible(map, IDS, visible)
  }, [map, visible, rivers])
}
