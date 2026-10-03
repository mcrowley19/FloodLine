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
  layers?: string
  styles?: string
  format?: string
  version?: string
  /** Optional ready-made XYZ/WMS tile template; if present it is used verbatim */
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

export interface Settings {
  defence_length_m: number
  bags_high: number
  crews: number
  cost_per_bag_eur: number
  cost_per_crew_hour_eur: number
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
