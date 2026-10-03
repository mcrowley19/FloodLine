# Floodline: project brief for building a pitch deck

> **For Claude:** this brief explains everything Floodline does, so you can build a pitch
> deck from it. Every number comes from the running system or its documentation (measured
> 3 October 2026). Don't invent figures, users, customers or traction. Where a number has a
> caveat, keep the caveat. Honesty about limits is part of the pitch. Screenshots and a
> video are listed at the end.

---

## 1. One-liner

**Floodline turns flood forecasts into deadlines.** For each of Ireland's 461 OPW river and lake
gauges it gives the probability of a flood-level rise within 6, 24, 48 and 120 hours. It then
converts that probability into one decision for the council: *when to start filling sandbags*,
plus the task list and supplies that follow from it.

- Built solo by **Michael Crowley** (Computer Science, Trinity College Dublin) at **Hack for
  Humanity Dublin 2026**: data pipeline, ML model, backend, dashboard and landing page.
- Intended user: the **county council's weather-and-flood liaison manager**. Ireland's national
  flood-forecasting plan already defines this person as the one who receives flood alerts.

---

## 2. The problem

Inquiries into recent floods keep finding that the forecast was rarely what failed. **The step
from "risk is high" to "here is what we do now" was.**

1. **Warnings arrive, but nobody turns them into action.**
   - *Ahr valley, Germany, 2021:* a state inquiry report of about 2,100 pages found the warnings
     came early enough, but agencies never turned them into instructions, evacuations or public
     alerts.
   - *Valencia, 2024:* a red alert went out at least 8 hours ahead. The public alert came at 8pm,
     when people were already driving home.
2. **Warnings cover areas that are too big, and nobody owns them.** Ireland has more than 1,000
   monitoring points but no single agency that issues flood warnings (Met Éireann does weather,
   OPW does rivers, councils fill the gaps). During Storm Chandra, South Dublin was caught "by
   surprise". Climatologist John Sweeney blamed "our obsession with county boundaries".
3. **The official service is slow.** Ireland's national flood forecasting service was decided in
   2016. In 2025 only €1.9m of its €4.3m budget was spent, and progress was called "glacial". In
   September 2026 Cabinet heard improvement plans with no completion date.
4. **There's no single shared picture.** After Storm Babet, the Lincolnshire responders' first
   lesson was the need for "single versions of what is happening and the level of risk".
5. **Resources are scarce and crews get tired.** Volunteers fill about 12 sandbags an hour. During
   Chandra, Dublin City Council had limited supplies and sent them only to places at immediate
   risk, and the national coordination group warned that crews were "starting to get fatigued".
6. **Plans don't fit reality.** In the Ahr valley, 75% of deaths happened outside mapped hazard
   zones. Cork's flood plan for Midleton was still a draft more than a year after Babet. 30 of 54
   Irish flood relief schemes are still at preliminary design, and Enniscorthy flooded again
   (Irish Times, 3 Oct 2026).

**The decision Floodline supports:** councils decide locally when to fill and place sandbags.
Fill too early and crews and stock are tied up for a flood that may not come. Fill too late and
the defence isn't in place when the river rises.

---

## 3. What Floodline does (product)

A web dashboard (dark UI, full-screen map of Ireland) with four tabs, plus a public landing page.

### Map tab
- **460 live gauges**, each coloured by status (FILL NOW / PREPARE / WATCH / CLEAR) and sized by
  risk. Risk = probability of crossing within 48 h × local flood exposure. Urgent gauges pulse.
- A sidebar counts gauges per status and ranks the highest-risk ones.
- Layers: rivers, county borders, **satellite-observed flooding** (Copernicus Sentinel-1 radar),
  and optional Sentinel-2 true-colour imagery when zoomed in.
- **Station panel** (click a gauge): the last 72 h of level against its flood threshold, a 7-day
  ensemble rainfall forecast (median plus p10–p90 band), the decision (fill-by time, bags needed,
  lead time, break-even probability), and the **top 5 SHAP factors** that explain the 24 h
  prediction. It also shows "Observed flooding 2.1 km away" when satellite flooding is within 3 km.

### Lead Times tab
- Hours left to each gauge's fill deadline.
- A **task schedule worked back from the predicted crossing**: rest centre on standby (−24 h),
  public warning (−18 h), sandbags filled (deadline), culvert screens cleared (−8 h), collection
  points open (−4 h).
- **Supplies to source now**: bags, sand, polythene sheeting, tipper loads and crew-hours,
  risk-weighted and pooled across gauges (ratios from USACE / NDSU sandbagging guidance).

### Data tab
- Health and freshness of every data source, and the model's test metrics. Councils can see
  what the system is running on.

