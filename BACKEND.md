# Floodline

Ireland-wide flood lead-time backend for county councils. For every OPW river/lake gauge it
estimates the probability that the level reaches its own 95th percentile within 6 / 24 / 48 /
120 hours, turns that into a sandbag decision (newsvendor rule) with deadlines, and serves
satellite flood observations alongside. Beyond rivers it screens three other flood types
nationally (surface water from intense rain on poorly drained ground, groundwater in karst
areas, and coastal surge) and merges all four into one alert list. Includes a Storm Chandra
(January 2026) replay.

Stack: Python 3.11, FastAPI, httpx (async), polars, LightGBM, numpy, geopandas/shapely,
rasterio. No database: Parquet / GeoJSON under `./data`, models under `./models`.

## Setup

```bash
uv sync                      # installs Python 3.11 + deps into .venv
uv run floodline all         # ingest -> features -> train -> satellite-build -> hazards-build -> demo-build -> serve
uv run pytest                # tests (offline, synthetic data)
```

Individual stages: `uv run floodline ingest | features | train | satellite-build | hazards-build | demo-build | serve`.
Every stage is skipped when its output already exists; pass `--force` to rebuild. `all --no-serve`
stops after the build. `serve` listens on `127.0.0.1:8000` (`--host/--port` to change); interactive
docs at `/docs`.

### Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `GFM_USER`, `GFM_PASS` | Copernicus Global Flood Monitoring account (free: https://portal.gfm.eodc.eu). Without them `/satellite/latest` returns an empty FeatureCollection with `status: "unavailable"` and the reason. |
| `CDSE_CLIENT_ID` | Copernicus Data Space Sentinel Hub **configuration (instance) ID** for the WMS. Create a free account at https://dataspace.copernicus.eu, open the Sentinel Hub dashboard (https://shapps.dataspace.copernicus.eu/dashboard) → *Configuration Utility* → *Add new configuration* from the "Simple Sentinel-2 L2A" template (it includes a `TRUE_COLOR` layer), and copy its ID. Without it `/satellite/wms` returns `{available: false}`. Optional: `CDSE_WMS_LAYER` (default `TRUE_COLOR`), `CDSE_MAX_CLOUD` (default 30). |
| `OPEN_METEO_API_KEY` | Open-Meteo commercial key: uses the `customer-*` endpoints, no client-side throttling, and a finer 0.25° rain grid. |
| `FLOODLINE_RAIN_GRID` | Rain grid in degrees (default 0.5 on the free tier, 0.25 with a key). |
| `FLOODLINE_SURFACE_REFRESH_H` | Hours between high-resolution surface-water rain refreshes (default 12; each costs ~2,500 Open-Meteo calls). |
| `FLOODLINE_DATA`, `FLOODLINE_MODELS` | Override `./data` and `./models`. |
| `OLLAMA_URL`, `FLOODLINE_LLM_MODEL` | Ask Floodline's local LLM server (default `http://localhost:11434`) and model (default `qwen3:8b`). |

## Deploying (free: Render frontend + laptop backend)

Training peaks at ~3.7 GB and the server sits at ~490 MB, too close to Render's 512 MB free
limit, so the backend runs on a laptop instead:

```bash
uv run floodline all --no-serve   # once, if data/ and models/ are not built yet
scripts/serve-public.sh           # server + free Cloudflare quick tunnel; keeps the Mac awake
```

The script restarts the server if it exits and prints a `https://….trycloudflare.com` URL.
`render.yaml` deploys only the static frontend (free), rewriting `/api/*` to that URL so no CORS is
needed. The tunnel URL changes each time the script starts: update the `/api/*` rule in the Render
dashboard (static site → Redirects/Rewrites). `FLOODLINE_CORS_ORIGINS` (comma-separated) allows
extra browser origins if the frontend calls the API directly via `VITE_API_URL` instead.

## Observed timings

MacBook Air (M-series, 24 GB), home broadband, 3 October 2026, 461 gauges:

