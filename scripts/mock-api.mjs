/**
 * Minimal mock of the Floodline backend for frontend development.
 *   pnpm mock        → http://localhost:8000
 * Shapes match src/api/types.ts. Data is synthetic.
 */
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 8000)
const H = 3_600_000

// id, name, county, river, lon, lat
const STATIONS = [
  ['25017', 'Athlone', 'Westmeath', 'Shannon', -7.9407, 53.4239],
  ['25030', 'Banagher', 'Offaly', 'Shannon', -7.9898, 53.1899],
  ['25001', 'Killaloe', 'Clare', 'Shannon', -8.4429, 52.8083],
  ['26007', 'Carrick-on-Shannon', 'Leitrim', 'Shannon', -8.0906, 53.9448],
  ['16011', 'Clonmel', 'Tipperary', 'Suir', -7.7035, 52.3553],
  ['16009', 'Cahir', 'Tipperary', 'Suir', -7.9270, 52.3745],
  ['16051', 'Carrick-on-Suir', 'Tipperary', 'Suir', -7.4150, 52.3449],
  ['15006', 'Kilkenny', 'Kilkenny', 'Nore', -7.2529, 52.6541],
  ['15005', 'Thomastown', 'Kilkenny', 'Nore', -7.1375, 52.5261],
  ['14018', 'Graiguenamanagh', 'Kilkenny', 'Barrow', -6.9533, 52.5413],
  ['14011', 'Carlow', 'Carlow', 'Barrow', -6.9305, 52.8365],
  ['19001', 'Cork · Lee Road', 'Cork', 'Lee', -8.5135, 51.9008],
  ['19020', 'Ballincollig', 'Cork', 'Lee', -8.5876, 51.8883],
  ['18002', 'Mallow', 'Cork', 'Blackwater', -8.6406, 52.1337],
  ['18003', 'Fermoy', 'Cork', 'Blackwater', -8.2761, 52.1385],
  ['18050', 'Lismore', 'Waterford', 'Blackwater', -7.9316, 52.1363],
  ['09001', 'Leixlip', 'Kildare', 'Liffey', -6.4936, 53.3650],
  ['09010', 'Lucan', 'Dublin', 'Liffey', -6.4487, 53.3568],
  ['09035', 'Rathfarnham', 'Dublin', 'Dodder', -6.2820, 53.2958],
  ['07012', 'Slane', 'Meath', 'Boyne', -6.5430, 53.7097],
  ['07009', 'Navan', 'Meath', 'Boyne', -6.6880, 53.6524],
  ['12001', 'Enniscorthy', 'Wexford', 'Slaney', -6.5661, 52.5024],
  ['12013', 'Tullow', 'Carlow', 'Slaney', -6.7360, 52.8030],
  ['34001', 'Ballina', 'Mayo', 'Moy', -9.1510, 54.1140],
  ['34009', 'Foxford', 'Mayo', 'Moy', -9.1130, 53.9810],
  ['30061', 'Galway · Wolfe Tone Br.', 'Galway', 'Corrib', -9.0567, 53.2720],
  ['30007', 'Claregalway', 'Galway', 'Clare', -8.9440, 53.3400],
  ['20002', 'Bandon', 'Cork', 'Bandon', -8.7414, 51.7460],
  ['23002', 'Listowel', 'Kerry', 'Feale', -9.4850, 52.4460],
  ['24008', 'Adare', 'Limerick', 'Maigue', -8.7905, 52.5650],
  ['27002', 'Ennis', 'Clare', 'Fergus', -8.9830, 52.8460],
  ['24082', 'Rathkeale', 'Limerick', 'Deel', -8.9390, 52.5230],
  ['25006', 'Ferbane', 'Offaly', 'Brosna', -7.8180, 53.2690],
  ['26019', 'Mullingar', 'Westmeath', 'Brosna', -7.3380, 53.5260],
  ['26002', 'Ballinasloe', 'Galway', 'Suck', -8.2220, 53.3280],
  ['36018', 'Cavan', 'Cavan', 'Erne', -7.3610, 53.9910],
  ['35005', 'Sligo', 'Sligo', 'Garavogue', -8.4740, 54.2720],
  ['39001', 'Letterkenny', 'Donegal', 'Swilly', -7.7350, 54.9530],
  ['06013', 'Dundalk', 'Louth', 'Castletown', -6.4100, 54.0010],
  ['10021', 'Bray', 'Wicklow', 'Dargle', -6.1090, 53.2050],
].map(([id, name, county, river, lon, lat]) => ({ id, name, county, river, lon, lat, p95: 2 + ((hash(id) % 200) / 100) }))

