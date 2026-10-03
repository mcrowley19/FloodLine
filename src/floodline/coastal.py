"""Coastal flood indicator from Marine Institute tide + storm-surge forecasts (next 48 h).

Each surge forecast point gets thresholds from the nearest Marine Institute tide-prediction
station (within 40 km): P95 and P99 of predicted high water over 2026-2028 (OD Malin), i.e.
roughly the biggest spring tides of a typical year. With total = tide + surge:

  HIGH      total >= P99 + 0.3 m
  MODERATE  total >= P99
  WATCH     total >= P95, or surge >= 0.4 m
  CLEAR     otherwise

Points without a nearby tide station use surge alone (MODERATE >= 0.6 m, WATCH >= 0.4 m).
Caveats: model points away from tide gauges are referenced to mean sea level rather than OD
Malin (typically within ~0.2 m); waves and wave overtopping are not included.
"""

from __future__ import annotations

import io
import logging

import httpx
import polars as pl

from . import http
from .config import URLS

log = logging.getLogger("floodline.coastal")

LEVELS = ("CLEAR", "WATCH", "MODERATE", "HIGH")


async def fetch_surge(c: httpx.AsyncClient, hours: int = 48) -> pl.DataFrame:
    url = (
        f"{URLS['erddap']}/imiSurgePrediction.csv?stationID,time,sea_surface_elevation_due_to_tide,"
        f"sea_surface_elevation_due_to_storm_surge&time%3E=now-1hour&time%3C=now%2B{hours}hours"
    )
    r = await http.get(c, url, timeout=180)
    r.raise_for_status()
    df = pl.read_csv(io.StringIO(r.text), skip_rows_after_header=1)
    return df.rename({"stationID": "station_id", "sea_surface_elevation_due_to_tide": "tide", "sea_surface_elevation_due_to_storm_surge": "surge"}).with_columns(
        pl.col("time").str.to_datetime("%Y-%m-%dT%H:%M:%SZ", time_zone="UTC"),
        pl.col("tide").cast(pl.Float64),
        pl.col("surge").cast(pl.Float64),
        (pl.col("tide") + pl.col("surge")).alias("total"),
    )


def assess_station(st: dict, series: pl.DataFrame) -> dict:
    if series.height == 0:
        return {**st, "level": "CLEAR", "data": "no forecast"}
    i = int(series["total"].arg_max())
    peak = series.row(i, named=True)
    max_surge = float(series["surge"].max())
    p95, p99 = st.get("hw_p95"), st.get("hw_p99")
    total = peak["total"]
    if p99 is not None:
        if total >= p99 + 0.3:
            level = "HIGH"
        elif total >= p99:
            level = "MODERATE"
        elif total >= p95 or max_surge >= 0.4:
            level = "WATCH"
        else:
            level = "CLEAR"
    else:
        level = "MODERATE" if max_surge >= 0.6 else "WATCH" if max_surge >= 0.4 else "CLEAR"
    return {
        **st,
        "level": level,
        "peak_total_m": round(total, 3),
        "peak_utc": peak["time"].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tide_at_peak_m": round(peak["tide"], 3),
        "surge_at_peak_m": round(peak["surge"], 3),
        "max_surge_m": round(max_surge, 3),
        "margin_to_p99_m": round(total - p99, 3) if p99 is not None else None,
        "data": "ok",
    }


def assess_all(stations: pl.DataFrame, surge: pl.DataFrame) -> list[dict]:
    rows = [assess_station(st, surge.filter(pl.col("station_id") == st["station_id"]).sort("time")) for st in stations.iter_rows(named=True)]
    rows.sort(key=lambda r: (-LEVELS.index(r["level"]), -(r.get("margin_to_p99_m") or -9), -(r.get("max_surge_m") or 0)))
    return rows


def series_for(surge: pl.DataFrame, station_id: str) -> list[dict]:
    s = surge.filter(pl.col("station_id") == station_id).sort("time")
    s = s.filter(pl.col("time").dt.minute() == 0)  # hourly is plenty for a chart
    return [
        {"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "tide": round(a, 3), "surge": round(b, 3), "total": round(a + b, 3)}
        for t, a, b in zip(s["time"], s["tide"], s["surge"])
    ]
