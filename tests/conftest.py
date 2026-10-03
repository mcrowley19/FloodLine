"""Tiny synthetic dataset: 3 gauges whose levels respond to synthetic rain storms,
spanning train / validation / test / demo windows and running up to 'now'. Everything is
built offline through the real pipeline (features -> train -> demo)."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import numpy as np
import polars as pl
import pytest

STATIONS = [
    {"id": "00001", "ref": "0000000001", "name": "Alpha Bridge", "lat": 52.6, "lon": -7.0, "county": "Kilkenny"},
    {"id": "00002", "ref": "0000000002", "name": "Beta Weir", "lat": 53.3, "lon": -8.0, "county": "Galway"},
    {"id": "00003", "ref": "0000000003", "name": "Gamma Mill", "lat": 52.3, "lon": -6.5, "county": "Wexford"},
]
ACQ = "2026-01-29T18:13:00Z"


def _synthetic(start: datetime, end: datetime, seed: int):
    rng = np.random.default_rng(seed)
    times = pl.datetime_range(start, end, "1h", time_zone="UTC", eager=True)
    n = len(times)
    rain = np.where(rng.random(n) < 0.08, rng.gamma(1.2, 1.5, n), 0.0)
    for c in rng.choice(n - 48, size=n // 500, replace=False):  # storms
        rain[c : c + 24] += rng.gamma(2.0, 2.0, 24)
    # Force a storm just before Storm Chandra landfall for the demo window.
    k = int((datetime(2026, 1, 25, tzinfo=timezone.utc) - start).total_seconds() // 3600)
    rain[k : k + 36] += 4.0
    kernel = np.exp(-np.arange(96) / 20.0)
    level = 0.5 + 0.08 * np.convolve(rain, kernel)[:n] + rng.normal(0, 0.005, n)
    return times, rain.astype(np.float32), level.astype(np.float32)


@pytest.fixture(scope="session")
def synth_env(tmp_path_factory):
    root = tmp_path_factory.mktemp("floodline")
    mp = pytest.MonkeyPatch()
    mp.setenv("FLOODLINE_DATA", str(root / "data"))
    mp.setenv("FLOODLINE_MODELS", str(root / "models"))
    mp.setenv("FLOODLINE_RAIN_GRID", "0.5")
    for k in ("GFM_USER", "GFM_PASS", "CDSE_CLIENT_ID", "OPEN_METEO_API_KEY"):
        mp.delenv(k, raising=False)

    from floodline import demo, features, openmeteo, train
    from floodline.config import paths

    p = paths()
    for d in (p.levels, p.rain, p.emsr):
        d.mkdir(parents=True, exist_ok=True)
    start = datetime(2024, 10, 1, tzinfo=timezone.utc)
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    st = openmeteo.assign_cells(pl.DataFrame(STATIONS).with_columns(pl.lit(None, pl.Utf8).alias("catchment"), pl.lit(None, pl.Float64).alias("gauge_datum")))
    st.write_parquet(p.stations)
    for i, s in enumerate(STATIONS):
        times, rain, level = _synthetic(start, end, seed=i)
        pl.DataFrame({"time": times, "level": level}).write_parquet(p.levels / f"{s['id']}.parquet")
        cell = st.filter(pl.col("id") == s["id"])["rain_cell"][0]
        pl.DataFrame({"time": times, "precip": rain}).write_parquet(p.rain / f"{cell}.parquet")

    poly = {"type": "Polygon", "coordinates": [[[-6.95, 52.54], [-6.94, 52.54], [-6.94, 52.55], [-6.95, 52.54]]]}
    (p.emsr / "kilkenny.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"aoi": "County Kilkenny", "product": "EMSR860_AOI02_DEL_MONIT01_observedEventA", "acquisition_utc": ACQ}, "geometry": poly}]})
    )
    (p.emsr / "_index.json").write_text("{}")

    _write_hazards(p, end)
    features.build_all()
    train.train_all()

    async def no_live_ensemble():
        return {}

    mp.setattr(demo, "_live_members", no_live_ensemble)
    asyncio.run(demo.build())
    yield p
    mp.undo()


@pytest.fixture(scope="session")
def client(synth_env):
    from fastapi.testclient import TestClient

    from floodline.api import create_app

    with TestClient(create_app(start_background=False)) as c:
        yield c


HAZARD_CELLS = [  # cell_id, lat, lon, county, urban made_frac, poor_frac
    ("E640N650", 52.6, -7.0, "Kilkenny", 0.30, 0.40),
    ("E580N720", 53.3, -8.0, "Galway", 0.00, 0.10),
]


def _write_hazards(p, end: datetime) -> None:
    from floodline import surface
    from floodline.hazards import susceptibility

    h = p.hazards
    h.mkdir(parents=True, exist_ok=True)
    zero = 0.0
    rows = []
    for cid, lat, lon, county, made, poor in HAZARD_CELLS:
        rows.append({
            "cell_id": cid, "e_itm": 640000, "n_itm": 650000, "lat": lat, "lon": lon, "county": county, "land_frac": 1.0,
            "well_frac": 1 - made - poor, "imperfect_frac": zero, "poor_frac": poor, "very_poor_frac": zero, "peat_frac": zero,
            "alluvium_frac": 0.05, "made_frac": made, "water_frac": zero, "cfram_fluvial10_frac": 0.01, "nifm_fluvial100_frac": 0.02,
            "coastal10_frac": zero, "gw_high_frac": zero, "gw_medium_frac": zero, "gw_low_frac": zero, "gw_historic_frac": zero, "sw_2015_16_frac": 0.01,
        })
    cells = susceptibility(pl.DataFrame(rows))
    cells.write_parquet(h / "cells.parquet")
    square = lambda lat, lon: [[[lon, lat], [lon + 0.1, lat], [lon + 0.1, lat + 0.1], [lon, lat + 0.1], [lon, lat]]]
    (h / "cells.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": c[0], "properties": {"cell_id": c[0]}, "geometry": {"type": "Polygon", "coordinates": square(c[1], c[2])}} for c in HAZARD_CELLS]}))
    pl.DataFrame({"zone_id": ["gw-high-0", "gw-low-0"], "probability": ["high", "low"], "area_ha": [12.0, 3.0], "lat": [52.62, 53.31], "lon": [-7.02, -8.01]}).write_parquet(h / "groundwater_zones.parquet")
    pl.DataFrame({"station_id": ["Wexford_Bay"], "name": ["Wexford Bay"], "lat": [52.34], "lon": [-6.42], "tide_station": ["Wexford"], "tide_station_km": [2.4],
                  "hw_p95": [0.8], "hw_p99": [0.9], "coastal10_km2_within_10km": [25.0]}).write_parquet(h / "coastal_stations.parquet")
    (h / "_SUCCESS").write_text("ok")

    def rain_for(t0: datetime, t1: datetime, burst_at: datetime) -> dict:
        times = np.arange(np.datetime64(t0.replace(tzinfo=None), "h"), np.datetime64(t1.replace(tzinfo=None), "h"))
        drizzle = np.full((len(times), 3), 0.2, dtype=np.float32)
        burst = drizzle.copy()
        k = int((np.datetime64(burst_at.replace(tzinfo=None), "h") - times[0]).astype(int))
        if 0 <= k < len(times):
            burst[k] = 28.0  # downpour over the Kilkenny cell only
        return {HAZARD_CELLS[0][0]: (times, burst), HAZARD_CELLS[1][0]: (times, drizzle)}

    surface.save_rain(rain_for(end - timedelta(days=7), end + timedelta(days=3), end + timedelta(hours=6)), surface.live_rain_path())
    chandra = datetime(2026, 1, 26, 18, tzinfo=timezone.utc)
    surface.save_rain(rain_for(datetime(2026, 1, 14, tzinfo=timezone.utc), datetime(2026, 2, 2, tzinfo=timezone.utc), chandra), surface.demo_rain_path())
    t = pl.datetime_range(end, end + timedelta(hours=48), "10m", time_zone="UTC", eager=True)
    tide = np.sin(np.linspace(0, 8 * np.pi, len(t))) * 0.7
    p.live.mkdir(parents=True, exist_ok=True)
    pl.DataFrame({"station_id": ["Wexford_Bay"] * len(t), "time": t, "tide": tide, "surge": np.full(len(t), 0.55)}).with_columns(
        (pl.col("tide") + pl.col("surge")).alias("total")).write_parquet(p.live / "surge.parquet")