function hash(s) {
  let h = 2166136261
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  return h
}
const rnd = (seed) => ((hash(seed) % 10000) / 10000)

// Storm Chandra timeline
const START = Date.parse('2026-01-22T00:00:00Z')
const END = Date.parse('2026-01-30T00:00:00Z')
const LANDFALL = Date.parse('2026-01-27T00:00:00Z')
const STEPS = []
for (let t = START; t <= END; t += 6 * H) STEPS.push(new Date(t).toISOString())
const ACQ = [
  { acquisition_utc: '2026-01-27T06:30:00Z', aoi_name: 'EMSR860 AOI01 Clonmel' },
  { acquisition_utc: '2026-01-27T18:05:00Z', aoi_name: 'EMSR860 AOI02 Mallow' },
  { acquisition_utc: '2026-01-28T06:30:00Z', aoi_name: 'EMSR860 AOI03 Enniscorthy' },
  { acquisition_utc: '2026-01-29T06:30:00Z', aoi_name: 'EMSR860 AOI04 Shannon Callows' },
]

/** storm intensity 0..1 for a station at time t (southern/western stations hit hardest) */
function intensity(st, t) {
  const south = Math.max(0, (54.2 - st.lat) / 3)
  const peak = LANDFALL + 10 * H
  const dt = (t - peak) / H
  const base = Math.exp(-(dt * dt) / (2 * 20 * 20))
  return Math.min(1, base * (0.35 + 0.9 * south) * (0.6 + 0.8 * rnd(st.id + 'k')))
}

function statusFor(p24) {
  return p24 >= 0.6 ? 'FILL_NOW' : p24 >= 0.35 ? 'PREPARE' : p24 >= 0.15 ? 'WATCH' : 'CLEAR'
}

function riskAt(t, live) {
  const stations = STATIONS.map((st) => {
    const live_noise = live ? 0.05 + 0.3 * rnd(st.id + Math.floor(Date.now() / (30 * 60_000))) : 0
    const inten = live ? live_noise : intensity(st, t)
    const p24 = Math.min(0.98, inten * 0.95)
    const status = statusFor(p24)
    const risk_score = Math.min(1, 0.15 + 0.85 * inten)
    const hoursToCross = status === 'CLEAR' ? null : Math.max(1, Math.round((1 - inten) * 40 + 3 * rnd(st.id + 'h')))
    const crossing = hoursToCross != null ? new Date(t + hoursToCross * H).toISOString() : null
    const bags = status === 'CLEAR' ? 0 : Math.round(400 + 2600 * inten)
    const deadline = hoursToCross != null ? new Date(t + (hoursToCross - 4) * H).toISOString() : null
    return {
      station_id: st.id, name: st.name, county: st.county, lat: st.lat, lon: st.lon,
      status, risk_score, p24, p48: Math.min(0.99, p24 * 1.15), p72: Math.min(0.99, p24 * 1.25),
      current_level: +(st.p95 * (0.45 + 0.7 * inten)).toFixed(2), p95_level: +st.p95.toFixed(2),
      predicted_crossing_utc: crossing, hours_to_crossing: hoursToCross, bags_needed: bags, fill_deadline_utc: deadline,
    }
  })
  return { generated_at: new Date(t).toISOString(), stations }
}

