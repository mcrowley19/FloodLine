"""Open-Meteo rainfall: historical archive, recent past, and the IFS + AIFS ensemble.

Requests are made per grid cell (stations snapped to `rain_grid_deg()`), not per station,
so the free tier's weighted call limits (600/min, 5,000/hour, 10,000/day) hold for an
Ireland-wide pull.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from datetime import date, datetime

import httpx
import numpy as np
import polars as pl

from . import http
from .config import ENSEMBLE_MODELS, URLS, rain_grid_deg

log = logging.getLogger("floodline.openmeteo")

ACCUM_WINDOWS = (6, 24, 48, 72, 120, 168)


class RateLimitExceeded(RuntimeError):
    pass


def cell_of(lat: float, lon: float, grid: float | None = None) -> tuple[float, float]:
    g = grid or rain_grid_deg()
    return round(round(lat / g) * g, 4), round(round(lon / g) * g, 4)


def cell_key(lat: float, lon: float) -> str:
    return f"{lat:.2f}_{lon:.2f}"


def assign_cells(stations: pl.DataFrame) -> pl.DataFrame:
    g = rain_grid_deg()
    cells = [cell_of(a, o, g) for a, o in zip(stations["lat"], stations["lon"])]
    return stations.with_columns(
        pl.Series("cell_lat", [c[0] for c in cells]),
        pl.Series("cell_lon", [c[1] for c in cells]),
        pl.Series("rain_cell", [cell_key(*c) for c in cells]),
    )


def _api_key() -> str | None:
    return os.environ.get("OPEN_METEO_API_KEY") or None


def _endpoint(kind: str) -> str:
    return URLS[f"{kind}_customer"] if _api_key() else URLS[kind]


def call_weight(n_locations: int, days: float, n_vars: int = 1) -> float:
    """Open-Meteo's fractional call count (documented: >2 weeks or >10 variables count extra)."""
    return n_locations * max(1.0, days / 14.0) * max(1.0, n_vars / 10.0)


class WeightLimiter:
    """Keeps weighted calls under a per-minute budget."""

    def __init__(self, per_minute: float = 540.0):
        self.per_minute = per_minute
        self.events: deque[tuple[float, float]] = deque()
        self.lock = asyncio.Lock()

    async def acquire(self, weight: float) -> None:
        if _api_key():
            return
        async with self.lock:
            while True:
                now = time.monotonic()
                while self.events and now - self.events[0][0] > 60:
                    self.events.popleft()
                used = sum(w for _, w in self.events)
                if not self.events or used + weight <= self.per_minute:
                    self.events.append((now, weight))
                    return
                await asyncio.sleep(max(1.0, 60 - (now - self.events[0][0]) + 0.5))


async def _om_get(c: httpx.AsyncClient, url: str, params: dict, limiter: WeightLimiter, weight: float):
    if key := _api_key():
        params = {**params, "apikey": key}
    for attempt in range(4):
        await limiter.acquire(weight)
        r = await http.get(c, url, params=params, timeout=180)
        if r.status_code == 200:
            js = r.json()
            return js if isinstance(js, list) else [js]
        reason = ""
        try:
            reason = r.json().get("reason", "")
        except Exception:
            reason = r.text[:200]
        if r.status_code == 429 and "minute" in reason.lower():
            log.info("Open-Meteo minutely limit hit; waiting 65 s")
            await asyncio.sleep(65)
            continue
        if r.status_code == 429:
            raise RateLimitExceeded(reason)
        raise RuntimeError(f"Open-Meteo HTTP {r.status_code}: {reason}")
    raise RateLimitExceeded("repeated minutely limit")


def _hourly_frame(obj: dict, var: str = "precipitation") -> pl.DataFrame:
    h = obj["hourly"]
    return pl.DataFrame(
        {
            "time": pl.Series(h["time"]).str.to_datetime("%Y-%m-%dT%H:%M", time_zone="UTC"),
            "precip": pl.Series(h[var], dtype=pl.Float32),
        }
    )


async def fetch_archive_cells(
    c: httpx.AsyncClient, cells: list[tuple[float, float]], start: date, end: date, limiter: WeightLimiter
) -> dict[tuple[float, float], pl.DataFrame]:
    """Hourly precipitation for a batch of cells from the archive API."""
    days = (end - start).days + 1
    js = await _om_get(
        c,
        _endpoint("archive"),
        {
            "latitude": ",".join(f"{a}" for a, _ in cells),
            "longitude": ",".join(f"{o}" for _, o in cells),
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "hourly": "precipitation",
            "timezone": "GMT",
        },
        limiter,
        call_weight(len(cells), days),
    )
    return {cell: _hourly_frame(obj) for cell, obj in zip(cells, js)}


