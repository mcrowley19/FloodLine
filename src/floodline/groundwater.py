"""Groundwater (karst / turlough) flood indicator per GSI flood-probability zone.

Groundwater flooding follows weeks to months of rain, not single storms (2015/16 peaked
weeks after the December rain). For each zone's 0.5-degree rain cell we take the rain over
the last 30 / 60 / 90 days plus the next 7 days (ensemble median), and rank it against the
same rolling windows in that cell's 3-year archive. With p = the highest of the three
percentiles:

  base level: HIGH p >= 0.98, MODERATE p >= 0.93, WATCH p >= 0.85, else CLEAR
  zone level: base, downgraded one step for GSI "medium" zones and two for "low" zones
              (high-probability zones flood first), and one step from May to September
              (evaporation removes most summer rain before it recharges groundwater).

Rule-based and uncalibrated: a 3-year record is short for extreme percentiles, and GSI's
live groundwater/turlough levels are not used (no machine-readable feed was found).
"""

from __future__ import annotations

from datetime import datetime

import numpy as np
import polars as pl

from . import openmeteo

WINDOWS_D = (30, 60, 90)
FORECAST_D = 7
LEVELS = ("CLEAR", "WATCH", "MODERATE", "HIGH")
ZONE_OFFSET = {"high": 0, "medium": 1, "low": 2}


def daily(rain: pl.DataFrame) -> pl.DataFrame:
    return rain.group_by(pl.col("time").dt.truncate("1d").alias("day")).agg(pl.col("precip").sum()).sort("day")


def cell_wetness(rain: pl.DataFrame, at: datetime, future_7d: float | None) -> dict:
    """Percentile of (past W-7 days + next 7 days) against the archive's rolling W-day sums.

    `future_7d=None` means "use the archive itself after `at`" (demo proxy)."""
    d = daily(rain)
    if d.height < 120:
        return {"percentile": None, "data": "insufficient rain history"}
    days = d["day"].to_numpy()
    vals = d["precip"].to_numpy().astype(float)
    cs = np.concatenate([[0.0], np.cumsum(vals)])
    at_day = np.datetime64(at.replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0), "us")
    i = int(np.searchsorted(days, at_day, side="right"))  # days[:i] are <= at
    out: dict = {"data": "ok"}
    if future_7d is None:
        j = min(i + FORECAST_D, len(vals))
        future_7d = float(cs[j] - cs[i])
    out["rain_next_7d"] = round(future_7d, 1)
    pcts = []
    for w in WINDOWS_D:
        past = float(cs[i] - cs[max(i - (w - FORECAST_D), 0)])
        total = past + future_7d
        clim = cs[w:] - cs[:-w]
        pct = float(np.mean(clim <= total)) if clim.size else None
        out[f"rain_{w}d_incl_forecast"] = round(total, 1)
        out[f"pct_{w}d"] = round(pct, 3) if pct is not None else None
        if pct is not None:
            pcts.append(pct)
    out["percentile"] = round(max(pcts), 3) if pcts else None
    return out


def base_level(p: float | None) -> int:
    if p is None:
        return 0
    return 3 if p >= 0.98 else 2 if p >= 0.93 else 1 if p >= 0.85 else 0


def assess_zones(zones: pl.DataFrame, wet_by_cell: dict[str, dict], at: datetime) -> list[dict]:
    summer = at.month in (5, 6, 7, 8, 9)
    rows = []
    for z in zones.iter_rows(named=True):
        key = openmeteo.cell_key(*openmeteo.cell_of(z["lat"], z["lon"]))
        w = wet_by_cell.get(key, {"percentile": None, "data": "no rain cell"})
        idx = base_level(w.get("percentile")) - ZONE_OFFSET.get(z["probability"], 2) - (1 if summer else 0)
        rows.append({**z, "rain_cell": key, "level": LEVELS[max(idx, 0)], **{k: v for k, v in w.items()}, "seasonal_damping": summer})
    rows.sort(key=lambda r: (-LEVELS.index(r["level"]), -(r.get("percentile") or 0), -r["area_ha"]))
    return rows


def summarise(rows: list[dict]) -> dict:
    by = {lvl: 0 for lvl in LEVELS}
    for r in rows:
        by[r["level"]] += 1
    return by

