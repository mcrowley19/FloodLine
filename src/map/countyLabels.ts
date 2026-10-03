import { useEffect } from 'react'
import { Marker, type Map as MLMap } from 'maplibre-gl'
import area from '@turf/area'
import centerOfMass from '@turf/center-of-mass'
import { polygon } from '@turf/helpers'
import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson'

/** County names as small uppercase HTML markers at each county's centre of mass. */
export function useCountyLabels(map: MLMap | null, ireland: FeatureCollection | null) {
  useEffect(() => {
    if (!map || !ireland) return
    const markers: Marker[] = []
    for (const f of ireland.features) {
      if (f.properties?.kind === 'island' || !f.properties?.name) continue
      if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue
      let c: [number, number]
      try {
        // Use the largest ring for multipolygons so islands do not pull the label offshore
        let geom = f.geometry as Polygon | MultiPolygon
        if (geom.type === 'MultiPolygon') {
          const biggest = geom.coordinates.reduce((a, b) => (area(polygon(a)) >= area(polygon(b)) ? a : b))
          geom = { type: 'Polygon', coordinates: biggest }
        }
        c = centerOfMass(geom).geometry.coordinates as [number, number]
      } catch {
        continue
      }
      const el = document.createElement('div')
      el.className = 'county-label'
      el.textContent = String(f.properties.name)
      markers.push(new Marker({ element: el, anchor: 'center' }).setLngLat(c).addTo(map))
    }
    const onZoom = () => {
      const z = map.getZoom()
      const op = z < 5.5 ? 0 : z > 10 ? 0.15 : 0.3
      const size = Math.min(13, 9 + (z - 5) * 1.2)
      for (const m of markers) {
        const el = m.getElement()
        el.style.opacity = String(op)
        el.style.fontSize = `${size}px`
      }
    }
    onZoom()
    map.on('zoom', onZoom)
    return () => {
      map.off('zoom', onZoom)
      markers.forEach((m) => m.remove())
    }
  }, [map, ireland])
}
