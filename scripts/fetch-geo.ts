/**
 * fetch-geo.ts
 *
 * Pulls Ireland's county boundaries and the major Irish rivers from Overpass,
 * simplifies them with turf, and writes two bundled GeoJSON files:
 *
 *   src/geo/ireland.json  – FeatureCollection of county polygons (name, jurisdiction)
 *                           plus one dissolved "island" feature used for the land fill
 *   src/geo/rivers.json   – FeatureCollection of MultiLineStrings, one per river name
 *
 * Run with:  pnpm geo:fetch
 * Both outputs are committed, so the app never calls Overpass at runtime.
 */
import { writeFileSync, mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import osmtogeojson from 'osmtogeojson'
import * as turf from '@turf/turf'
import type { Feature, FeatureCollection, MultiPolygon, Polygon, MultiLineString, LineString } from 'geojson'

const OVERPASS_MIRRORS = [
  process.env.OVERPASS_URL,
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter((u): u is string => !!u)
const OUT_DIR = resolve(process.cwd(), 'src/geo')

// OSM relation ids: Republic of Ireland = 62273, Northern Ireland = 156393.
// Overpass area ids are relation id + 3_600_000_000.
const ROI_AREA = 3600062273
const NI_AREA = 3600156393

const RIVER_NAMES = [
  'Shannon', 'Suir', 'Nore', 'Barrow', 'Lee', 'Blackwater', 'Liffey', 'Dodder', 'Boyne',
  'Slaney', 'Moy', 'Corrib', 'Erne', 'Bann', 'Foyle', 'Lagan', 'Bandon', 'Feale', 'Maigue',
  'Fergus', 'Clare', 'Deel', 'Brosna', 'Inny', 'Suck', 'Mulkear', 'Avonmore', 'Avoca', 'Tolka',
  'Dargle', 'Garavogue', 'Bonet', 'Finn', 'Mourne', 'Laune', 'Flesk', 'Maine', 'Ilen', 'Bride',
  'Funshion', 'Nenagh', 'Little Brosna', 'Robe', 'Unshin', 'Owenmore', 'Ballisodare', 'Swilly',
  'Dee', 'Glyde', 'Fane', 'Nanny', 'Vartry', 'Derreen', 'Tar', 'Anner', 'Kings', 'Dinin',
  'Owenabue', 'Sullane', 'Awbeg', 'Camoge', 'Loobagh', 'Galey', 'Cashen', 'Inagh', 'Clodiagh',
  'Multeen', 'Camlin', 'Rye Water', 'Ward', 'Owennacurra', 'Argideen', 'Owvane', 'Roughty',
  'Caragh', 'Gweebarra', 'Leannan', 'Drowes', 'Duff', 'Cavan', 'Annalee', 'Dromore', 'Aherlow',
]

async function overpass(query: string): Promise<unknown> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS_MIRRORS[attempt % OVERPASS_MIRRORS.length]
    const started = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'floodline-geo/0.1 (scripts/fetch-geo.ts)' },
        body: 'data=' + encodeURIComponent(query),
      })
      if (!res.ok) throw new Error(`Overpass ${res.status} from ${url}: ${(await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`)
      const json = await res.json()
      console.log(`  overpass ok (${url}) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
      return json
    } catch (e) {
      lastErr = e as Error
      console.warn(`  attempt ${attempt + 1} failed: ${lastErr.message}`)
      await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)))
    }
  }
  throw lastErr
}

function round(fc: FeatureCollection, places = 4): FeatureCollection {
  return turf.truncate(fc, { precision: places, coordinates: 2, mutate: true }) as FeatureCollection
}

function kb(path: string) {
  return (statSync(path).size / 1024).toFixed(0) + ' KB'
}

async function fetchCounties(): Promise<FeatureCollection<Polygon | MultiPolygon>> {
  console.log('→ counties (Republic of Ireland, admin_level=6)')
  const roiRaw = await overpass(`
    [out:json][timeout:300];
    relation["boundary"="administrative"]["admin_level"="6"](area:${ROI_AREA});
    out geom;
  `)
  console.log('→ counties (Northern Ireland, by name)')
  const niRaw = await overpass(`
    [out:json][timeout:300];
    relation["name"~"^County (Antrim|Armagh|Down|Fermanagh|Londonderry|Tyrone)$"](area:${NI_AREA});
    out geom;
  `)

  const features: Feature<Polygon | MultiPolygon>[] = []
  for (const [raw, jurisdiction] of [[roiRaw, 'IE'], [niRaw, 'NI']] as const) {
    const gj = osmtogeojson(raw as never) as FeatureCollection
    for (const f of gj.features) {
      if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue
      const name = String((f.properties as Record<string, unknown>)?.name ?? '')
        .replace(/^County /, '')
        .replace(/^Contae /, '')
      if (!name) continue
      features.push({
        type: 'Feature',
        geometry: f.geometry as Polygon | MultiPolygon,
        properties: { name, jurisdiction },
      })
    }
  }
  console.log(`  ${features.length} county polygons`)
  return turf.featureCollection(features)
}

async function fetchRivers(): Promise<FeatureCollection<MultiLineString>> {
  console.log('→ rivers')
  // POSIX-safe regex (no \s / \b): word-bounded name, optional "River " prefix or " River" suffix.
  const alternation = RIVER_NAMES.map((n) => n.replace(/ /g, ' ')).join('|')
  const regex = `^(River |An |Abhainn na |Abhainn )?(${alternation})( River)?$`
  const raw = await overpass(`
    [out:json][timeout:300];
    area(${ROI_AREA})->.roi;
    area(${NI_AREA})->.ni;
    (.roi; .ni;)->.ie;
    way["waterway"="river"]["name"~"${regex}",i](area.ie);
    out geom;
  `)
  const gj = osmtogeojson(raw as never) as FeatureCollection
  const byName = new Map<string, LineString[]>()
  for (const f of gj.features) {
    if (f.geometry.type !== 'LineString') continue
    const rawName = String((f.properties as Record<string, unknown>)?.name ?? '')
    const canon = RIVER_NAMES.find((n) => new RegExp(`(^|\\s)${n}(\\s|$)`, 'i').test(rawName)) ?? rawName
    const list = byName.get(canon) ?? []
    list.push(f.geometry)
    byName.set(canon, list)
  }
  const features: Feature<MultiLineString>[] = [...byName.entries()].map(([name, lines]) => ({
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: lines.map((l) => l.coordinates) },
    properties: { name, major: /^(Shannon|Suir|Nore|Barrow|Lee|Blackwater|Liffey|Boyne|Slaney|Moy|Corrib|Erne|Bann|Foyle)$/.test(name) ? 1 : 0 },
  }))
  console.log(`  ${features.length} rivers, ${gj.features.length} ways`)
  return turf.featureCollection(features)
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] // counties | rivers

  if (only !== 'rivers') await buildCounties()
  if (only !== 'counties') await buildRivers()
}

async function buildCounties() {
  const counties = await fetchCounties()
  const simplifiedCounties = turf.simplify(counties, { tolerance: 0.004, highQuality: false, mutate: true })

  // Dissolve the counties into a single island outline for the land fill.
  let island: Feature<Polygon | MultiPolygon> | null = null
  for (const f of simplifiedCounties.features) {
    try {
      island = island ? (turf.union(turf.featureCollection([island, f])) as Feature<Polygon | MultiPolygon>) : f
    } catch (e) {
      console.warn(`  union failed for ${f.properties?.name}: ${(e as Error).message}`)
    }
  }
  const outlineFeatures: Feature[] = [...simplifiedCounties.features]
  if (island) outlineFeatures.push({ ...island, properties: { name: 'Ireland', kind: 'island' } })
  const irelandOut = round(turf.featureCollection(outlineFeatures))
  const irelandPath = resolve(OUT_DIR, 'ireland.json')
  writeFileSync(irelandPath, JSON.stringify(irelandOut))
  console.log(`  wrote ${irelandPath} (${kb(irelandPath)})`)
}

async function buildRivers() {
  const rivers = await fetchRivers()
  const simplifiedRivers = turf.simplify(rivers, { tolerance: 0.0015, highQuality: false, mutate: true })
  const riversPath = resolve(OUT_DIR, 'rivers.json')
  writeFileSync(riversPath, JSON.stringify(round(simplifiedRivers)))
  console.log(`  wrote ${riversPath} (${kb(riversPath)})`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
