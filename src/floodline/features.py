"""Feature builder: one row per station per hour.

`compute_features` is the single source of truth used by training, live inference and demo
snapshots, so all three see identical feature definitions.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime

import numpy as np
import polars as pl

from .config import HORIZONS, MIN_VALID_HOURS, paths, utcnow

log = logging.getLogger("floodline.features")

LEVEL_LAGS = (1, 3, 6, 12, 24)
RAIN_PAST = {"rain_past_1h": 1, "rain_past_6h": 6, "rain_past_24h": 24, "rain_past_72h": 72, "rain_past_7d": 168, "rain_past_30d": 720}
RAIN_NEXT = {"rain_next_6h": 6, "rain_next_24h": 24, "rain_next_48h": 48, "rain_next_5d": 120, "rain_next_7d": 168}

FEATURES = [
    "level_now",
    *[f"level_lag{k}h" for k in LEVEL_LAGS],
    "rise_rate_3h",
    "rise_rate_6h",
    "pct_of_record",
    "level_to_p95",
    *RAIN_PAST,
    *RAIN_NEXT,
    "lat",
    "lon",
    "stn_p50",
    "stn_p95",
    "stn_max",
    "stn_std",
    "exposure",
    "station_id",
]
CATEGORICAL = ["station_id"]
LABELS = [f"label_{h}" for h in HORIZONS]


def _shift(a: np.ndarray, k: int) -> np.ndarray:
    """out[t] = a[t-k] (k>0, past) or a[t+|k|] (k<0, future); NaN outside the series."""
    out = np.full_like(a, np.nan, dtype=np.float64)
    if k > 0:
        out[k:] = a[:-k]
    elif k < 0:
        out[:k] = a[-k:]
    else:
        out[:] = a
    return out


def ffill(a: np.ndarray, limit: int) -> np.ndarray:
    """Forward-fill NaN gaps of at most `limit` steps."""
    out = a.astype(np.float64).copy()
    idx = np.where(~np.isnan(out), np.arange(len(out)), -1)
    np.maximum.accumulate(idx, out=idx)
    gap = np.arange(len(out)) - idx
    fill = np.isnan(out) & (idx >= 0) & (gap <= limit)
    out[fill] = out[idx[fill]]
    return out


def station_stats(level: np.ndarray) -> dict[str, float]:
    v = level[~np.isnan(level)]
    return {
        "stn_p50": float(np.percentile(v, 50)),
        "stn_p95": float(np.percentile(v, 95)),
        "stn_max": float(v.max()),
        "stn_std": float(v.std()),
        "n_valid": int(v.size),
    }


def future_max(level: np.ndarray, h: int) -> np.ndarray:
    """max(level[t+1 .. t+h]) ignoring NaN; NaN if the whole window is missing."""
    n = len(level)
    padded = np.concatenate([level.astype(np.float64), np.full(h, np.nan)])
    win = np.lib.stride_tricks.sliding_window_view(padded[1:], h)[:n]
    with np.errstate(all="ignore"):
        valid = (~np.isnan(win)).any(axis=1)
        out = np.full(n, np.nan)
        out[valid] = np.nanmax(win[valid], axis=1)
    return out


def compute_features(
    level: np.ndarray,
    rain: np.ndarray,
    stats: dict[str, float],
    record_sorted: np.ndarray,
    static: dict[str, float],
    with_labels: bool = True,
) -> dict[str, np.ndarray]:
    """All features (and labels) on a complete hourly grid.

    level: hourly mean level (NaN = missing). rain: hourly precipitation, where rain[t] is the
    accumulation over the hour ending at t (Open-Meteo convention). Future-rain columns here
    come from the same series (perfect-forecast proxy); inference overwrites them.
    """
    n = len(level)
    lv = ffill(level, 3)
    f: dict[str, np.ndarray] = {"level_now": lv}
    for k in LEVEL_LAGS:
        f[f"level_lag{k}h"] = _shift(lv, k)
    f["rise_rate_3h"] = (lv - f["level_lag3h"]) / 3.0
    f["rise_rate_6h"] = (lv - f["level_lag6h"]) / 6.0
    pct = np.searchsorted(record_sorted, np.nan_to_num(lv, nan=-1e9), side="right") / max(len(record_sorted), 1)
    f["pct_of_record"] = np.where(np.isnan(lv), np.nan, pct)
    f["level_to_p95"] = lv - stats["stn_p95"]

    r = np.nan_to_num(rain.astype(np.float64), nan=0.0)
    cs = np.concatenate([[0.0], np.cumsum(r)])  # cs[i] = sum r[0..i-1]
    idx = np.arange(n)
    for name, w in RAIN_PAST.items():
        lo = np.maximum(idx + 1 - w, 0)
        f[name] = cs[idx + 1] - cs[lo]
    for name, w in RAIN_NEXT.items():
        hi = np.minimum(idx + 1 + w, n)
        vals = cs[hi] - cs[idx + 1]
        vals[idx + w >= n] = np.nan  # incomplete window at the end of the record
        f[name] = vals

    for k in ("lat", "lon", "exposure"):
        f[k] = np.full(n, static[k])
    for k in ("stn_p50", "stn_p95", "stn_max", "stn_std"):
        f[k] = np.full(n, stats[k])
    f["station_id"] = np.full(n, static["station_code"])

    if with_labels:
        for h in HORIZONS:
            fm = future_max(level, h)
            f[f"label_{h}"] = np.where(np.isnan(fm), np.nan, (fm >= stats["stn_p95"]).astype(float))
    return f


def hourly_grid(df: pl.DataFrame, start: datetime, end: datetime, col: str) -> np.ndarray:
    grid = pl.datetime_range(start, end, "1h", time_zone="UTC", eager=True).alias("time").to_frame()
    return grid.join(df.select("time", pl.col(col).cast(pl.Float64)), on="time", how="left")[col].to_numpy()


def load_station_inputs(sid: str, rain_cell: str) -> tuple[pl.DataFrame, pl.DataFrame] | None:
    p = paths()
    lp = p.levels / f"{sid}.parquet"
    rp = p.rain / f"{rain_cell}.parquet"
    if not lp.exists():
        return None
    lev = pl.read_parquet(lp)
    if rp.exists():
        rain = pl.read_parquet(rp)
    else:  # nearest available cell
        cands = list(p.rain.glob("*.parquet"))
        if not cands:
            rain = pl.DataFrame(schema={"time": pl.Datetime("us", "UTC"), "precip": pl.Float32})
        else:
            la, lo = (float(x) for x in rain_cell.split("_"))

            def dist(q):
                a, o = (float(x) for x in q.stem.split("_"))
                return (a - la) ** 2 + (o - lo) ** 2

            rain = pl.read_parquet(min(cands, key=dist))
    return lev, rain


def exposure_map() -> dict[str, float]:
    p = paths().exposure
    if not p.exists():
        return {}
    df = pl.read_parquet(p)
    return dict(zip(df["id"], df["exposure"]))


def build_all() -> None:
    """Write data/features/<id>.parquet for every station with >= MIN_VALID_HOURS of level data."""
    p = paths()
    p.features.mkdir(parents=True, exist_ok=True)
    stations = pl.read_parquet(p.stations).sort("id")
    expo = exposure_map()
    codes, static_rows = {}, []
    kept = 0
    for r in stations.iter_rows(named=True):
        inp = load_station_inputs(r["id"], r["rain_cell"])
        if inp is None:
            continue
        lev, rain = inp
        lev = lev.filter(pl.col("level").is_not_null() & pl.col("level").is_not_nan())
        if lev.height < MIN_VALID_HOURS:
            log.info("Dropping %s (%s): %d valid hours", r["id"], r["name"], lev.height)
            continue
        start, end = lev["time"].min(), lev["time"].max()
        level = hourly_grid(lev, start, end, "level")
        rain_arr = hourly_grid(rain, start, end, "precip") if rain.height else np.zeros_like(level)
        stats = station_stats(level)
        if stats["stn_std"] <= 1e-6:
            log.info("Dropping %s: flat-lined series", r["id"])
            continue
        code = len(codes)
        codes[r["id"]] = code
        static = {"lat": r["lat"], "lon": r["lon"], "exposure": float(expo.get(r["id"], 1.0)), "station_code": code}
        f = compute_features(level, rain_arr, stats, np.sort(level[~np.isnan(level)]), static)
        df = pl.DataFrame({k: v.astype(np.float32) for k, v in f.items()}).with_columns(
            pl.datetime_range(start, end, "1h", time_zone="UTC", eager=True).alias("time"),
            pl.lit(r["id"]).alias("id"),
            pl.Series("level_raw", level.astype(np.float32)),
            pl.col("station_id").cast(pl.Int32),
        )
        df = df.filter(pl.col("level_now").is_not_nan())
        df.write_parquet(p.features / f"{r['id']}.parquet")
        static_rows.append({"id": r["id"], **{k: v for k, v in stats.items()}, **static})
        kept += 1
    meta = {"station_codes": codes, "features": FEATURES, "categorical": CATEGORICAL, "built_utc": utcnow().isoformat()}
    (p.features / "_meta.json").write_text(json.dumps(meta, indent=1))
    pl.DataFrame(static_rows).write_parquet(p.features / "_static.parquet")
    (p.features / "_SUCCESS").write_text(str(kept))
    log.info("Features: %d stations written", kept)


def load_static() -> pl.DataFrame:
    return pl.read_parquet(paths().features / "_static.parquet")


def load_meta() -> dict:
    return json.loads((paths().features / "_meta.json").read_text())
