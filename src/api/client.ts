import type {
  DataStatus,
  DemoTimeline,
  LeadTimeRow,
  RiskPoint,
  RiskResponse,
  SatelliteResponse,
  Settings,
  Station,
  StationDetail,
  WmsInfo,
} from './types'

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://localhost:8000'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(API_URL + path)
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  let res: Response
  try {
    res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
  } catch {
    throw new ApiError(0, `Cannot reach API at ${API_URL}`)
  }
  if (!res.ok) throw new ApiError(res.status, `${path} → ${res.status}`)
  return (await res.json()) as T
}

/* ---------- normalisers (tolerate small backend shape differences) ---------- */

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function normaliseRiskPoint(r: Record<string, unknown>): RiskPoint {
  return {
    station_id: String(r.station_id ?? r.id ?? ''),
    name: String(r.name ?? r.station_name ?? ''),
    county: String(r.county ?? ''),
    lat: num(r.lat ?? r.latitude),
    lon: num(r.lon ?? r.lng ?? r.longitude),
    status: (r.status as RiskPoint['status']) ?? 'CLEAR',
    risk_score: num(r.risk_score ?? r.score),
    p24: num(r.p24 ?? r.p_24 ?? r.p24h),
    p48: (r.p48 as number | null) ?? null,
    p72: (r.p72 as number | null) ?? null,
    current_level: (r.current_level as number | null) ?? (r.level as number | null) ?? null,
    p95_level: (r.p95_level as number | null) ?? (r.p95 as number | null) ?? null,
    predicted_crossing_utc: str(r.predicted_crossing_utc ?? r.predicted_crossing),
    hours_to_crossing: (r.hours_to_crossing as number | null) ?? null,
    bags_needed: (r.bags_needed as number | null) ?? (r.bags as number | null) ?? null,
    fill_deadline_utc: str(r.fill_deadline_utc ?? r.fill_deadline),
  }
}

function normaliseRisk(raw: unknown): RiskResponse {
  if (Array.isArray(raw)) return { generated_at: null, stations: raw.map(normaliseRiskPoint) }
  const o = (raw ?? {}) as Record<string, unknown>
  const list = (o.stations ?? o.risk ?? o.items ?? o.data ?? []) as Record<string, unknown>[]
  return { generated_at: str(o.generated_at ?? o.as_of ?? o.at), stations: list.map(normaliseRiskPoint) }
}

function normaliseLeadTimes(raw: unknown): LeadTimeRow[] {
  const list = (Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.rows ?? (raw as Record<string, unknown>)?.stations ?? (raw as Record<string, unknown>)?.items ?? [])) as Record<string, unknown>[]
  return list.map((r) => ({
    station_id: String(r.station_id ?? r.id ?? ''),
    name: String(r.name ?? r.station_name ?? ''),
    county: String(r.county ?? ''),
    status: (r.status as LeadTimeRow['status']) ?? 'CLEAR',
    fill_deadline_utc: str(r.fill_deadline_utc ?? r.fill_deadline),
    hours_remaining: (r.hours_remaining as number | null) ?? (r.hours as number | null) ?? null,
    predicted_crossing_utc: str(r.predicted_crossing_utc ?? r.predicted_crossing),
    tasks: ((r.tasks ?? []) as Record<string, unknown>[]).map((t) => ({
      name: String(t.name ?? t.task ?? ''),
      deadline_utc: str(t.deadline_utc ?? t.deadline),
      duration_h: (t.duration_h as number | null) ?? null,
      done: Boolean(t.done ?? false),
    })),
    lat: r.lat as number | undefined,
    lon: r.lon as number | undefined,
  }))
}

function normaliseSatellite(raw: unknown): SatelliteResponse {
  const o = (raw ?? {}) as Record<string, unknown>
  // Backend may return a bare FeatureCollection
  if (o.type === 'FeatureCollection') {
    return { status: 'ok', observed_at: str(o.observed_at), features: o as unknown as SatelliteResponse['features'] }
  }
  const fc = (o.features ?? o.geojson ?? o.polygons ?? { type: 'FeatureCollection', features: [] }) as Record<string, unknown>
  const features = (fc.type === 'FeatureCollection' ? fc : { type: 'FeatureCollection', features: fc }) as unknown as SatelliteResponse['features']
  // Ensure every feature has a stable id for feature-state driven animation
  features.features = (features.features ?? []).map((f, i) => ({
    ...f,
    id: f.id ?? (f.properties?.id as string | undefined) ?? i,
    properties: { ...(f.properties ?? {}), id: String(f.id ?? f.properties?.id ?? i) },
  }))
  return {
    status: (o.status as SatelliteResponse['status']) ?? 'ok',
    reason: str(o.reason),
    observed_at: str(o.observed_at ?? o.acquisition_utc ?? o.acquired_at),
    source: str(o.source) ?? 'Sentinel-1',
    features,
  }
}

