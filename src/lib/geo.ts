import * as turf from '@turf/turf'
import type { Feature, Polygon, MultiPolygon } from 'geojson'
import type { FloodFeatureCollection } from '../api/types'

/** Bounding box of the island of Ireland: minLon, minLat, maxLon, maxLat */
export const IRELAND_BBOX: [number, number, number, number] = [-10.75, 51.3, -5.3, 55.5]
export const IRELAND_BBOX_STR = IRELAND_BBOX.join(',')

export interface NearestFlood {
  distanceKm: number
  acquisition: string | null
  aoi: string | null
}

/**
 * Distance from a point to the nearest observed-flood polygon. Returns null
 * when there are no polygons. Distance is 0 when the point is inside a polygon.
 */
export function nearestFlood(lon: number, lat: number, fc: FloodFeatureCollection | null | undefined): NearestFlood | null {
  if (!fc || !fc.features?.length) return null
  const pt = turf.point([lon, lat])
  let best: NearestFlood | null = null
  for (const f of fc.features) {
    if (!f.geometry) continue
    const polys: Feature<Polygon>[] =
      f.geometry.type === 'Polygon'
        ? [turf.polygon(f.geometry.coordinates)]
        : (f.geometry as MultiPolygon).coordinates.map((c) => turf.polygon(c))
    for (const poly of polys) {
      let d: number
      try {
        if (turf.booleanPointInPolygon(pt, poly)) d = 0
        else d = turf.pointToLineDistance(pt, turf.polygonToLine(poly) as Feature<import('geojson').LineString>, { units: 'kilometers' })
      } catch {
        continue
      }
      if (!best || d < best.distanceKm) {
        best = {
          distanceKm: d,
          acquisition: (f.properties?.acquisition_utc as string | undefined) ?? null,
          aoi: (f.properties?.aoi_name as string | undefined) ?? null,
        }
      }
    }
  }
  return best
}

export const FLOOD_PROXIMITY_KM = 3