### Ask tab ("Ask Floodline")
- Ask questions in plain English, e.g. "Which Kilkenny gauges are most at risk?"
- Answered by **Qwen3 8B, an open-weights LLM running locally** through Ollama. No hosted AI
  API is used and no data leaves the machine.
- The model can only answer through **five read-only tools** over live system state:
  `system_status`, `river_risk`, `station_detail`, `alerts`, `search_docs`. It must look data up
  before answering; it is nudged if it tries to answer from general knowledge. The UI shows which
  tools it used.
- Custom agent harness (no framework), streamed responses, at most 6 tool rounds.

### Storm Chandra replay (demo mode)
- Replays **Storm Chandra (22–30 January 2026)** in 33 six-hourly snapshots. A scrubber and play
  button step through the storm, and every tab (map, lead times, alerts) updates with it.
- Each snapshot uses **only data available at that moment**. The forecast is a proxy built from
  archived rain.
- Copernicus EMSR860 satellite flood polygons (Co. Kilkenny, Graiguenamanagh) fade in when the
  scrubber reaches the satellite acquisition time.

### Settings
- Every decision input (defence length, crews, fill rate, costs and so on) is a default that a
  council can **override per gauge or globally**. Changes apply immediately, including in the
  replay.

---

## 4. How it works

### 4a. Data pipeline
Python 3.11, httpx (async), polars, LightGBM. **No database**: each stage writes Parquet or
GeoJSON and is skipped when its output already exists. A full build took **about 17 minutes on a
MacBook Air** (461 gauges, 3 Oct 2026).

| Stage | Time | What it does |
|---|---|---|
| ingest | 8 min 07 s | 3 years of 15-min levels for 461 OPW gauges (hourly means, aligned to the live feed's datum); 3 years of hourly rain for 51 half-degree cells; CFRAM flood extents for exposure |
| features | 10 s | 10.6 million station-hours of features |
| train | 2 min 41 s | 4 LightGBM models, peak memory 3.7 GB |
| satellite-build | 2 s | Copernicus EMSR860 polygons and the latest GFM Sentinel-1 flood extent |
| hazards-build | ≈ 1.5 min | Soils, flood extents and groundwater maps summarised over 818 land cells of 10 km |
| demo-build | ≈ 3.5 min | 33 Storm Chandra snapshots, including archived hi-res rain forecasts |

After a server start, live risk for 460 stations is ready in about 3 s.

### 4b. Data sources (all open)
- **OPW waterlevel.ie**: live level every 15 min, plus the Hydro-Data archive for training (CC BY 4.0).
- **ECMWF IFS + AIFS ensembles** via Open-Meteo: about 102 pooled members over 15 days, giving
  per-gauge p10/p50/p90 rain totals, refreshed every 6 h.
- **Open-Meteo archive**: 3 years of hourly observed rain.
- **OPW CFRAM / NIFM flood extents**: exposure = km² of 10-year flood extent within 5 km of each gauge.
- **Copernicus EMS (EMSR860) and GFM**: Sentinel-1 radar maps of observed flooding.
- **EPA/Teagasc soils, Geological Survey Ireland groundwater maps, Marine Institute tide and
  surge**: inputs to the three non-river screens.
- **Hi-res rain models** (UK Met Office 2 km, KNMI and DMI HARMONIE-AROME): used for surface water.

### 4c. The model
- **Question per gauge and horizon H ∈ {6, 24, 48, 120} h:** will the maximum level in the next H
  hours reach this gauge's own 95th percentile (P95)?
- **One pooled LightGBM classifier per horizon**, trained on all gauges at once with the gauge id
  as a categorical feature.
- **Features per station-hour:** level now; lags of 1–24 h; 3 h and 6 h rise rates; percentile of
  the gauge's own record; distance to P95; rain over the past 1 h–30 days and the next 6 h–7 days;
  the gauge's P50/P95/max/spread; exposure; location.
- **Split:** train to Sept 2025, validate Oct–Dec 2025, test Jan–Feb 2026 (the Storm Chandra winter).
- **Calibration:** Platt-scaled on validation, so the probabilities are true probabilities. This
  matters because the decision layer compares them against a cost threshold.
- **Explainability:** SHAP values for each prediction appear in the station panel.

**Test results (Jan–Feb 2026, 461 gauges):**

| Horizon | Precision | Recall | AUC-PR | Base rate |
|---|---|---|---|---|
| 6 h | 0.92 | 0.89 | 0.97 | 0.17 |
| 24 h | 0.84 | 0.84 | 0.93 | 0.25 |
| 48 h | 0.80 | 0.83 | 0.91 | 0.31 |
| 120 h | 0.75 | 0.89 | 0.90 | 0.45 |

**Lead time:** over 1,605 real threshold crossings in the test period, the 24 h model alerted
13–24 h ahead for 1,115 and missed 100. The 48 h model alerted 25–48 h ahead for 1,312 and missed 43.

> **Caveat (keep it in the deck):** training and testing use *observed* future rain as a
> perfect-forecast stand-in, so these are upper bounds; live skill depends on the ensemble
> forecast. P95 is also a low bar in a wet winter (base rates 17–45%).

### 4d. The decision layer (the core idea)
Sandbagging is a **newsvendor problem**: the cost of filling bags that aren't needed weighed
against the cost of being short. For each gauge:

```
N  = defence length × bags per metre            (bags needed)
L  = N / (crews × fill rate) + travel + margin  (lead time needed to fill)
p* = c_fill·N / (c_fill·N + c_short)            (break-even probability)

Example: 100 m wall, 2 bags high → N = 1,500 bags
         2 crews × 100 bags/h    → L = 10.25 h
         c_fill = €2/bag, c_short = €50,000 → p* ≈ 0.057
```

- The four horizon probabilities are interpolated into a smooth, always-increasing curve
  P(crossing within t).
- **FILL NOW** if P(crossing within L) ≥ p*. **PREPARE** if within L + 24 h. **WATCH** if within
  120 h. Otherwise **CLEAR**.
- **Fill deadline = predicted crossing − L.** Every task deadline and supply quantity follows from this.
- A council doesn't need to understand ML. It sets its real constraints (wall length, crews,
  stock, costs) and gets a time.