function normaliseTimeline(raw: unknown): DemoTimeline {
  const o = (raw ?? {}) as Record<string, unknown>
  const start = str(o.start_utc ?? o.start) ?? '2026-01-22T00:00:00Z'
  const end = str(o.end_utc ?? o.end) ?? '2026-01-30T00:00:00Z'
  const stepHours = num(o.step_hours, 6)
  let steps = (o.steps as string[] | undefined) ?? (o.timestamps as string[] | undefined)
  if (!steps || steps.length === 0) {
    steps = []
    for (let t = Date.parse(start); t <= Date.parse(end); t += stepHours * 3_600_000) steps.push(new Date(t).toISOString())
  }
  const acqRaw = (o.satellite_acquisitions ?? o.acquisitions ?? o.satellite ?? []) as (string | Record<string, unknown>)[]
  return {
    name: str(o.name) ?? 'Storm Chandra',
    start_utc: start,
    end_utc: end,
    step_hours: stepHours,
    landfall_utc: str(o.landfall_utc ?? o.landfall) ?? '2026-01-27T00:00:00Z',
    steps,
    satellite_acquisitions: acqRaw.map((a) =>
      typeof a === 'string'
        ? { acquisition_utc: a }
        : { acquisition_utc: String(a.acquisition_utc ?? a.t ?? a.time), aoi_name: str(a.aoi_name ?? a.aoi ?? a.name) ?? undefined },
    ),
  }
}

function normaliseStationDetail(raw: unknown): StationDetail {
  const o = (raw ?? {}) as Record<string, unknown>
  const st = (o.station ?? o) as Record<string, unknown>
  const dec = (o.decision ?? {}) as Record<string, unknown>
  const levels = ((o.levels ?? o.level_history ?? o.history ?? []) as Record<string, unknown>[]).map((s) => ({
    t: String(s.t ?? s.time ?? s.timestamp),
    level: num(s.level ?? s.value),
  }))
  const rainfall = ((o.rainfall ?? o.rainfall_forecast ?? o.forecast ?? []) as Record<string, unknown>[]).map((s) => ({
    t: String(s.t ?? s.time ?? s.timestamp),
    p10: num(s.p10),
    p50: num(s.p50),
    p90: num(s.p90),
  }))
  const shap = ((o.shap ?? o.shap_values ?? []) as (Record<string, unknown> | [string, number])[]).map((s) =>
    Array.isArray(s) ? { feature: s[0], value: s[1] } : { feature: String(s.feature ?? s.name), value: num(s.value) },
  )
  return {
    station: {
      id: String(st.id ?? st.station_id ?? ''),
      name: String(st.name ?? ''),
      county: String(st.county ?? ''),
      river: str(st.river),
      lat: num(st.lat),
      lon: num(st.lon ?? st.lng),
      p95: (st.p95 as number | null) ?? (o.p95 as number | null) ?? null,
    },
    status: (o.status as StationDetail['status']) ?? (dec.status as StationDetail['status']) ?? 'CLEAR',
    risk_score: num(o.risk_score),
    p24: num(o.p24),
    current_level: (o.current_level as number | null) ?? levels.at(-1)?.level ?? null,
    p95: (o.p95 as number | null) ?? (st.p95 as number | null) ?? null,
    levels,
    rainfall,
    decision: {
      status: (dec.status as StationDetail['status']) ?? (o.status as StationDetail['status']) ?? 'CLEAR',
      fill_deadline_utc: str(dec.fill_deadline_utc ?? dec.fill_deadline),
      bags: num(dec.bags ?? dec.bags_needed),
      hours: (dec.hours as number | null) ?? (dec.lead_time_h as number | null) ?? null,
      p_star: num(dec.p_star ?? dec.pstar ?? dec.threshold),
      crews: (dec.crews as number | null) ?? null,
      expected_cost_eur: (dec.expected_cost_eur as number | null) ?? null,
    },
    tasks: ((o.tasks ?? dec.tasks ?? []) as Record<string, unknown>[]).map((t) => ({
      name: String(t.name ?? t.task ?? ''),
      deadline_utc: str(t.deadline_utc ?? t.deadline),
      duration_h: (t.duration_h as number | null) ?? null,
      done: Boolean(t.done ?? false),
    })),
    shap: shap.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 5),
    predicted_crossing_utc: str(o.predicted_crossing_utc),
  }
}

/* ------------------------------- endpoints -------------------------------- */

export const api = {
  stations: () => get<Station[]>('/stations'),
  risk: async () => normaliseRisk(await get('/risk')),
  station: (id: string, at?: string) => get(`/station/${encodeURIComponent(id)}`, { at }).then(normaliseStationDetail),
  leadTimes: async () => normaliseLeadTimes(await get('/lead-times')),
  satelliteLatest: async (bbox: string) => normaliseSatellite(await get('/satellite/latest', { bbox })),
  satelliteWms: () => get<WmsInfo>('/satellite/wms'),
  dataStatus: () => get<DataStatus>('/data-status'),
  demoTimeline: async () => normaliseTimeline(await get('/demo/timeline')),
  demoRisk: async (at: string) => normaliseRisk(await get('/demo/risk', { at })),
  demoLeadTimes: async (at: string) => normaliseLeadTimes(await get('/demo/lead-times', { at })),
  demoSatellite: async (at: string) => normaliseSatellite(await get('/demo/satellite', { at })),
  saveSettings: async (settings: Settings) => {
    const res = await fetch(API_URL + '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(settings),
    })
    if (!res.ok) throw new ApiError(res.status, `POST /settings → ${res.status}`)
    return (await res.json().catch(() => settings)) as Settings
  },
}