def archive_batch_size(days: int, budget: float = 500.0) -> int:
    return max(1, min(50, int(budget // call_weight(1, days))))


async def fetch_recent_cells(
    c: httpx.AsyncClient, cells: list[tuple[float, float]], limiter: WeightLimiter, past_days: int = 31
) -> dict[tuple[float, float], pl.DataFrame]:
    """Recent observed-ish hourly rain (forecast API with past_days) to cover the archive's lag."""
    out: dict[tuple[float, float], pl.DataFrame] = {}
    for i in range(0, len(cells), 50):
        batch = cells[i : i + 50]
        js = await _om_get(
            c,
            _endpoint("forecast"),
            {
                "latitude": ",".join(f"{a}" for a, _ in batch),
                "longitude": ",".join(f"{o}" for _, o in batch),
                "hourly": "precipitation",
                "past_days": past_days,
                "forecast_days": 1,
                "timezone": "GMT",
            },
            limiter,
            call_weight(len(batch), past_days + 1),
        )
        out.update({cell: _hourly_frame(obj) for cell, obj in zip(batch, js)})
    return out


async def fetch_ensemble_cells(
    c: httpx.AsyncClient, cells: list[tuple[float, float]], limiter: WeightLimiter, days: int = 15
) -> dict[tuple[float, float], tuple[np.ndarray, np.ndarray, list[str]]]:
    """Pooled IFS + AIFS ensemble members per cell -> (times[datetime64], members[T, M], member names)."""
    out = {}
    n_vars = 102  # ~51 members x 2 models; used only for weight estimation
    per_req = max(1, int(450 // call_weight(1, days, n_vars)))
    for i in range(0, len(cells), per_req):
        batch = cells[i : i + per_req]
        js = await _om_get(
            c,
            _endpoint("ensemble"),
            {
                "latitude": ",".join(f"{a}" for a, _ in batch),
                "longitude": ",".join(f"{o}" for _, o in batch),
                "hourly": "precipitation",
                "models": ",".join(ENSEMBLE_MODELS),
                "forecast_days": days,
                "timezone": "GMT",
            },
            limiter,
            call_weight(len(batch), days, n_vars),
        )
        for cell, obj in zip(batch, js):
            h = obj["hourly"]
            names = [k for k in h if k.startswith("precipitation")]
            times = np.array([np.datetime64(t) for t in h["time"]], dtype="datetime64[h]")
            mat = np.array([[np.nan if v is None else v for v in h[k]] for k in names], dtype=np.float32).T
            out[cell] = (times, mat, names)
    return out


def summarise_members(times: np.ndarray, members: np.ndarray, now: datetime) -> dict:
    """Per-gauge ensemble summary from hour `now` onwards.

    members: [T, M] hourly precipitation. Members with no data at all are dropped; isolated
    gaps (e.g. hours before a model run's first step) count as 0 mm.
    """
    t0 = np.datetime64(now.replace(tzinfo=None, minute=0, second=0, microsecond=0), "h")
    sel = times >= t0
    m = members[sel]
    m = m[:, ~np.all(np.isnan(m), axis=0)] if m.size else m
    out: dict = {"n_members": int(m.shape[1]) if m.ndim == 2 else 0}
    if out["n_members"] == 0:
        return out
    cum = np.nancumsum(np.nan_to_num(m, nan=0.0), axis=0)
    for w in ACCUM_WINDOWS:
        acc = cum[min(w, len(cum)) - 1]
        out[f"rain{w}_p10"], out[f"rain{w}_p50"], out[f"rain{w}_p90"] = (float(x) for x in np.percentile(acc, [10, 50, 90]))
    acc48 = cum[min(48, len(cum)) - 1]
    out["p_rain48_gt20"] = float(np.mean(acc48 > 20))
    out["p_rain48_gt50"] = float(np.mean(acc48 > 50))
    out["acc48_members"] = acc48.astype(float).tolist()
    # 7-day fan: per-6h totals and running cumulative totals, p10/p50/p90 across members.
    fan = []
    for k in range(min(28, len(cum) // 6)):
        end = (k + 1) * 6 - 1
        block = cum[end] - (cum[end - 6] if end >= 6 else 0)
        p = np.percentile(block, [10, 50, 90])
        cp = np.percentile(cum[end], [10, 50, 90])
        fan.append(
            {
                "t": str(times[sel][end]) + ":00:00Z",
                "p10": round(float(p[0]), 2),
                "p50": round(float(p[1]), 2),
                "p90": round(float(p[2]), 2),
                "cum_p10": round(float(cp[0]), 2),
                "cum_p50": round(float(cp[1]), 2),
                "cum_p90": round(float(cp[2]), 2),
            }
        )
    out["fan"] = fan
    return out
