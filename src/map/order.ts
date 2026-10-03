import type { Map as MLMap, LayerSpecification } from 'maplibre-gl'

/**
 * Layer stack, bottom → top. Every layer added through `addLayerOrdered` is
 * inserted at its slot regardless of the order the React hooks mount in.
 */
export const LAYER_ORDER = [
  'sea',
  's2-wms',
  'land',
  'county-line',
  'rivers-glow',
  'rivers',
  'observed-fill',
  'observed-hatch',
  'observed-line',
  'demo-sat-fill',
  'demo-sat-hatch',
  'demo-sat-line',
  'risk-points',
  'risk-selected',
] as const

export type LayerId = (typeof LAYER_ORDER)[number]

export function addLayerOrdered(map: MLMap, layer: LayerSpecification & { id: LayerId }) {
  if (map.getLayer(layer.id)) return
  const idx = LAYER_ORDER.indexOf(layer.id)
  const before = LAYER_ORDER.slice(idx + 1).find((id) => map.getLayer(id))
  map.addLayer(layer, before)
}

export function removeLayers(map: MLMap, ids: string[], sourceId?: string) {
  for (const id of ids) if (map.getLayer(id)) map.removeLayer(id)
  if (sourceId && map.getSource(sourceId)) map.removeSource(sourceId)
}

export function setVisible(map: MLMap, ids: string[], visible: boolean) {
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
}
