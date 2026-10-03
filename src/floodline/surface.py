"""Surface-water (pluvial) flood indicator per 10 km cell.

Rule-based, not trained: there is no open record of surface-water flood events in Ireland
to learn from (OPW's past-flood archive is release-on-request), so this combines

- rain: hourly precipitation from three ~2 km convection-permitting models over Ireland
  (UK Met Office UKV 2 km, KNMI and DMI HARMONIE-AROME) via Open-Meteo, plus the ECMWF
  ensemble 24 h p90 from the river forecast;
- ground: the cell's susceptibility (drainage, observed 2015/16 ponding, flood-prone ground;
  see hazards.py) and antecedent wetness (past 7 days of rain).

Base thresholds (mm): 20 in 1 h, 30 in 3 h, 40 in 24 h. They are lowered by up to 20% for
susceptible ground and up to 15% for saturated ground (combined floor 70%, so a 24 h total
never alerts below 28 mm: in a wet winter every cell is saturated, and a deeper cut flagged
~40% of the country during Storm Chandra). The hazard ratio
R = max over windows of rain / effective threshold:

  HIGH      R >= 1.5 and at least 2 of the 3 models exceed their effective threshold
  MODERATE  R >= 1.0
  WATCH     R >= 0.7
  CLEAR     otherwise

Priority (0-100) = R x (0.25 + 0.75 x min(1, urban share / 0.3)), scaled across cells, so
alerts over towns rank above the same rain over bog.
"""

from __future__ import annotations

import logging
from datetime import date, datetime

import httpx
import numpy as np
import polars as pl

from . import openmeteo
from .config import paths, utcnow

log = logging.getLogger("floodline.surface")

HIRES_MODELS = ("ukmo_uk_deterministic_2km", "knmi_harmonie_arome_europe", "dmi_harmonie_arome_europe")
BASE_T = {"1h": 20.0, "3h": 30.0, "24h": 40.0}
LEVELS = ("CLEAR", "WATCH", "MODERATE", "HIGH")
PAST_DAYS = 7


def _batches(cells: pl.DataFrame, n: int = 100):
    for i in range(0, cells.height, n):
        yield cells.slice(i, n)


def _parse(obj: dict) -> tuple[np.ndarray, np.ndarray]:
    h = obj["hourly"]
    times = np.array(h["time"], dtype="datetime64[h]")
    cols = [k for k in h if k.startswith("precipitation")]
    mat = np.array([[np.nan if v is None else v for v in h[k]] for k in cols], dtype=np.float32).T
    if mat.shape[1] < len(HIRES_MODELS):  # single-model responses drop the suffix
        mat = np.pad(mat, ((0, 0), (0, len(HIRES_MODELS) - mat.shape[1])), constant_values=np.nan)
    return times, mat