// Same ratios as floodline.decision.supplies: 200 m at 2 bags high, p* ~ 0.11.
function suppliesFor(p48) {
  const n = 3000
  const full = { sandbags: n, sand_t: n * 0.0136, sand_m3: n * 0.007646, sheeting_m2: 200 * 1.41 * 1.2, tipper_loads: Math.ceil((n * 0.0136) / 20), crew_hours: n / 100 }
  const labels = { sandbags: ['Sandbags', 'bags'], sand_t: ['Sand', 't'], sand_m3: ['Sand volume', 'm³'], sheeting_m2: ['Polythene sheeting ≥0.15 mm', 'm²'], tipper_loads: ['Tipper loads (20 t)', 'loads'], crew_hours: ['Filling crew-hours', 'h'] }
  const full_kit = p48 >= 0.107
  const scale = full_kit ? 1 : p48
  return {
    p_need: +p48.toFixed(4), horizon_h: 41.8, full_kit,
    items: Object.entries(full).map(([key, q]) => {
      const g = q * scale
      return { key, label: labels[key][0], unit: labels[key][1], full: +q.toFixed(1), get: key === 'sandbags' || key === 'tipper_loads' ? Math.ceil(g) : +g.toFixed(1) }
    }),
  }
}

function leadTimesAt(t, live) {
  return riskAt(t, live).stations.map((r) => ({
    station_id: r.station_id, name: r.name, county: r.county, status: r.status,
    fill_deadline_utc: r.fill_deadline_utc,
    hours_remaining: r.hours_to_crossing != null ? r.hours_to_crossing - 4 : null,
    predicted_crossing_utc: r.predicted_crossing_utc, lat: r.lat, lon: r.lon,
    supplies: suppliesFor(r.p48),
    tasks: r.status === 'CLEAR' ? [] : [
      { name: 'Mobilise crew', deadline_utc: new Date(t + (r.hours_to_crossing - 10) * H).toISOString() },
      { name: 'Fill bags', deadline_utc: new Date(t + (r.hours_to_crossing - 6) * H).toISOString() },
      { name: 'Deploy', deadline_utc: r.fill_deadline_utc },
    ],
  }))
}

function stationDetail(id, at) {
  const st = STATIONS.find((s) => s.id === id)
  if (!st) return null
  const t = at ? Date.parse(at) : Date.now()
  const r = riskAt(t, !at).stations.find((x) => x.station_id === id)
  const levels = []
  for (let i = 72; i >= 0; i--) {
    const tt = t - i * H
    const inten = at ? intensity(st, tt) : 0.2 + 0.1 * Math.sin(i / 6)
    levels.push({ t: new Date(tt).toISOString(), level: +(st.p95 * (0.45 + 0.7 * inten) + 0.05 * Math.sin(i / 3)).toFixed(3) })
  }
  const rainfall = []
  for (let i = 0; i <= 28; i++) {
    const tt = t + i * 6 * H
    const inten = at ? intensity(st, tt) : 0.15 + 0.1 * Math.sin(i / 4)
    const p50 = +(inten * 18 + 1).toFixed(1)
    rainfall.push({ t: new Date(tt).toISOString(), p10: +(p50 * 0.4).toFixed(1), p50, p90: +(p50 * 1.9 + 2).toFixed(1) })
  }
  return {
    station: st, status: r.status, risk_score: r.risk_score, p24: r.p24,
    current_level: r.current_level, p95: st.p95, levels, rainfall,
    decision: { status: r.status, fill_deadline_utc: r.fill_deadline_utc, bags: r.bags_needed, hours: r.hours_to_crossing != null ? r.hours_to_crossing - 4 : null, p_star: 0.32, crews: r.status === 'CLEAR' ? 0 : 2, expected_cost_eur: r.bags_needed * 2.5 + 2 * 180 * 6 },
    tasks: leadTimesAt(t, !at).find((x) => x.station_id === id).tasks,
    shap: [
      { feature: 'rain_72h_p90', value: +(0.6 * r.p24).toFixed(3) },
      { feature: 'soil_moisture', value: +(0.3 * r.p24).toFixed(3) },
      { feature: 'level_trend_6h', value: +(0.25 * r.p24).toFixed(3) },
      { feature: 'tide_coeff', value: -0.08 },
      { feature: 'catchment_area', value: +(0.05 + 0.1 * rnd(id)).toFixed(3) },
      { feature: 'upstream_level', value: 0.04 },
    ],
    predicted_crossing_utc: r.predicted_crossing_utc,
  }
}

