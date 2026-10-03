# Floodline

Ireland-wide flood lead-time backend for county councils. For every OPW river/lake gauge it
estimates the probability that the level reaches its own 95th percentile within 6 / 24 / 48 /
120 hours, turns that into a sandbag decision (newsvendor rule) with deadlines, and serves
satellite flood observations alongside. Includes a Storm Chandra (January 2026) replay.

Stack: Python 3.11, FastAPI, httpx (async), polars, LightGBM, numpy, geopandas/shapely,
rasterio. No database: Parquet / GeoJSON under `./data`, models under `./models`.

## Setup

```bash
uv sync                      # installs Python 3.11 + deps into .venv
uv run floodline all         # ingest -> features -> train -> satellite-build -> demo-build -> serve
uv run pytest                # tests (offline, synthetic data)
```

Individual stages: `uv run floodline ingest | features | train | satellite-build | demo-build | serve`.
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
| `FLOODLINE_DATA`, `FLOODLINE_MODELS` | Override `./data` and `./models`. |

## Observed timings

MacBook Air (M-series, 24 GB), home broadband, 3 October 2026, 461 gauges:

| Stage | Time | Notes |
|---|---|---|
| ingest | 8 min 07 s | OPW levels for 461 stations done in 2.5 min (10 concurrent); the rest is Open-Meteo's free-tier limiter (51 cells × 3 years ≈ 4,000 weighted calls, paced at ~540/min). CFRAM download + exposure (~1 min 45 s) runs concurrently. |
| features | 10 s | 10.6 M station-hours |
| train | 2 min 41 s | 4 models, peak RSS 3.7 GB |
| satellite-build | 2 s | EMSR860 + first GFM attempt |
| demo-build | 1 min 20 s | includes one live-ensemble fetch |
| **total** | **≈ 12.5 min** | well inside the 60-minute budget |

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

### Open-Meteo usage

The free tier (non-commercial) allows 600 / 5,000 / 10,000 weighted calls per minute / hour / day,
and 3 years of hourly data counts as ~80 calls per location. Requests are therefore made per
0.5° grid cell (51 cells for Ireland), not per gauge. A first ingest uses ~4,000; each 6-hourly
live refresh ~700. Re-running `ingest --force` on the same day as a full run can hit the daily
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
cost_short=50000`.

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

## API

All JSON / GeoJSON. CORS is open for `localhost` / `127.0.0.1` on any port.

| Endpoint | Returns |
|---|---|
| `GET /stations` | `[{id, name, lat, lon, county}]` |
| `GET /risk` | `[{id, name, lat, lon, level_now, p95, pct_of_record, p6, p24, p48, p120, risk, status, pred_cross_utc, fill_deadline_utc, bags_needed, rain48_p50, rain48_p90, as_of_utc, forecast_source}]`, risk desc |
| `GET /station/{id}` | The above plus `history_72h`, `ensemble_fan` (per 6 h: p10/p50/p90 totals and cumulative), `ensemble` summary, `decision_inputs`, `decision` (L, p*, P(≤L)), `uncertainty_rain_p10_p90` (probabilities re-run with ensemble p10 / p90 rain), `shap_top5_24h` (calibrated log-odds contributions) |
| `GET /lead-times` | `[{id, name, status, L, pred_cross_utc, fill_deadline_utc, hours_remaining, tasks: [{task, deadline_utc}]}]`. Tasks: rest centre standby (−24 h), public warning (−18 h), fill sandbags (deadline), clear culvert screens (−8 h), open collection points (−4 h). |
| `GET /satellite/latest?bbox=minLon,minLat,maxLon,maxLat` | GFM FeatureCollection clipped to bbox; `properties: {observed_at, source, status, reason}` |
| `GET /satellite/wms` | CDSE WMS config (`url`, `layer`, `max_cloud_cover_param: "MAXCC"`, GetMap params) or `{available: false}` |
| `GET /data-status` | Station / row counts, last live reading, model metrics, health of OPW, OPW live, Open-Meteo archive / recent / IFS / AIFS, CFRAM, GFM, EMSR860, CDSE WMS |
| `POST /settings` | Body `{"global": {...}, "stations": {"25017": {...}}}`; persisted to `data/settings.json`, applied immediately |
| `GET /demo/timeline` | 33 snapshots every 6 h, 2026-01-22T00Z → 2026-01-30T00Z, landfall flagged at 2026-01-27T00Z |
| `GET /demo/risk?at=` / `GET /demo/lead-times?at=` | Same shapes as live, as of the latest snapshot ≤ `at`, with `forecast_source: "proxy"` |
| `GET /demo/satellite?at=` | EMSR860 polygons with `acquisition_utc ≤ at` (empty before 2026-01-29T18:13Z) |

Demo snapshots are precomputed into `data/demo.parquet` (by `demo-build`, or at server start if
missing). Decisions are applied per request, so `/settings` changes show up in the replay too.

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
- **The GFM client is untested against a live account** (no credentials were available when
  building). It follows the published v2 API (login → AOI → products → download) and handles
  both raster and vector payloads, but expect to adjust layer-name matching on first use.
- OPW past-flood records (floodinfo.ie) are not included.
- 17 stations had no Hydro-Data archive and use only the 5-week fallback, so they have no
  training history. They still get scored via the pooled model.