async def fetch_hires(
    c: httpx.AsyncClient, cells: pl.DataFrame, limiter: openmeteo.WeightLimiter, start: date | None = None, end: date | None = None
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Hourly rain [T, 3 models] per cell. Live: past 7 days + ~3 days ahead. With start/end:
    the historical-forecast archive (used for the Storm Chandra replay)."""
    out = {}
    for b in _batches(cells, 50):
        params = {
            "latitude": ",".join(str(x) for x in b["lat"]),
            "longitude": ",".join(str(x) for x in b["lon"]),
            "hourly": "precipitation",
            "models": ",".join(HIRES_MODELS),
            "timezone": "GMT",
        }
        if start is None:
            params |= {"past_days": PAST_DAYS, "forecast_days": 3}
            url, days = openmeteo._endpoint("forecast"), PAST_DAYS + 3
        else:
            params |= {"start_date": start.isoformat(), "end_date": end.isoformat()}
            url, days = openmeteo._endpoint("historical_forecast"), (end - start).days + 1
        # Open-Meteo appears to count each model separately (observed 429s at 1x), so weight x3.
        js = await openmeteo._om_get(c, url, params, limiter, openmeteo.call_weight(b.height, days) * len(HIRES_MODELS))
        for cid, obj in zip(b["cell_id"], js):
            out[cid] = _parse(obj)
    return out


def _roll_max(x: np.ndarray, w: int) -> tuple[float, int]:
    """Max rolling w-hour sum of a 1-D series (NaN = 0) and the index where that window ends."""
    if len(x) == 0:
        return 0.0, -1
    v = np.nan_to_num(x, nan=0.0)
    if len(v) < w:
        return float(v.sum()), len(v) - 1
    cs = np.concatenate([[0.0], np.cumsum(v)])
    s = cs[w:] - cs[:-w]
    i = int(np.argmax(s))
    return float(s[i]), i + w - 1


def wetness(past7: float) -> float:
    """0 when the last week had <= 10 mm, 1 at >= 50 mm."""
    return float(np.clip((past7 - 10.0) / 40.0, 0.0, 1.0))


def threshold_factor(susceptibility: float, wet: float) -> float:
    return max(0.7, 1.0 - 0.2 * susceptibility - 0.15 * wet)


def assess_cell(
    times: np.ndarray, mat: np.ndarray, at: datetime, susceptibility: float, urban_share: float, ens_rain24_p90: float | None = None
) -> dict:
    """Indicator for one cell as of `at` from hourly rain [T, models]."""
    t0 = np.datetime64(at.replace(tzinfo=None, minute=0, second=0, microsecond=0), "h")
    past = mat[(times > t0 - np.timedelta64(PAST_DAYS * 24, "h")) & (times <= t0)]
    fut_sel = (times > t0) & (times <= t0 + np.timedelta64(72, "h"))
    fut, ftimes = mat[fut_sel], times[fut_sel]
    past7 = float(np.nanmean(np.nansum(past, axis=0))) if past.size and not np.all(np.isnan(past)) else 0.0
    wet = wetness(past7)
    f = threshold_factor(susceptibility, wet)
    eff = {k: v * f for k, v in BASE_T.items()}

    per_model = []
    for m in range(fut.shape[1] if fut.ndim == 2 else 0):
        col = fut[:, m]
        if np.all(np.isnan(col)):
            continue
        p1, i1 = _roll_max(col, 1)
        p3, i3 = _roll_max(col, 3)
        p24, _ = _roll_max(col, 24)
        per_model.append({"model": HIRES_MODELS[m], "peak_1h": p1, "peak_3h": p3, "max_24h": p24, "peak_idx": i3})
    if not per_model:
        return {"level": "CLEAR", "ratio": 0.0, "data": "unavailable", "factor": round(f, 3), "rain_past_7d": round(past7, 1), "wetness": round(wet, 2), "models_available": 0}

    peak_1h = max(m["peak_1h"] for m in per_model)
    peak_3h = max(m["peak_3h"] for m in per_model)
    max_24h = float(np.mean([m["max_24h"] for m in per_model]))
    if ens_rain24_p90 is not None:
        max_24h = max(max_24h, ens_rain24_p90)
    ratios = {"1h": peak_1h / eff["1h"], "3h": peak_3h / eff["3h"], "24h": max_24h / eff["24h"]}
    driver = max(ratios, key=ratios.get)
    R = ratios[driver]
    agree = sum(1 for m in per_model if max(m["peak_1h"] / eff["1h"], m["peak_3h"] / eff["3h"], m["max_24h"] / eff["24h"]) >= 1.0)
    if R >= 1.5 and agree >= 2:
        level = "HIGH"
    elif R >= 1.0:
        level = "MODERATE"
    elif R >= 0.7:
        level = "WATCH"
    else:
        level = "CLEAR"
    worst = max(per_model, key=lambda m: m["peak_3h"])
    peak_time = ftimes[worst["peak_idx"]] if worst["peak_idx"] >= 0 else None
    return {
        "level": level,
        "ratio": round(R, 3),
        "driver": driver,
        "peak_1h_mm": round(peak_1h, 1),
        "peak_3h_mm": round(peak_3h, 1),
        "max_24h_mm": round(max_24h, 1),
        "peak_utc": (str(peak_time) + ":00:00Z") if peak_time is not None else None,
        "models_available": len(per_model),
        "models_agreeing": agree,
        "rain_past_7d": round(past7, 1),
        "wetness": round(wet, 2),
        "factor": round(f, 3),
        "thresholds_mm": {k: round(v, 1) for k, v in eff.items()},
        "priority_raw": R * (0.25 + 0.75 * min(1.0, urban_share / 0.3)),
        "data": "ok",
    }


def assess_all(cells: pl.DataFrame, rain: dict[str, tuple[np.ndarray, np.ndarray]], at: datetime, ens_p90: dict[str, float] | None = None) -> list[dict]:
    rows = []
    for c in cells.iter_rows(named=True):
        r = rain.get(c["cell_id"])
        base = {
            "cell_id": c["cell_id"],
            "county": c.get("county"),
            "lat": c["lat"],
            "lon": c["lon"],
            "susceptibility": round(c["susceptibility"], 3),
            "urban_share": round(c["urban_share"], 3),
            "poor_drainage_share": round((c["poor_frac"] + c["very_poor_frac"]) / max(c["land_frac"], 1e-6), 3),
            "peat_share": round(c["peat_frac"] / max(c["land_frac"], 1e-6), 3),
        }
        if r is None:
            rows.append({**base, "level": "CLEAR", "ratio": 0.0, "data": "unavailable"})
            continue
        a = assess_cell(r[0], r[1], at, c["susceptibility"], c["urban_share"], (ens_p90 or {}).get(c["cell_id"]))
        rows.append({**base, **a})
    top = max((r.get("priority_raw", 0.0) for r in rows), default=0.0)
    for r in rows:
        r["priority"] = round(100 * r.pop("priority_raw", 0.0) / top, 1) if top > 0 else 0.0
    rows.sort(key=lambda r: (-LEVELS.index(r["level"]), -r["priority"]))
    return rows


def ensemble_p90_by_cell(cells: pl.DataFrame, summaries: dict[str, dict]) -> dict[str, float]:
    """Nearest 0.5-degree ensemble cell's 24 h p90 for each hazard cell."""
    out = {}
    for c in cells.iter_rows(named=True):
        key = openmeteo.cell_key(*openmeteo.cell_of(c["lat"], c["lon"]))
        s = summaries.get(key)
        if s and "rain24_p90" in s:
            out[c["cell_id"]] = s["rain24_p90"]
    return out


def save_rain(rain: dict[str, tuple[np.ndarray, np.ndarray]], path) -> None:
    rows = []
    for cid, (times, mat) in rain.items():
        for j in range(mat.shape[1]):
            rows.append(pl.DataFrame({"cell_id": cid, "model": j, "time": times.astype("datetime64[us]"), "precip": mat[:, j]}))
    if rows:
        path.parent.mkdir(parents=True, exist_ok=True)
        pl.concat(rows).write_parquet(path)


def load_rain(path) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    if not path.exists():
        return {}
    df = pl.read_parquet(path)
    out = {}
    for (cid,), g in df.group_by("cell_id"):
        piv = g.pivot(on="model", index="time", values="precip").sort("time")
        cols = [str(j) for j in range(len(HIRES_MODELS))]
        mat = np.column_stack([piv[c2].to_numpy() if c2 in piv.columns else np.full(piv.height, np.nan) for c2 in cols]).astype(np.float32)
        out[cid] = (piv["time"].to_numpy().astype("datetime64[h]"), mat)
    return out


def live_rain_path():
    return paths().live / "surface_rain.parquet"


def demo_rain_path():
    return paths().hazards / "surface_rain_chandra.parquet"


DEMO_RAIN_START = date(2026, 1, 14)  # 7 days antecedent before the first snapshot
DEMO_RAIN_END = date(2026, 2, 2)  # 72 h beyond the last snapshot


def now_hour() -> datetime:
    return utcnow().replace(minute=0, second=0, microsecond=0)

