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
