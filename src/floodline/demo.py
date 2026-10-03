"""Storm Chandra replay: risk as of each 6-hourly snapshot, 2026-01-22 -> 2026-01-30.

Only data that existed at each snapshot is used for levels and past rain. The "forecast" is
a proxy: archive rain from the snapshot onward stands in for the ensemble median, and the
spread (p10/p90, exceedance probabilities) is borrowed from the current live ensemble's shape
for the same cell, scaled to match. Every row is flagged forecast_source = "proxy".
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

import numpy as np
import polars as pl

from . import http, openmeteo
from .config import DEMO_END, DEMO_LANDFALL, DEMO_START, DEMO_STEP_H, HORIZONS, paths, utcnow
from .decision import iso
from .features import RAIN_NEXT
from .predict import Predictor

log = logging.getLogger("floodline.demo")

DEFAULT_SHAPE = {"r10": 0.4, "r90": 1.8}  # used when no live ensemble is available


def timeline() -> list[datetime]:
    n = int((DEMO_END - DEMO_START).total_seconds() // 3600 // DEMO_STEP_H) + 1
    return [DEMO_START + timedelta(hours=DEMO_STEP_H * i) for i in range(n)]


def timeline_payload() -> dict:
    return {
        "start_utc": iso(DEMO_START),
        "end_utc": iso(DEMO_END),
        "step_hours": DEMO_STEP_H,
        "landfall_utc": iso(DEMO_LANDFALL),
        "snapshots": [
            {"at": iso(t), "is_landfall": t == DEMO_LANDFALL, "hours_from_landfall": int((t - DEMO_LANDFALL).total_seconds() // 3600)}
            for t in timeline()
        ],
    }


def ensemble_shape(members: tuple[np.ndarray, np.ndarray] | None) -> dict:
    """Relative spread of the live ensemble (48 h accumulations), used to dress the proxy."""
    if members is None:
        return {**DEFAULT_SHAPE, "acc48_rel": None, "source": "default"}
    times, mat = members
    # First hour where (nearly) all members have data: IFS steps before its run time are empty.
    valid = np.mean(~np.isnan(mat), axis=1) > 0.9
    t0 = times[int(np.argmax(valid))].astype("datetime64[h]").astype(datetime)
    s = openmeteo.summarise_members(times, mat, t0)
    p50 = s.get("rain48_p50", 0.0)
    if not s.get("n_members") or p50 < 1.0:
        return {**DEFAULT_SHAPE, "acc48_rel": None, "source": "default"}
    acc = np.array(s["acc48_members"]) / p50
    return {"r10": s["rain48_p10"] / p50, "r90": s["rain48_p90"] / p50, "acc48_rel": acc, "source": "live-ensemble-scaled"}


async def _live_members() -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Live ensemble members per cell from the serve cache, fetching once if absent."""
    live = paths().live / "ensemble"
    out = {}
    if live.exists():
        for f in live.glob("*.npz"):
            z = np.load(f)
            out[f.stem] = (z["times"].astype("datetime64[h]"), z["members"])
    if out:
        return out
    stations = pl.read_parquet(paths().stations)
    cells = sorted({(a, o) for a, o in zip(stations["cell_lat"], stations["cell_lon"])})
    try:
        async with http.client() as c:
            ens = await openmeteo.fetch_ensemble_cells(c, cells, openmeteo.WeightLimiter())
        live.mkdir(parents=True, exist_ok=True)
        for cell, (times, mat, _) in ens.items():
            key = openmeteo.cell_key(*cell)
            out[key] = (times, mat)
            np.savez_compressed(live / f"{key}.npz", times=times.astype("datetime64[h]"), members=mat)
        (paths().live / "ensemble_meta.json").write_text(json.dumps({"fetched_utc": utcnow().isoformat()}))
    except Exception as e:
        log.warning("Live ensemble unavailable for demo shape (%s); using default spread", e)
    return out