function diamond(lon, lat, w, h, props) {
  return {
    type: 'Feature', properties: props,
    geometry: { type: 'Polygon', coordinates: [[[lon - w, lat], [lon, lat + h], [lon + w, lat], [lon, lat - h], [lon - w, lat]]] },
  }
}
const FLOODS = [
  diamond(-7.72, 52.36, 0.05, 0.02, { id: 'f1', aoi_name: 'EMSR860 AOI01 Clonmel', acquisition_utc: ACQ[0].acquisition_utc, source: 'Sentinel-1' }),
  diamond(-8.60, 52.14, 0.06, 0.025, { id: 'f2', aoi_name: 'EMSR860 AOI02 Mallow', acquisition_utc: ACQ[1].acquisition_utc, source: 'Sentinel-1' }),
  diamond(-6.58, 52.49, 0.04, 0.03, { id: 'f3', aoi_name: 'EMSR860 AOI03 Enniscorthy', acquisition_utc: ACQ[2].acquisition_utc, source: 'Sentinel-1' }),
  diamond(-7.98, 53.25, 0.04, 0.09, { id: 'f4', aoi_name: 'EMSR860 AOI04 Shannon Callows', acquisition_utc: ACQ[3].acquisition_utc, source: 'Sentinel-1' }),
  diamond(-7.50, 52.33, 0.03, 0.015, { id: 'f5', aoi_name: 'EMSR860 AOI01 Carrick-on-Suir', acquisition_utc: ACQ[0].acquisition_utc, source: 'Sentinel-1' }),
]

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' })
  res.end(JSON.stringify(body))
}

