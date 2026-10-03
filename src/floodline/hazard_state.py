"""Live state for the non-river hazards: surface water, groundwater, coastal.

Shares rain with LiveState (ensemble members, recent rain) so no extra Open-Meteo calls are
made except the high-resolution surface-water rain (~2,500 weighted calls per refresh, every
FLOODLINE_SURFACE_REFRESH_H hours, default 12). Coastal forecasts come from the Marine
Institute ERDDAP (hourly).
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

import numpy as np
import polars as pl

from . import coastal, decision, groundwater, http, openmeteo, surface
from .config import COASTAL_REFRESH_S, SURFACE_REFRESH_S, paths, record_health, utcnow
from .service import LiveState, merge_rain

log = logging.getLogger("floodline.hazard_state")

LEVEL_RANK = {"CLEAR": 0, "WATCH": 1, "MODERATE": 2, "HIGH": 3}
RIVER_TO_LEVEL = {"FILL_NOW": "HIGH", "PREPARE": "MODERATE", "WATCH": "WATCH", "CLEAR": "CLEAR"}


def ensemble_summaries(live: LiveState, at: datetime) -> dict[str, dict]:
    return {k: openmeteo.summarise_members(t, m, at) for k, (t, m) in live.ens_members.items()}


def groundwater_wetness(zones: pl.DataFrame, at: datetime, recent: dict[str, pl.DataFrame], future7: dict[str, float] | None) -> dict[str, dict]:
    """Wetness per 0.5-degree rain cell; future7=None uses the archive after `at` (demo proxy)."""
    out = {}
    for key in {openmeteo.cell_key(*openmeteo.cell_of(a, o)) for a, o in zip(zones["lat"], zones["lon"])}:
        rp = paths().rain / f"{key}.parquet"
        if not rp.exists():
            continue
        rain = merge_rain(pl.read_parquet(rp), recent.get(key))
        fut = None if future7 is None else future7.get(key, 0.0)
        out[key] = groundwater.cell_wetness(rain, at, fut)
    return out


class HazardState:
    def __init__(self, live: LiveState):
        self.live = live
        h = paths().hazards
        self.cells = pl.read_parquet(h / "cells.parquet") if (h / "cells.parquet").exists() else None
        self.zones = pl.read_parquet(h / "groundwater_zones.parquet") if (h / "groundwater_zones.parquet").exists() else None
        self.coastal_stations = pl.read_parquet(h / "coastal_stations.parquet") if (h / "coastal_stations.parquet").exists() else None
        self.cells_geojson = json.loads((h / "cells.geojson").read_text()) if (h / "cells.geojson").exists() else None
        self.surface_rain = surface.load_rain(surface.live_rain_path())
        self.surface_fetched: datetime | None = self._mtime(surface.live_rain_path())
        surge_p = paths().live / "surge.parquet"
        self.surge: pl.DataFrame | None = pl.read_parquet(surge_p) if surge_p.exists() else None
        self.surge_fetched: datetime | None = self._mtime(surge_p)
        self.surface_rows: list[dict] = []
        self.groundwater_rows: list[dict] = []
        self.coastal_rows: list[dict] = []
        self.computed_at: datetime | None = None
        self._tasks: list[asyncio.Task] = []

    @staticmethod
    def _mtime(p) -> datetime | None:
        return datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc) if p.exists() else None

    @property
    def available(self) -> bool:
        return self.cells is not None

    # ----- refresh -----
    async def refresh_surface(self, c, force: bool = False) -> None:
        if self.cells is None:
            return
        if not force and self.surface_fetched and (utcnow() - self.surface_fetched).total_seconds() < SURFACE_REFRESH_S and self.surface_rain:
            return
        try:
            rain = await surface.fetch_hires(c, self.cells, openmeteo.WeightLimiter())
            self.surface_rain = rain
            self.surface_fetched = utcnow()
            surface.save_rain(rain, surface.live_rain_path())
            record_health("Open-Meteo hi-res (surface water)", True, f"{len(rain)} cells x {len(surface.HIRES_MODELS)} models")
        except Exception as e:
            log.warning("Surface-water rain refresh failed: %s", e)
            record_health("Open-Meteo hi-res (surface water)", False, str(e))

    async def refresh_coastal(self, c) -> None:
        if self.coastal_stations is None:
            return
        if self.surge_fetched and (utcnow() - self.surge_fetched).total_seconds() < COASTAL_REFRESH_S:
            return
        try:
            self.surge = await coastal.fetch_surge(c)
            self.surge_fetched = utcnow()
            (paths().live).mkdir(parents=True, exist_ok=True)
            self.surge.write_parquet(paths().live / "surge.parquet")
            record_health("Marine Institute surge", True, f"{self.surge['station_id'].n_unique()} points, to {self.surge['time'].max()}")
        except Exception as e:
            log.warning("Surge forecast refresh failed: %s", e)
            record_health("Marine Institute surge", False, str(e))

    def recompute(self) -> None:
        now = utcnow().replace(minute=0, second=0, microsecond=0)
        summaries = ensemble_summaries(self.live, now) if self.live.ens_members else {}
        if self.cells is not None:
            ens_p90 = surface.ensemble_p90_by_cell(self.cells, summaries)
            self.surface_rows = surface.assess_all(self.cells, self.surface_rain, now, ens_p90)
        if self.zones is not None:
            fut7 = {k: s.get("rain168_p50", 0.0) for k, s in summaries.items()}
            wet = groundwater_wetness(self.zones, now, self.live.recent_rain, fut7)
            self.groundwater_rows = groundwater.assess_zones(self.zones, wet, now)
        if self.coastal_stations is not None and self.surge is not None:
            self.coastal_rows = coastal.assess_all(self.coastal_stations, self.surge)
        for r in (*self.groundwater_rows, *self.coastal_rows):
            r["county"] = self.nearest_county(r["lat"], r["lon"])
        self.computed_at = utcnow()

    def nearest_county(self, lat: float, lon: float) -> str | None:
        if self.cells is None:
            return None
        if not hasattr(self, "_cell_xy"):
            self._cell_xy = (self.cells["lat"].to_numpy(), self.cells["lon"].to_numpy(), self.cells["county"].to_list())
        la, lo, names = self._cell_xy
        return names[int(np.argmin((la - lat) ** 2 + ((lo - lon) * 0.6) ** 2))]

    # ----- views -----
    def surface_detail(self, cell_id: str) -> dict | None:
        row = next((r for r in self.surface_rows if r["cell_id"] == cell_id), None)
        if row is None:
            return None
        cell = self.cells.filter(pl.col("cell_id") == cell_id).row(0, named=True)
        series = []
        if cell_id in self.surface_rain:
            times, mat = self.surface_rain[cell_id]
            lo = np.datetime64(surface.now_hour().replace(tzinfo=None), "h") - np.timedelta64(24, "h")
            for t, vals in zip(times, mat):
                if t >= lo:
                    series.append({"t": str(t) + ":00:00Z", **{m: (None if v != v else round(float(v), 2)) for m, v in zip(surface.HIRES_MODELS, vals)}})
        return {
            **row,
            "ground": {
                k: round(cell[k], 4)
                for k in ("land_frac", "well_frac", "imperfect_frac", "poor_frac", "very_poor_frac", "peat_frac", "made_frac", "alluvium_frac",
                          "nifm_fluvial100_frac", "cfram_fluvial10_frac", "coastal10_frac", "sw_2015_16_frac", "gw_high_frac", "gw_historic_frac",
                          "s_drainage", "s_ponding", "s_flood_prone")
            },
            "rain_hourly": series,
        }

    def coastal_detail(self, station_id: str) -> dict | None:
        row = next((r for r in self.coastal_rows if r["station_id"] == station_id), None)
        if row is None:
            return None
        return {**row, "series": coastal.series_for(self.surge, station_id) if self.surge is not None else []}

    # ----- lifecycle -----
    async def start(self) -> None:
        self._tasks.append(asyncio.create_task(self._loop()))

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()

    async def _loop(self) -> None:
        async with http.client() as c:
            while True:
                await self.refresh_surface(c)
                await self.refresh_coastal(c)
                try:
                    await asyncio.to_thread(self.recompute)
                    log.info("Hazards recomputed: surface %s, groundwater %s, coastal %s",
                             _counts(self.surface_rows), _counts(self.groundwater_rows), _counts(self.coastal_rows))
                except Exception:
                    log.exception("Hazard recompute failed")
                await asyncio.sleep(15 * 60)


def _counts(rows: list[dict]) -> dict:
    out = {k: 0 for k in LEVEL_RANK}
    for r in rows:
        out[r["level"]] += 1
    return out


# ---------- combined alerts ----------


def combined_alerts(river_rows: list[dict], surface_rows: list[dict], gw_rows: list[dict], coastal_rows: list[dict], min_level: str = "WATCH") -> list[dict]:
    """One list across hazard types, most severe first. River statuses map FILL_NOW->HIGH,
    PREPARE->MODERATE, WATCH->WATCH."""
    floor = LEVEL_RANK[min_level]
    out = []
    for r in river_rows:
        lvl = RIVER_TO_LEVEL[r["status"]]
        if LEVEL_RANK[lvl] >= floor:
            out.append({"type": "river", "id": r["id"], "name": r["name"], "county": r.get("county"), "lat": r["lat"], "lon": r["lon"], "level": lvl,
                        "headline": f"{r['name']}: {r['status'].replace('_', ' ').lower()} (P48h {r['p48']:.0%})", "time_utc": r.get("pred_cross_utc"), "score": r.get("risk", 0.0)})
    for r in surface_rows:
        if LEVEL_RANK[r["level"]] >= floor:
            out.append({"type": "surface_water", "id": r["cell_id"], "name": f"{r.get('county') or ''} {r['cell_id']}".strip(), "county": r.get("county"), "lat": r["lat"], "lon": r["lon"],
                        "level": r["level"], "headline": f"Peak {r.get('peak_1h_mm', 0)} mm/h, {r.get('peak_3h_mm', 0)} mm/3h; susceptibility {r['susceptibility']:.2f}",
                        "time_utc": r.get("peak_utc"), "score": r.get("priority", 0.0)})
    gw_by_cell: dict[str, dict] = {}
    for r in gw_rows:  # aggregate zones to one alert per rain cell to avoid 1,500 rows
        if LEVEL_RANK[r["level"]] < floor:
            continue
        g = gw_by_cell.setdefault(r["rain_cell"], {**r, "n_zones": 0, "area_ha_total": 0.0})
        g["n_zones"] += 1
        g["area_ha_total"] += r["area_ha"]
        if LEVEL_RANK[r["level"]] > LEVEL_RANK[g["level"]]:
            g["level"] = r["level"]
    for key, g in gw_by_cell.items():
        out.append({"type": "groundwater", "id": f"gw-{key}", "name": f"{g['n_zones']} GSI groundwater zone(s), {g.get('county') or 'unknown county'}", "county": g.get("county"), "lat": g["lat"], "lon": g["lon"],
                    "level": g["level"], "headline": f"Rain over 30-90 days at the {g.get('percentile', 0):.0%} percentile of the 3-year record; {g['area_ha_total']:.0f} ha of mapped zones",
                    "time_utc": None, "score": 100 * (g.get("percentile") or 0)})
    for r in coastal_rows:
        if LEVEL_RANK[r["level"]] >= floor:
            out.append({"type": "coastal", "id": r["station_id"], "name": r["name"], "county": r.get("county"), "lat": r["lat"], "lon": r["lon"], "level": r["level"],
                        "headline": f"Peak {r.get('peak_total_m')} m (tide {r.get('tide_at_peak_m')} + surge {r.get('surge_at_peak_m')}), P99 high water {r.get('hw_p99')} m",
                        "time_utc": r.get("peak_utc"), "score": 50 + 100 * (r.get("margin_to_p99_m") or 0)})
    out.sort(key=lambda a: (-LEVEL_RANK[a["level"]], -(a["score"] or 0)))
    return out


def iso(t):
    return decision.iso(t) if t else None