async def build() -> None:
    p = paths()
    pred = Predictor()
    stations = pl.read_parquet(p.stations)
    members = await _live_members()
    shapes = {cell: ensemble_shape(members.get(cell)) for cell in set(stations["rain_cell"])}
    stamps = timeline()
    snaps, metas = [], []
    for st in stations.iter_rows(named=True):
        sid = st["id"]
        if sid not in pred.static:
            continue
        lp, rp = p.levels / f"{sid}.parquet", p.rain / f"{st['rain_cell']}.parquet"
        if not lp.exists():
            continue
        lo, hi = DEMO_START - timedelta(days=32), DEMO_END + timedelta(days=8)
        lv = pl.read_parquet(lp).filter(pl.col("time").is_between(lo, hi)).with_columns(pl.col("level").cast(pl.Float64))
        rain = pl.read_parquet(rp).filter(pl.col("time").is_between(lo, hi)) if rp.exists() else pl.DataFrame(schema={"time": pl.Datetime("us", "UTC"), "precip": pl.Float32})
        sc = pred.static[sid]
        shape = shapes[st["rain_cell"]]
        for at in stamps:
            row = pred.snapshot(sid, lv, rain, at, future=None)  # archive rain after `at` = proxy forecast
            if row is None:
                continue
            r48 = row["rain_next_48h"]
            r48 = 0.0 if r48 != r48 else r48
            if shape["acc48_rel"] is not None:
                acc = shape["acc48_rel"] * r48
                p20, p50 = float(np.mean(acc > 20)), float(np.mean(acc > 50))
            else:
                p20, p50 = float(r48 > 20), float(r48 > 50)
            for k in RAIN_NEXT:
                if row[k] != row[k]:
                    row[k] = 0.0
            snaps.append(row)
            metas.append(
                {
                    "at": at,
                    "id": sid,
                    "name": st["name"],
                    "county": st.get("county"),
                    "lat": st["lat"],
                    "lon": st["lon"],
                    "level_now": round(row["level_now"], 3),
                    "p95": round(sc["stn_p95"], 3),
                    "pct_of_record": round(100 * row["pct_of_record"], 1),
                    "exposure": sc["exposure"],
                    "rain48_p50": round(r48, 1),
                    "rain48_p10": round(r48 * shape["r10"], 1),
                    "rain48_p90": round(r48 * shape["r90"], 1),
                    "p_rain48_gt20": round(p20, 3),
                    "p_rain48_gt50": round(p50, 3),
                    "forecast_source": "proxy",
                    "forecast_shape": shape["source"],
                }
            )
    probs = pred.predict(snaps)
    df = pl.DataFrame(metas).with_columns(*[pl.Series(f"prob_{h}", probs[h].astype(np.float32)) for h in HORIZONS])
    df.write_parquet(p.demo)
    log.info("Demo: %d snapshot rows (%d stations x %d timestamps)", df.height, df["id"].n_unique() if df.height else 0, len(stamps))
    try:
        await build_hazards()
    except Exception:
        log.exception("Hazard replay failed; /demo/surface-water and /demo/groundwater will be empty")


def hazard_demo_paths():
    h = paths().hazards
    return h / "demo_surface.parquet", h / "demo_groundwater.parquet"


async def build_hazards() -> None:
    """Surface water from Open-Meteo's archived high-resolution forecasts (stitched model runs,
    so the 'forecast' after each snapshot is close to what fell: a proxy, like the river
    replay); groundwater from the rain archive with the next 7 days taken from the archive."""
    from . import surface
    from .hazard_state import groundwater_wetness
    from . import groundwater

    h = paths().hazards
    cells_p, zones_p = h / "cells.parquet", h / "groundwater_zones.parquet"
    surf_out, gw_out = hazard_demo_paths()
    if cells_p.exists():
        cells = pl.read_parquet(cells_p)
        rain_p = surface.demo_rain_path()
        rain = surface.load_rain(rain_p)
        if not rain:
            async with http.client() as c:
                rain = await surface.fetch_hires(c, cells, openmeteo.WeightLimiter(), surface.DEMO_RAIN_START, surface.DEMO_RAIN_END)
            surface.save_rain(rain, rain_p)
        rows = []
        for at in timeline():
            for r in surface.assess_all(cells, rain, at):
                r.pop("thresholds_mm", None)
                rows.append({"at": at, **r, "forecast_source": "proxy"})
        pl.DataFrame(rows, infer_schema_length=None).write_parquet(surf_out)
        log.info("Demo surface water: %d rows", len(rows))
    if zones_p.exists():
        zones = pl.read_parquet(zones_p)
        rows = []
        for at in timeline():
            wet = groundwater_wetness(zones, at, {}, None)
            for r in groundwater.assess_zones(zones, wet, at):
                rows.append({"at": at, **r, "forecast_source": "proxy"})
        pl.DataFrame(rows, infer_schema_length=None).write_parquet(gw_out)
        log.info("Demo groundwater: %d rows", len(rows))


def nearest_snapshot(at: datetime) -> datetime:
    """Latest snapshot at or before `at`, clamped to the timeline."""
    stamps = timeline()
    prior = [t for t in stamps if t <= at]
    return prior[-1] if prior else stamps[0]