let settings = { defence_length_m: 200, bags_high: 3, crews: 2, cost_per_bag_eur: 2.5, cost_per_crew_hour_eur: 180 }

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    if (req.method === 'OPTIONS') return json(res, {})
    await new Promise((r) => setTimeout(r, 120)) // a little latency
    if (p === '/stations') return json(res, STATIONS)
    if (p === '/risk') return json(res, riskAt(Date.now(), true))
    if (p === '/lead-times') return json(res, leadTimesAt(Date.now(), true))
    if (p.startsWith('/station/')) {
      const d = stationDetail(decodeURIComponent(p.slice(9)), url.searchParams.get('at'))
      return d ? json(res, d) : json(res, { detail: 'not found' }, 404)
    }
    if (p === '/satellite/latest') {
      const bbox = url.searchParams.get('bbox')
      if (!bbox) return json(res, { status: 'unavailable', reason: 'bbox required', observed_at: null, features: { type: 'FeatureCollection', features: [] } })
      const [w, s, e, n] = bbox.split(',').map(Number)
      const feats = FLOODS.filter((f) => f.geometry.coordinates[0].some(([x, y]) => x >= w && x <= e && y >= s && y <= n))
      const observed = new Date(Date.now() - 14 * H).toISOString()
      return json(res, { status: 'ok', observed_at: observed, source: 'Sentinel-1', features: { type: 'FeatureCollection', features: feats.map((f) => ({ ...f, properties: { ...f.properties, acquisition_utc: observed } })) } })
    }
    if (p === '/satellite/wms')
      return json(res, {
        available: true,
        url: 'https://tiles.maps.eox.at/wms',
        layers: 's2cloudless-2023_3857',
        format: 'image/jpeg',
        version: '1.1.1',
        attribution: 'Contains modified Copernicus Sentinel data · Sentinel-2 cloudless by EOX',
      })
    if (p === '/data-status')
      return json(res, {
        stations_loaded: STATIONS.length, rows: 1_284_310, last_live_reading_utc: new Date(Date.now() - 23 * 60_000).toISOString(),
        model_metrics: [
          { horizon: '6h', precision: 0.91, recall: 0.84, auc_pr: 0.902 },
          { horizon: '12h', precision: 0.86, recall: 0.80, auc_pr: 0.861 },
          { horizon: '24h', precision: 0.79, recall: 0.74, auc_pr: 0.792 },
          { horizon: '48h', precision: 0.68, recall: 0.66, auc_pr: 0.671 },
        ],
        lead_time_histogram: [
          { bin: '0–6h', count: 4 }, { bin: '6–12h', count: 11 }, { bin: '12–24h', count: 23 }, { bin: '24–48h', count: 31 }, { bin: '48–72h', count: 14 }, { bin: '72h+', count: 6 },
        ],
        sources: [
          { name: 'OPW', ok: true, last_updated_utc: new Date(Date.now() - 23 * 60_000).toISOString() },
          { name: 'Open-Meteo IFS', ok: true, last_updated_utc: new Date(Date.now() - 2 * H).toISOString() },
          { name: 'Open-Meteo AIFS', ok: true, last_updated_utc: new Date(Date.now() - 3 * H).toISOString() },
          { name: 'CFRAM', ok: true },
          { name: 'GFM', ok: false, reason: 'No acquisition over Ireland in last 48 h' },
          { name: 'EMSR860', ok: true },
          { name: 'CDSE WMS', ok: true },
        ],
        attribution: [
          { name: 'OPW', text: 'Hydrometric data © Office of Public Works (waterlevel.ie), CC BY 4.0', url: 'https://waterlevel.ie' },
          { name: 'Open-Meteo', text: 'ECMWF IFS & AIFS forecasts via Open-Meteo, CC BY 4.0', url: 'https://open-meteo.com' },
          { name: 'CFRAM', text: 'Flood maps © OPW CFRAM programme', url: 'https://www.floodinfo.ie' },
          { name: 'Copernicus', text: 'Contains modified Copernicus Sentinel data; GFM & EMSR860 © European Union', url: 'https://emergency.copernicus.eu' },
          { name: 'OpenStreetMap', text: 'Counties & rivers © OpenStreetMap contributors, ODbL', url: 'https://www.openstreetmap.org/copyright' },
        ],
        settings,
      })
    if (p === '/demo/timeline')
      return json(res, { name: 'Storm Chandra', start_utc: new Date(START).toISOString(), end_utc: new Date(END).toISOString(), step_hours: 6, landfall_utc: new Date(LANDFALL).toISOString(), steps: STEPS, satellite_acquisitions: ACQ })
    if (p === '/demo/risk') return json(res, riskAt(Date.parse(url.searchParams.get('at') ?? STEPS[0]), false))
    if (p === '/demo/lead-times') return json(res, leadTimesAt(Date.parse(url.searchParams.get('at') ?? STEPS[0]), false))
    if (p === '/demo/satellite') {
      const t = Date.parse(url.searchParams.get('at') ?? STEPS[0])
      const feats = FLOODS.filter((f) => Date.parse(f.properties.acquisition_utc) <= t)
      const last = feats.map((f) => f.properties.acquisition_utc).sort().at(-1) ?? null
      return json(res, { status: feats.length ? 'ok' : 'unavailable', reason: feats.length ? null : 'No EMSR860 acquisition yet', observed_at: last, source: 'EMSR860', features: { type: 'FeatureCollection', features: feats } })
    }
    if (p === '/settings' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      try { settings = { ...settings, ...JSON.parse(body) } } catch { return json(res, { detail: 'bad json' }, 400) }
      return json(res, settings)
    }
    json(res, { detail: 'not found' }, 404)
  })
  .listen(PORT, () => console.log(`mock Floodline API on http://localhost:${PORT}`))
