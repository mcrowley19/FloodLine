/**
 * API shapes for the Floodline backend.
 *
 * The backend README was not available when this file was written, so these
 * types encode the shapes the frontend expects. `client.ts` normalises a few
 * common variations (bare arrays vs. wrapped objects, missing optional fields)
 * so the UI keeps working if the backend differs slightly. Adjust here first
 * if the backend changes.
 */
import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson'

export type Status = 'CLEAR' | 'WATCH' | 'PREPARE' | 'FILL_NOW'
export const STATUSES: Status[] = ['FILL_NOW', 'PREPARE', 'WATCH', 'CLEAR']

/** GET /stations */
export interface Station {
  id: string
  name: string
  county: string
  river?: string | null
  lat: number
  lon: number
  /** P95 water level (m) used as the crossing threshold */
  p95?: number | null
}

/** One entry of GET /risk (and GET /demo/risk?at=) */
export interface RiskPoint {
  station_id: string
  name: string
  county: string
  lat: number
  lon: number
  status: Status
  /** 0..1 composite risk score (drives marker radius) */
  risk_score: number
  /** probability of crossing P95 within 24 h, 0..1 */
  p24: number
  p48?: number | null
  p72?: number | null
  current_level?: number | null
  p95_level?: number | null
  predicted_crossing_utc?: string | null
  /** hours from `generated_at` until predicted crossing */
  hours_to_crossing?: number | null
  bags_needed?: number | null
  fill_deadline_utc?: string | null
}

export interface RiskResponse {
  generated_at: string | null
  stations: RiskPoint[]
}

export interface LevelSample {
  t: string
  level: number
}

export interface RainfallSample {
  t: string
  p10: number
  p50: number
  p90: number
}

export interface Decision {
  status: Status
  fill_deadline_utc: string | null
  bags: number
  /** hours of lead time remaining */
  hours: number | null
  /** decision threshold probability p* */
  p_star: number
  crews?: number | null
  expected_cost_eur?: number | null
}

export interface Task {
  name: string
  deadline_utc: string | null
  duration_h?: number | null
  done?: boolean
}

export interface ShapValue {
  feature: string
  value: number
}

/** GET /station/{id} */
export interface StationDetail {
  station: Station
  status: Status
  risk_score: number
  p24: number
  current_level: number | null
  p95: number | null
  /** last 72 h of observed level */
  levels: LevelSample[]
  /** 7-day rainfall forecast fan */
  rainfall: RainfallSample[]
  decision: Decision
  tasks: Task[]
  shap: ShapValue[]
  predicted_crossing_utc?: string | null
}

export interface SupplyItem {
  key: string
  label: string
  unit: string
  /** quantity for the full defence */
  full: number
  /** quantity to source now, given the flood probability */
  get: number
}

export interface Supplies {
  /** P(river crosses P95 within fill lead time + resupply time) */
  p_need: number
  horizon_h: number
  /** true when p_need clears p*, so the whole kit should be on hand */
  full_kit: boolean
  items: SupplyItem[]
}

/** One row of GET /lead-times (and GET /demo/lead-times?at=) */
export interface LeadTimeRow {
  station_id: string
  name: string
  county: string
  status: Status
  fill_deadline_utc: string | null
  hours_remaining: number | null
  predicted_crossing_utc: string | null
  tasks: Task[]
  supplies: Supplies | null
  lat?: number
  lon?: number
}

/** Properties on each observed-flood polygon */
export interface FloodPolygonProps {
  id?: string
  aoi_name?: string
  acquisition_utc?: string
  source?: string
  [key: string]: unknown
}

export type FloodFeatureCollection = FeatureCollection<Polygon | MultiPolygon, FloodPolygonProps>

/** GET /satellite/latest?bbox=minLon,minLat,maxLon,maxLat and GET /demo/satellite?at= */
export interface SatelliteResponse {
  status: 'ok' | 'unavailable'
  reason?: string | null
  observed_at: string | null
  source?: string
  features: FloodFeatureCollection
}

/** GET /satellite/wms */
export interface WmsInfo {
  available: boolean
  reason?: string | null
  /** WMS GetMap base URL (without query) */
  url?: string
  layer?: string
  max_cloud_cover_param?: string
  /** GetMap query params (LAYERS, CRS, TIME, MAXCC, ...), everything except BBOX */
  params?: Record<string, string | number>
  /** Ready-made tile template with {bbox-epsg-3857}; used verbatim when present */
  tile_url_template?: string
  attribution?: string
  min_zoom?: number
}

export interface ModelMetric {
  horizon: string
  precision: number
  recall: number
  auc_pr: number
}

export interface HistogramBin {
  /** label such as "0-6h" */
  bin: string
  count: number
}

export interface SourceHealth {
  name: string
  ok: boolean
  reason?: string | null
  last_updated_utc?: string | null
}

export interface Attribution {
  name: string
  text: string
  url?: string | null
}

/** Decision-layer inputs (backend `DecisionInputs`); POST /settings wraps them as `{global: ...}` */
export interface Settings {
  defence_length_m: number
  bags_high: number
  crews: number
  fill_rate_bags_per_crew_hour: number
  cost_fill_unneeded_per_bag: number
  cost_short: number
}

/** GET /data-status */
export interface DataStatus {
  stations_loaded: number
  rows: number
  last_live_reading_utc: string | null
  model_metrics: ModelMetric[]
  lead_time_histogram: HistogramBin[]
  sources: SourceHealth[]
  attribution: Attribution[]
  settings?: Settings
}

export interface SatelliteAcquisition {
  acquisition_utc: string
  aoi_name?: string
}

/** GET /demo/timeline */
export interface DemoTimeline {
  name: string
  start_utc: string
  end_utc: string
  step_hours: number
  landfall_utc: string
  /** ISO timestamps for every scrubber step, start..end inclusive */
  steps: string[]
  satellite_acquisitions: SatelliteAcquisition[]
}

/* ---------- Ask Floodline (POST /ask) ---------- */

export interface AskMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AskRequest {
  question: string
  history: AskMessage[]
  /** demo snapshot time; omit for live */
  at?: string | null
}

export interface AskToolUse {
  tool: string
  args: Record<string, unknown>
}

/** NDJSON events streamed by POST /ask */
export type AskEvent =
  | { type: 'delta'; text: string }
  /** text so far was preamble before a tool call; discard it */
  | { type: 'reset' }
  | ({ type: 'tool' } & AskToolUse)
  | { type: 'done'; tools_used: AskToolUse[]; model: string }
  | { type: 'error'; detail: string }