### 4e. Beyond rivers: three other flood types
These are **rule-based screens, not trained models**, because there is no open record of these
flood events to learn from. All four types merge into one alert list.

- **Surface water** (818 cells of 10 km): peak 1 h / 3 h / 24 h rain over the next ~60 h from
  three ~2 km weather models, compared with thresholds that are lowered for poorly drained or
  saturated ground. HIGH needs two models to agree. Towns rank above bogs.
- **Groundwater** (1,505 GSI zones, mostly karst turloughs in the west and midlands): 30/60/90-day
  rain plus the 7-day forecast, ranked against each zone's own record.
- **Coastal** (40 Marine Institute surge points): tide + surge over the next 48 h against the
  95th/99th percentile of predicted high water.

---

## 5. Storm Chandra validation story

- The replay covers 22–30 January 2026, landfall on 27 January.
- Gauges at **FILL NOW rise from 168 on 22 Jan to 336 at landfall** (336 of 409 replayed gauges)
  and **peak at 344 on the evening of 29 Jan**.
- Honest framing: in a wet January many rivers were already above P95 days before the storm, so
  they read FILL NOW from the first snapshot. Graiguenamanagh on the Barrow is one of them.
- The surface-water screen's HIGH cells concentrate in **Wicklow, Wexford and Carlow around
  landfall**, the same areas named in the Copernicus emergency activation (Wexford,
  Graiguenamanagh, Aughrim). It also flags Cavan, Donegal and Monaghan, which can't be checked.
- **Satellite confirmation came after the fact:** the first Copernicus Sentinel-1 flood map for
  Kilkenny was acquired on **29 Jan at 18:13 UTC**, days after landfall. The Wexford products were
  never delivered. *This is the pitch in one fact: satellites confirm floods, they don't warn of
  them. Floodline warns.*

---

## 6. Architecture and stack

```
 OPW live + archive ─┐
 Open-Meteo / ECMWF ─┤   Python pipeline         FastAPI backend          React dashboard
 Copernicus EMS/GFM ─┼─▶ ingest → features → ─▶  /risk /station        ─▶ Map · Lead Times
 EPA / GSI / Marine ─┘   train → hazards →       /lead-times /alerts      Data · Ask
                         demo  (Parquet)         /satellite /demo/*       Storm Chandra replay
                                                 /ask ──▶ Qwen3 8B (local, via Ollama)
```

- **Backend:** Python 3.11, FastAPI, httpx, polars, LightGBM, numpy, geopandas/shapely, rasterio.
  No database (Parquet / GeoJSON files).
- **Frontend:** React 18, Vite, TypeScript, Tailwind v4, MapLibre GL (no map API key needed),
  TanStack Query, Zustand, Recharts, Turf.