| Stage | Time | Notes |
|---|---|---|
| ingest | 8 min 07 s | OPW levels for 461 stations done in 2.5 min (10 concurrent); the rest is Open-Meteo's free-tier limiter (51 cells × 3 years ≈ 4,000 weighted calls, paced at ~540/min). CFRAM download + exposure (~1 min 45 s) runs concurrently. |
| features | 10 s | 10.6 M station-hours |
| train | 2 min 41 s | 4 models, peak RSS 3.7 GB |
| satellite-build | 2 s | EMSR860 + first GFM attempt |
| hazards-build | 1 min 20 s – 1 min 50 s | first run also downloads ~900 MB (NIFM, coastal extents, GSI); soil drainage map rendered in 48 server-side tiles; peak RSS 3.5 GB |
| demo-build | 1 min 20 s + ~2 min | river replay incl. one live-ensemble fetch, plus the surface-water / groundwater replay (archived hi-res forecasts are fetched once) |
| **total** | **≈ 17 min** | well inside the 60-minute budget |

Server start → first live risk for 460 stations: ~3 s (with caches).

## Data

| Source | Use |
|---|---|
| `waterlevel.ie/geojson/` + `/geojson/latest/` | Station list (sensor 0001, refs 00001–41000 only, per OPW's republication rule); live level every 15 min (never faster). |
| OPW Hydro-Data (`/hydro-data/data/internet/stations/0/<id>/S/Waterlevel_complete.zip`) | 3 years of 15-min level → hourly mean. Hydro-Data is in ordnance datum; it is shifted to staff-gauge datum (to match the live feed) using the median difference over the 5-week overlap with the month CSV, falling back to the station's published gauge datum. Fallback source: `waterlevel.ie/data/month/<id>_0001.csv`. |
| Open-Meteo Archive | Hourly precipitation, same 3 years, per rain-grid cell. |
| Open-Meteo Forecast (`past_days=31`) | Recent rain, covering the archive's ~5-day lag for live features. |
| Open-Meteo Ensemble (`ecmwf_ifs025` + `ecmwf_aifs025`, 15 days) | ~102 pooled members → per-gauge p10/p50/p90 accumulations over 6/24/48/72/120/168 h, P(48 h > 20 mm), P(48 h > 50 mm), 7-day fan. Refreshed at most every 6 h, cached on disk. |
| CFRAM fluvial extents (10% AEP / 10-year) | Exposure = km² of extent within 5 km of each gauge (floor 0.05 km²). Falls back to 1.0 on failure. |
| Copernicus EMS EMSR860 | Observed flood extent (`observedEventA`, `maximumFloodExtentA`) for every AOI with delivered products. Today that is County Kilkenny (Graiguenamanagh): 3 Sentinel-1 acquisitions (29 Jan 18:13, 31 Jan 06:47, 3 Feb 04:51 UTC). The County Wexford products were never delivered ("remote sensing limitations"), so they are logged and skipped. |
| Copernicus GFM | Latest Sentinel-1 observed flood extent / observed water over Ireland; GeoTIFFs polygonised, polygons < 0.5 ha dropped. Refreshed at most every 30 min. |
| Natural Earth admin-1 | County names for `/stations` (nearest county town fallback). |
| EPA / Teagasc National Soils Hydrology Map (`EPA:SOILS_WETDRY`, CC BY 4.0) | Soil drainage class (well / imperfect / poor / very poor / peat / alluvium / made ground). The 490k-polygon layer is too big to download per build, so EPA's GeoServer renders it at 250 m in 60 km tiles with a style that encodes each class as a pixel value (`antialias:none`, so every pixel is an exact class). |
| OPW NIFM fluvial extents, 100-year | Flood-prone ground along small, ungauged rivers. |
| OPW National Coastal Flood Extents 2021, 10-year | Coastal exposure near each surge point. |
| GSI groundwater flood maps (probability high / medium / low; historic) and 2015/16 surface-water flood map | Groundwater zones; observed winter ponding as a surface-water susceptibility input. |
| Open-Meteo Forecast, hi-res models (`ukmo_uk_deterministic_2km`, `knmi_harmonie_arome_europe`, `dmi_harmonie_arome_europe`) | Hourly rain per 10 km cell: past 7 days + ~60 h ahead. Archived runs (historical-forecast API) for the Storm Chandra replay. |
| Marine Institute ERDDAP (`imiSurgePrediction`, `IMI_TidePrediction_HighLow`, CC BY 4.0) | Tide + storm-surge forecast for 40 coastal points (next 48 h, hourly refresh); 2026–2028 predicted high waters for thresholds. |

### Open-Meteo usage

The free tier (non-commercial) allows 600 / 5,000 / 10,000 weighted calls per minute / hour / day,
and 3 years of hourly data counts as ~80 calls per location. Requests are therefore made per
0.5° grid cell (51 cells for Ireland), not per gauge. A first ingest uses ~4,000; each 6-hourly
live river refresh ~700; each surface-water refresh ~2,500 (818 cells × 3 models, which
Open-Meteo appears to count separately), hence the 12-hourly default. Re-running `ingest --force` on the same day as a full run can hit the daily
cap; cells already on disk are never re-fetched without `--force`. Council (commercial) use
requires an Open-Meteo API subscription.

## Model

- Features (per station-hour): level now, lags 1/3/6/12/24 h, rise rates 3/6 h, percentile of
  own record, level − P95, rain past 1/6/24/72 h/7 d/30 d, rain next 6/24/48 h/5 d/7 d, lat, lon,
  station P50/P95/max/std, exposure, station id (categorical).
- Labels: `label_H = max(level in next H h) ≥ station P95`, H ∈ {6, 24, 48, 120}. Stations with
  < 500 valid hours are dropped.
- One pooled LightGBM per horizon. Train ≤ 2025-09-30, validate Oct–Dec 2025, test Jan–Feb 2026.
  Negatives are subsampled (≤ 2.5 M rows per model); `scale_pos_weight = neg/pos` clipped to [10, 200].
- Probabilities are Platt-calibrated on validation, because `scale_pos_weight` inflates raw scores
  and the decision layer compares probabilities with a cost ratio. The cutoff maximises
  validation F1.

Test results (Jan–Feb 2026, 461 stations, `models/metrics.json`):

| Head | Cutoff | Precision | Recall | AUC-PR | Base rate |
|---|---|---|---|---|---|
| 6 h | 0.48 | 0.92 | 0.89 | 0.97 | 0.17 |
| 24 h | 0.46 | 0.84 | 0.84 | 0.93 | 0.25 |
| 48 h | 0.45 | 0.80 | 0.83 | 0.91 | 0.31 |
| 120 h | 0.45 | 0.75 | 0.89 | 0.90 | 0.45 |

Lead time over 1,605 real P95 crossings in test (crossing = reaching P95 after ≥ 24 h below):
the 24 h head alerted 13–24 h ahead for 1,115 and missed 100. The 48 h head alerted 25–48 h ahead
for 1,312 and missed 43. Lead is measured within each head's own window, so the 48 h head can't
exceed 48 h.

**Read these numbers with care.** Training and test use *observed* future rain (perfect-forecast
proxy), so they are an upper bound on what real ensemble forecasts give. P95 is also a low bar
in a wet winter: base rates of 17–45% mean many gauges sit near P95 for weeks. That is why the
long heads are "on" at the start of their window for most crossings.

## Decision layer

Per station (defaults, all overridable via `POST /settings`, globally or per station):
`defence_length_m=200, bags_high=2 (5/15/30 bags per m for 1/2/3 high), crews=2,
fill_rate_bags_per_crew_hour=100, travel_h=0.75, margin_h=2, cost_fill_unneeded_per_bag=2,
cost_short=50000, resupply_h=24`.

- N = length × bags_per_m; L = N / (crews × fill_rate) + travel + margin;
  p* = cost_fill·N / (cost_fill·N + cost_short).
- P(cross within t) is interpolated log-linearly in time between the 6/24/48/120 h heads, after
  forcing monotonicity. Below 6 h it is linear from 0; beyond 120 h it is held flat.
- FILL_NOW if P(≤ L) ≥ p*; PREPARE if P(≤ L+24) ≥ p*; WATCH if P(≤ 120) ≥ p*; else CLEAR.
- Predicted crossing is the first hour where interpolated P ≥ the (log-linearly interpolated)
  model cutoff, or *now* if the gauge is already above P95. `fill_deadline = crossing − L`. A
  negative `hours_remaining` means the deadline has passed.
- Worked example: 100 m at 2 bags high → N = 1,500; 2 crews → L = 10.25 h; p* = 3,000/53,000 ≈ 0.057.
- Risk = P(≤ 48 h) × exposure, scaled to 0–100 across stations.
- **Supplies.** Each station's kit is its full defence: N sandbags, 13.6 kg (30 lb) of sand per
  bag and 1 yd³ (0.76 m³) per 100 bags, polythene sheeting ≥0.15 mm (6 mil) covering both faces
  (3 courses ≈ 0.3 m) plus a 1 m ground apron with 20% for 0.9 m laps, 20 t tipper loads, and
  N / fill_rate crew-hours (ratios from the USACE / NDSU sandbagging guidance; the apron and
  tipper payload are assumptions). p_need = P(≤ L + resupply_h), with `resupply_h=24`. If
  p_need ≥ p* the whole kit is listed to source now; otherwise p_need × kit, so summing across
  stations gives a risk-weighted pooled stock.

## Other flood types

Rivers are only one source of flooding. These three indicators are **rule-based screens, not
trained models**: there is no open record of surface-water, groundwater or coastal flood events
to learn from (OPW's past-flood archive is release-on-request via flood_data@opw.ie). Each uses
the levels CLEAR / WATCH / MODERATE / HIGH.

**Static ground layer (`hazards-build`).** Everything is rasterised to one ITM grid and
summarised per 10 km cell (818 land cells) as the fraction covered: soil drainage classes, CFRAM
10-year and NIFM 100-year fluvial extents, national coastal 10-year extent, GSI groundwater
probability / historic extents, and GSI 2015/16 surface-water ponding. A surface-water
susceptibility score (0–1) combines:
- 50% impeded drainage: poor / very poor drainage, peat, made ground, with imperfect counted at 60%;
- 25% observed 2015/16 ponding, saturating at 2% of the cell;
- 25% flood-prone ground: alluvium + NIFM, saturating at 10%.

The weights are judgement, not fitted.

**Surface water** (`/surface-water`), per 10 km cell:
- Inputs: peak 1 h / 3 h and 24 h rain over the next ~60 h from three ~2 km models, with the
  ECMWF ensemble 24 h p90 as a floor for the 24 h window.
- Base thresholds: 20 mm/1 h, 30 mm/3 h, 40 mm/24 h. They are lowered by up to 20% for
  susceptible ground and up to 15% for saturated ground (past 7 days), floored at 70%.
- R = worst rain/threshold ratio: HIGH if R ≥ 1.5 and ≥ 2 models agree; MODERATE if R ≥ 1;
  WATCH if R ≥ 0.7.
- Priority (0–100) weights R by urban share, so the same rain ranks higher over a town than a bog.
- The cross-reference you get per cell: `poor_drainage_share`, `peat_share`, `urban_share`,
  `susceptibility`, the lowered thresholds, and the full ground breakdown at `/surface-water/{cell}`.

**Groundwater** (`/groundwater`), per GSI flood-probability zone (1,505 zones, mostly karst
turloughs in the west and midlands):
- Rain over the past 30 / 60 / 90 days plus the next 7 days (ensemble median), ranked against
  the same windows in the zone's 3-year rain record.
- HIGH at the 98th percentile, MODERATE at 93rd, WATCH at 85th.
- Downgraded one step for GSI medium-probability zones, two for low, and one from May to
  September.
- Zones are returned as points. Draw the polygons from GSI's own WMS (`polygons_wms` in the
  response), because the GSI licence is no-derivatives and the full geometry is ~265 MB.

**Coastal** (`/coastal`), per Marine Institute surge point (40):
- Total = tide + surge over the next 48 h, against P95 / P99 of predicted high water
  (2026–2028) at the nearest tide station within 40 km.
- HIGH if total ≥ P99 + 0.3 m; MODERATE if ≥ P99; WATCH if ≥ P95 or surge ≥ 0.4 m.
- Points without a nearby tide station use surge alone.

**Combined** (`/alerts`): river statuses map FILL_NOW → HIGH, PREPARE → MODERATE, WATCH → WATCH.
Groundwater zones are grouped per rain cell, so the list isn't 1,500 rows. Filter with
`min_level` and `county`.

**Storm Chandra replay.** Surface water uses Open-Meteo's archived hi-res forecasts. HIGH cells
concentrate in Wicklow, Wexford and Carlow around landfall, matching the areas named in the
Copernicus activation (Wexford, Graiguenamanagh, Aughrim), though it also flags Cavan, Donegal
and Monaghan, which can't be checked. At landfall 11% of cells are MODERATE or above; the day
before, when rain was heavy nationwide, 39%. Groundwater uses the rain archive. Coastal can't be
replayed: the Marine Institute keeps only a rolling ~5-day surge window.

## API

All JSON / GeoJSON. CORS is open for `localhost` / `127.0.0.1` on any port.

| Endpoint | Returns |
|---|---|
| `GET /stations` | `[{id, name, lat, lon, county}]` |
| `GET /risk` | `[{id, name, lat, lon, level_now, p95, pct_of_record, p6, p24, p48, p120, risk, status, pred_cross_utc, fill_deadline_utc, bags_needed, rain48_p50, rain48_p90, as_of_utc, forecast_source}]`, risk desc |
| `GET /station/{id}` | The above plus `history_72h`, `ensemble_fan` (per 6 h: p10/p50/p90 totals and cumulative), `ensemble` summary, `decision_inputs`, `decision` (L, p*, P(≤L)), `uncertainty_rain_p10_p90` (probabilities re-run with ensemble p10 / p90 rain), `shap_top5_24h` (calibrated log-odds contributions) |
| `GET /lead-times` | `[{id, name, status, L, pred_cross_utc, fill_deadline_utc, hours_remaining, tasks: [{task, deadline_utc}], supplies: {p_need, horizon_h, full_kit, items: [{key, label, unit, full, get}]}}]`. Tasks: rest centre standby (−24 h), public warning (−18 h), fill sandbags (deadline), clear culvert screens (−8 h), open collection points (−4 h). |
| `GET /satellite/latest?bbox=minLon,minLat,maxLon,maxLat` | GFM FeatureCollection clipped to bbox; `properties: {observed_at, source, status, reason}` |
| `GET /satellite/wms` | CDSE WMS config (`url`, `layer`, `max_cloud_cover_param: "MAXCC"`, GetMap params) or `{available: false}` |
| `GET /data-status` | Station / row counts, last live reading, model metrics, health of OPW, OPW live, Open-Meteo archive / recent / IFS / AIFS, CFRAM, GFM, EMSR860, CDSE WMS |
| `POST /settings` | Body `{"global": {...}, "stations": {"25017": {...}}}`; persisted to `data/settings.json`, applied immediately |
| `GET /demo/timeline` | 33 snapshots every 6 h, 2026-01-22T00Z → 2026-01-30T00Z, landfall flagged at 2026-01-27T00Z |
| `GET /demo/risk?at=` / `GET /demo/lead-times?at=` | Same shapes as live, as of the latest snapshot ≤ `at`, with `forecast_source: "proxy"` |
| `GET /demo/satellite?at=` | EMSR860 polygons with `acquisition_utc ≤ at` (empty before 2026-01-29T18:13Z) |
| `GET /surface-water?min_level=&county=` | `{as_of_utc, rain_fetched_utc, counts, cells: [{cell_id, county, lat, lon, level, ratio, driver, peak_1h_mm, peak_3h_mm, max_24h_mm, peak_utc, models_agreeing, rain_past_7d, wetness, factor, thresholds_mm, susceptibility, urban_share, poor_drainage_share, peat_share, priority}]}` |
| `GET /surface-water/geojson?min_level=` | The same as a FeatureCollection of 10 km squares |
| `GET /surface-water/{cell_id}` | One cell plus `ground` (all layer fractions and susceptibility parts) and `rain_hourly` per model |
| `GET /groundwater?min_level=&county=` | `{counts, zones: [{zone_id, probability, area_ha, lat, lon, county, level, percentile, pct_30d/60d/90d, rain_*_incl_forecast, rain_next_7d}], polygons_wms}` (default `min_level=WATCH`) |
| `GET /coastal?min_level=&county=` / `GET /coastal/{station_id}` | `{counts, stations: [{station_id, name, county, level, peak_total_m, peak_utc, tide_at_peak_m, surge_at_peak_m, max_surge_m, hw_p95, hw_p99, margin_to_p99_m, coastal10_km2_within_10km}]}`; detail adds an hourly `series` of tide / surge / total |
| `GET /alerts?min_level=&county=` | `{counts_by_type, alerts: [{type: river\|surface_water\|groundwater\|coastal, id, name, county, lat, lon, level, headline, time_utc, score}]}`, most severe first |
| `POST /ask` | `{question, history?, at?}` → `{answer, tools_used, model}`; see *Ask Floodline* below |
| `GET /demo/surface-water?at=` / `/demo/groundwater?at=` / `/demo/alerts?at=` | Replay versions (`forecast_source: "proxy"`); `/demo/coastal` returns `status: "unavailable"` with the reason |

Demo snapshots are precomputed into `data/demo.parquet` (by `demo-build`, or at server start if
missing). Decisions are applied per request, so `/settings` changes show up in the replay too.

## Ask Floodline (open-weights agent)

`POST /ask` answers plain-text questions about the current data and how the system works. It
runs **Qwen3 8B** (Apache-2.0 open weights) locally through [Ollama](https://ollama.com); no
hosted LLM API is involved.

```bash
ollama pull qwen3:8b        # ~5 GB, once
ollama serve                # if the Ollama app isn't already running
```

The harness is our own (`src/floodline/agent.py`, no agent framework). It gives the model a
system prompt and five read-only tools that run against the server's in-memory state. A
`/ask` call returns 503 rather than guessing when the model is unavailable.

| Tool | What it returns |
|---|---|
| `system_status` | Data freshness, per-source health and the model's test accuracy (a trimmed `/data-status`) |
| `river_risk` | Gauges ranked by risk, filterable by county / status, with counts per status |
| `station_detail` | One gauge by name or id: probabilities, uncertainty band, decision inputs, 72 h level summary, top 5 SHAP factors |
| `alerts` | The combined river / surface water / groundwater / coastal list (`/alerts`) |
| `search_docs` | Keyword search over the sections of this file, for "how does it work" questions |

The loop allows up to 6 tool rounds, then forces an answer. If the model tries to answer
before calling any tool, it is nudged once to look the answer up first, and its text is only
streamed after a lookup has run. Without this, Qwen3 8B sometimes answered replay questions
from general knowledge and named the wrong counties. Thinking mode is off and temperature is 0.2.

Body `{"question": "...", "history": [{"role": "user"|"assistant", "content": "..."}], "at": null, "stream": false}`.
With `at` set, the river and hazard tools read the Storm Chandra replay snapshot instead of
live data. Without `stream`, the response is `{answer, tools_used: [{tool, args}], model}`. With
`"stream": true` it is NDJSON events (the frontend uses this): `tool` (a lookup ran), `delta`
(answer text), `reset` (discard text so far), `done` (`tools_used`, `model`), or `error`. Returns 503
with a hint if Ollama isn't running or the model isn't pulled. Tests (`tests/test_agent.py`)
replace the model with a scripted stub, so they run offline.

Observed on a MacBook Air M4 (24 GB) with the model already loaded: Qwen3 8B generates ~19 tokens/s.
The first lookup lands after ~6 s, answer text starts at ~10–20 s, and a full answer takes
~15–35 s. `FLOODLINE_LLM_MODEL=qwen3:4b` roughly halves that, at some cost in accuracy.

## Licences and attribution

- OPW water levels: "Contains Irish Public Sector Information licensed under a Creative Commons
  Attribution 4.0 International (CC BY 4.0) licence (source http://waterlevel.ie - provided by
  the Office of Public Works.)" OPW asks automated users to tell them at waterlevel@opw.ie (with
  server IP / URL). Only stations 00001–41000 may be republished.
- Open-Meteo: weather data by Open-Meteo.com, CC BY 4.0 (the free API is non-commercial only).
- CFRAM flood maps (OPW): CC BY-NC-ND 4.0.
- Copernicus EMS (EMSR860) and GFM: "© European Union, Copernicus Emergency Management Service".
- Sentinel data: "Contains modified Copernicus Sentinel data [year]".
- County boundaries: Natural Earth (public domain).
- Soil drainage: EPA / Teagasc National Soils Hydrology Map, CC BY 4.0.
- NIFM and national coastal flood extents (OPW): as CFRAM, CC BY-NC-ND 4.0.
- GSI groundwater and 2015/16 surface-water flood maps: Geological Survey Ireland, CC BY-NC-ND 4.0
  (used for statistics and zone points only; polygons are shown from GSI's WMS).
- Marine Institute tide and surge predictions: CC BY 4.0.
- Hi-res rain via Open-Meteo, from the UK Met Office (UKV 2 km), KNMI and DMI (HARMONIE-AROME).

## Known limitations

- **P95 is a proxy for flooding**, not a flood threshold. It is exceeded often in wet winters,
  and flooding at a given gauge may start well above or below it. Station-specific thresholds
  from councils should replace it where they exist.
- **Training uses perfect-forecast rain.** The archive stands in for the forecast, so reported
  skill is optimistic; live skill depends on the ensemble.
- **The demo forecast is a proxy.** Archive rain after each snapshot stands in for the
  ensemble median. Spread comes from today's live ensemble shape for the same cell, scaled.
  Levels and past rain use only data available at each snapshot.
- **Rain is on a 0.5° grid** on the free tier (~50 km cells), which smooths convective
  storms on small catchments.
- **Satellite layers are observations, not warnings.** They arrive 6–48 h after acquisition, and
  Sentinel-1 revisits Ireland every 2–4 days, so they confirm flooding rather than warn of it.
  EMSR860 covers only the AOIs Copernicus mapped (Kilkenny delivered, Wexford not).
- **GFM** was verified against a live account on 2026-10-03: archives contain `ENSEMBLE_FLOOD` /
  `ENSEMBLE_OBSWATER` binary GeoTIFFs (1 = flood/water, 255 = nodata), which are polygonised; the
  bundled unfiltered flood GeoJSON is ignored when the GeoTIFF is present.
- OPW past-flood records (floodinfo.ie) are not included: they are released on request only.
  That is also why the surface-water, groundwater and coastal indicators are uncalibrated rules.
  With the records (or council incident logs) the thresholds and weights could be fitted.
- **Surface water at 10 km** can only say "this area, these hours". Real surface flooding
  depends on gullies, culverts and drains that no open dataset describes. "Made ground" on the
  soil map catches big towns well (Dublin, Cork) but misses much of smaller towns.
- **Groundwater** uses a 3-year rain record for percentiles (short for 98th-percentile
  extremes) and no live groundwater levels: GSI's gwlevel.ie network has no machine-readable
  feed we could find.
- **Coastal** ignores waves and overtopping, and model points away from tide gauges are
  referenced to mean sea level rather than OD Malin (typically within ~0.2 m).
- 17 stations had no Hydro-Data archive and use only the 5-week fallback, so they have no
  training history. They still get scored via the pooled model.