- **AI agent:** Qwen3 8B (Apache-2.0 open weights) via Ollama, with a custom tool-calling harness.
- **Hosting (free):** static frontend on Render; the backend runs on a laptop exposed through a
  Tailscale Funnel tunnel (the server needs about 490 MB, too close to Render's 512 MB free limit).
- Live data refreshes every 2 minutes in the UI. Tests run offline on synthetic data.
- **Cost to run: effectively zero.** All the data is open, and the LLM runs locally.

---

## 7. Why Floodline is different
- **It outputs actions, not just probabilities.** Deadlines, tasks and supply lists answer the
  "warning arrived, nobody acted" failure from the Ahr and Valencia inquiries.
- **It works per gauge, not per county**, the most consistent complaint in the Chandra coverage.
- **It uses councils' own constraints as inputs:** stock, crews, fill rate, costs.
- **It shows its uncertainty:** ensemble rain bands, calibrated probabilities, SHAP explanations
  and a public list of known limitations.
- **It gives one shared view.** The council, Civil Defence and volunteers all see the same screen:
  the "single version of what is happening" Lincolnshire asked for.
- **It covers four flood types** in one alert list.
- **It's open and cheap.** Open data, open-weights AI, no vendor lock-in, runs on a laptop.
- **It was built in a hackathon** by one person while the official national service has been in
  development since 2016.

---

## 8. Known limitations (be upfront)
- **P95 is a proxy for flooding, not a real flood threshold.** Station-specific thresholds from
  councils should replace it.
- **Training uses perfect-forecast rain**, so the reported skill is optimistic.
- **Rain is on a ~50 km grid** on the free tier, which smooths out storms on small catchments
  (a commercial Open-Meteo key gives a finer grid).
- **The non-river screens are uncalibrated rules.** OPW's past-flood records are released only on
  request. With them, or with council incident logs, the screens could be fitted to real events.
- Some gauges have short records (about 5 weeks of summer data). About 70 tidal gauges (ports,
  estuaries) get false river alerts on spring tides.
- Satellite layers confirm flooding 6–48 h after the fact. They are not warnings.
- Commercial use needs an Open-Meteo subscription, and some flood maps are CC BY-NC-ND.

## 9. What's next (suggested asks / roadmap)
- **Pilot with one county council** (e.g. Kilkenny, Wexford or Cork) using its real defence
  lengths, crews and stock.
- **Get council flood thresholds and incident logs** to replace P95 and calibrate the surface-water,
  groundwater and coastal screens.
- Get **OPW past-flood records** and a commercial Open-Meteo key for a finer rain grid.
- Filter out tidal gauges, and add data-quality flags for short-record gauges.
- Add alert delivery (SMS/email to the liaison manager) and a shared view for Civil Defence and
  volunteer groups.

---

## 10. Available assets (in `docs/deck/` and `src/landing/assets/`)
| File | Shows |
|---|---|
| `docs/deck/map-chandra-peak.png` | Map in replay mode at the Storm Chandra peak |
| `docs/deck/station-detail.png` | Station panel: level vs P95, rain fan, fill-by deadline, SHAP |
| `docs/deck/lead-times.png` | Lead Times tab: deadlines, tasks, supplies |
| `docs/deck/ask-tab.png` | Ask Floodline answering a question with tool calls |
| `docs/deck/chandra-replay.mp4` | Video of the replay scrubbing through the storm |
| `src/landing/assets/problem-sandbags.jpg` | Council crew filling sandbags by a swollen river (illustration) |
| `src/landing/assets/night-flood.jpg` | Flooded Irish main street at night (illustration) |
| `src/landing/assets/hero-town-cartoon.jpg` | Landing-page hero town (illustration) |
| `src/landing/assets/michael-crowley.jpg` | Founder photo |

**Visual identity:** dark navy ocean (#0B2A4A sea, #163B5C land) with cyan accents (#4FC3F7,
#7FE3FF). Status colours run from red/orange (FILL NOW, PREPARE) through amber (WATCH) to calm
(CLEAR). Font: Inter.

## 11. Suggested deck flow (10–12 slides)
1. Title: "Floodline: flood lead times for Irish rivers"
2. Problem: warnings arrive but nobody acts (Ahr, Valencia, Chandra)
3. Why Ireland specifically: no single warning agency, a slow national service, county-level warnings
4. The decision: when to fill sandbags (too early vs too late)
5. Solution: the dashboard (map screenshot)
6. How it works: open data → ML probabilities → newsvendor decision → deadline and tasks
7. Model results, with the caveat
8. Storm Chandra replay (video or peak map); satellites confirm, Floodline warns
9. Ask Floodline: a local, open-weights AI grounded in live data
10. Beyond rivers: surface water, groundwater, coastal
11. Limitations and roadmap / the ask (pilot council, data access)
12. Built solo at Hack for Humanity Dublin 2026: Michael Crowley, TCD
