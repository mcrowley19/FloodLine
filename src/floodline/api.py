"""FastAPI app: JSON/GeoJSON endpoints for the Floodline frontend."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import polars as pl
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import decision, demo, satellite
from .config import HORIZONS, paths, read_health, utcnow
from .hazard_state import LEVEL_RANK, HazardState, combined_alerts
from .service import LiveState, assemble, lead_time_rows, public_risk

log = logging.getLogger("floodline.api")

HEALTH_SOURCES = (
    "OPW", "OPW live", "Open-Meteo archive", "Open-Meteo recent", "Open-Meteo IFS", "Open-Meteo AIFS", "CFRAM", "GFM", "EMSR860", "CDSE WMS",
    "EPA soils", "OPW NIFM / coastal extents", "GSI groundwater", "Marine Institute tides", "Marine Institute surge", "Open-Meteo hi-res (surface water)",
)
LEVELS = tuple(LEVEL_RANK)


def _level(min_level: str) -> str:
    lv = min_level.upper()
    if lv not in LEVEL_RANK:
        raise HTTPException(400, f"min_level must be one of {LEVELS}")
    return lv


def _filter(rows: list[dict], min_level: str, county: str | None) -> list[dict]:
    floor = LEVEL_RANK[_level(min_level)]
    return [r for r in rows if LEVEL_RANK[r["level"]] >= floor and (county is None or (r.get("county") or "").lower() == county.lower())]


def _counts(rows: list[dict]) -> dict:
    out = {k: 0 for k in LEVELS}
    for r in rows:
        out[r["level"]] += 1
    return out


def _parse_at(at: str) -> datetime:
    try:
        t = datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, f"invalid ISO timestamp: {at}")
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


class Demo:
    """Precomputed demo snapshots (probabilities); decisions are applied per request so
    POST /settings is reflected immediately."""

    def __init__(self):
        self.df: pl.DataFrame | None = None
        self.surface: pl.DataFrame | None = None
        self.groundwater: pl.DataFrame | None = None
        self.emsr: list[dict] = []
        self.cutoffs: dict[int, float] = {}

    def load(self) -> None:
        p = paths()
        if p.demo.exists():
            self.df = pl.read_parquet(p.demo)
        self.emsr = satellite.load_emsr_features()
        sp, gp = demo.hazard_demo_paths()
        self.surface = pl.read_parquet(sp) if sp.exists() else None
        self.groundwater = pl.read_parquet(gp) if gp.exists() else None
        if p.model_meta.exists():
            cal = json.loads(p.model_meta.read_text())["calibration"]
            self.cutoffs = {int(h): v["cutoff"] for h, v in cal.items()}

    def rows(self, at: datetime) -> list[dict]:
        if self.df is None or not self.cutoffs:
            raise HTTPException(503, "demo snapshots not built yet (run `floodline demo-build`)")
        snap = demo.nearest_snapshot(at)
        d = self.df.filter(pl.col("at") == snap)
        metas = d.drop([f"prob_{h}" for h in HORIZONS]).to_dicts()
        for m in metas:
            m["as_of_utc"] = decision.iso(m.pop("at"))
        probs = {h: d[f"prob_{h}"].to_numpy() for h in HORIZONS}
        return assemble(metas, probs, snap, self.cutoffs)

    def hazard_rows(self, kind: str, at: datetime) -> tuple[datetime, list[dict]]:
        df = self.surface if kind == "surface" else self.groundwater
        if df is None:
            raise HTTPException(503, f"{kind} replay not built yet (run `floodline hazards-build` then `floodline demo-build --force`)")
        snap = demo.nearest_snapshot(at)
        rows = df.filter(pl.col("at") == snap).drop("at").to_dicts()
        return snap, rows


def create_app(start_background: bool = True) -> FastAPI:
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        live = LiveState()
        hz = HazardState(live)
        dm = Demo()
        state.update(live=live, demo=dm, hazards=hz)
        if start_background:
            if not paths().demo.exists() and live.predictor is not None:
                log.info("Precomputing demo snapshots")
                try:
                    await demo.build()
                except Exception:
                    log.exception("Demo build failed; /demo endpoints will return 503")
            dm.load()
            await live.start()
            await hz.start()
            asyncio.create_task(_gfm_loop())
        else:
            dm.load()
            live.recompute()
            hz.recompute()
        yield
        await live.stop()
        await hz.stop()

    async def _gfm_loop():
        from . import http

        async with http.client() as c:
            while True:
                try:
                    await satellite.refresh_gfm(c)
                except Exception as e:
                    log.warning("GFM refresh error: %s", e)
                await asyncio.sleep(satellite.GFM_REFRESH_S)

    app = FastAPI(title="Floodline", version="0.1.0", lifespan=lifespan, description="Ireland-wide flood lead-time tool")
    app.add_middleware(
        CORSMiddleware,
        # Extra origins (e.g. the deployed frontend) from FLOODLINE_CORS_ORIGINS, comma-separated.
        allow_origins=[o.strip().rstrip("/") for o in os.environ.get("FLOODLINE_CORS_ORIGINS", "").split(",") if o.strip()],
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def live() -> LiveState:
        return state["live"]

    @app.get("/stations")
    def stations():
        st = live().stations
        if st.height == 0:
            return []
        return st.select("id", "name", "lat", "lon", "county").to_dicts()

    @app.get("/risk")
    def risk():
        return [public_risk(r) for r in live().rows]

    @app.get("/station/{sid}")
    def station(sid: str):
        d = live().detail(sid.zfill(5))
        if d is None:
            raise HTTPException(404, f"no live prediction for station {sid}")
        return d

    @app.get("/lead-times")
    def lead_times():
        return lead_time_rows(live().rows)

    @app.get("/satellite/latest")
    def satellite_latest(bbox: str | None = Query(None, description="minLon,minLat,maxLon,maxLat")):
        box = None
        if bbox:
            try:
                box = tuple(float(x) for x in bbox.split(","))
                assert len(box) == 4 and box[0] < box[2] and box[1] < box[3]
            except Exception:
                raise HTTPException(400, "bbox must be minLon,minLat,maxLon,maxLat")
        return satellite.gfm_clip(box)

    @app.get("/satellite/wms")
    def satellite_wms():
        return satellite.wms_config()

    @app.get("/data-status")
    def data_status():
        lv = live()
        p = paths()
        health = read_health()
        n_rows = 0
        if (p.features / "_SUCCESS").exists():
            try:
                n_rows = pl.scan_parquet(str(p.features / "[0-9]*.parquet")).select(pl.len()).collect().item()
            except Exception:
                pass
        metrics = json.loads(p.metrics.read_text()) if p.metrics.exists() else None
        return {
            "stations_loaded": lv.stations.height,
            "stations_with_levels": len(list(p.levels.glob("*.parquet"))) if p.levels.exists() else 0,
            "stations_modelled": len(lv.predictor.codes) if lv.predictor else 0,
            "stations_live_scored": len(lv.rows),
            "feature_rows": n_rows,
            "last_live_reading_utc": decision.iso(lv.last_live_reading) if lv.last_live_reading else None,
            "last_live_poll_utc": decision.iso(lv.last_live_poll) if lv.last_live_poll else None,
            "ensemble_fetched_utc": decision.iso(lv.ens_fetched) if lv.ens_fetched else None,
            "risk_computed_utc": decision.iso(lv.computed_at) if lv.computed_at else None,
            "model_metrics": metrics,
            "sources": {s: health.get(s, {"ok": None, "detail": "not checked yet"}) for s in HEALTH_SOURCES},
            "now_utc": decision.iso(utcnow()),
        }

    @app.post("/settings")
    def settings(payload: dict = Body(..., examples=[{"global": {"crews": 3}, "stations": {"25017": {"defence_length_m": 120}}}])):
        cur = decision.load_settings()
        try:
            if "global" in payload:
                cur["global"] = {**cur.get("global", {}), **decision.validate_overrides(payload["global"])}
            for sid, o in (payload.get("stations") or {}).items():
                cur.setdefault("stations", {})[sid.zfill(5)] = {**cur.get("stations", {}).get(sid.zfill(5), {}), **decision.validate_overrides(o)}
        except (ValueError, TypeError) as e:
            raise HTTPException(422, str(e))
        decision.save_settings(cur)
        live().redecide()
        return {"settings": cur, "defaults": decision.asdict(decision.DecisionInputs())}

    @app.get("/demo/timeline")
    def demo_timeline():
        return demo.timeline_payload()

    @app.get("/demo/risk")
    def demo_risk(at: str):
        return [public_risk(r) for r in state["demo"].rows(_parse_at(at))]

    @app.get("/demo/lead-times")
    def demo_lead_times(at: str):
        return lead_time_rows(state["demo"].rows(_parse_at(at)))

    @app.get("/demo/satellite")
    def demo_satellite(at: str):
        return satellite.emsr_as_of(state["demo"].emsr, _parse_at(at))

    # ---------- other hazards ----------

    def hz() -> HazardState:
        h = state["hazards"]
        if not h.available:
            raise HTTPException(503, "hazard layers not built yet (run `floodline hazards-build`)")
        return h

    @app.get("/surface-water")
    def surface_water(min_level: str = "CLEAR", county: str | None = None):
        h = hz()
        rows = _filter(h.surface_rows, min_level, county)
        return {"as_of_utc": decision.iso(h.computed_at) if h.computed_at else None, "rain_fetched_utc": decision.iso(h.surface_fetched) if h.surface_fetched else None,
                "counts": _counts(h.surface_rows), "cells": rows}

    @app.get("/surface-water/geojson")
    def surface_water_geojson(min_level: str = "CLEAR"):
        h = hz()
        by_id = {r["cell_id"]: r for r in _filter(h.surface_rows, min_level, None)}
        feats = [{**f, "properties": {k: v for k, v in by_id[f["id"]].items() if not isinstance(v, dict)}} for f in (h.cells_geojson or {}).get("features", []) if f["id"] in by_id]
        return {"type": "FeatureCollection", "features": feats, "properties": {"as_of_utc": decision.iso(h.computed_at) if h.computed_at else None, "source": "Floodline surface-water indicator (rule-based)"}}

    @app.get("/surface-water/{cell_id}")
    def surface_water_cell(cell_id: str):
        d = hz().surface_detail(cell_id.upper())
        if d is None:
            raise HTTPException(404, f"unknown cell {cell_id}")
        return d

    @app.get("/groundwater")
    def groundwater_zones(min_level: str = "WATCH", county: str | None = None):
        from .hazards import GSI_WMS

        h = hz()
        return {"as_of_utc": decision.iso(h.computed_at) if h.computed_at else None, "counts": _counts(h.groundwater_rows),
                "zones": _filter(h.groundwater_rows, min_level, county), "polygons_wms": GSI_WMS}

    @app.get("/coastal")
    def coastal_points(min_level: str = "CLEAR", county: str | None = None):
        h = hz()
        return {"as_of_utc": decision.iso(h.computed_at) if h.computed_at else None, "surge_fetched_utc": decision.iso(h.surge_fetched) if h.surge_fetched else None,
                "counts": _counts(h.coastal_rows), "stations": _filter(h.coastal_rows, min_level, county)}

    @app.get("/coastal/{station_id}")
    def coastal_point(station_id: str):
        d = hz().coastal_detail(station_id)
        if d is None:
            raise HTTPException(404, f"unknown coastal point {station_id}")
        return d

    @app.get("/alerts")
    def alerts(min_level: str = "WATCH", county: str | None = None):
        h = state["hazards"]
        rows = combined_alerts(live().rows, h.surface_rows, h.groundwater_rows, h.coastal_rows, _level(min_level))
        if county:
            rows = [r for r in rows if (r.get("county") or "").lower() == county.lower()]
        return {"as_of_utc": decision.iso(utcnow()), "counts_by_type": _type_counts(rows), "alerts": rows}

    @app.get("/demo/surface-water")
    def demo_surface(at: str, min_level: str = "CLEAR", county: str | None = None):
        snap, rows = state["demo"].hazard_rows("surface", _parse_at(at))
        return {"as_of_utc": decision.iso(snap), "forecast_source": "proxy", "counts": _counts(rows), "cells": _filter(rows, min_level, county)}

    @app.get("/demo/groundwater")
    def demo_groundwater(at: str, min_level: str = "WATCH", county: str | None = None):
        from .hazards import GSI_WMS

        snap, rows = state["demo"].hazard_rows("groundwater", _parse_at(at))
        h = state["hazards"]
        for r in rows:
            r["county"] = h.nearest_county(r["lat"], r["lon"])
        return {"as_of_utc": decision.iso(snap), "forecast_source": "proxy", "counts": _counts(rows), "zones": _filter(rows, min_level, county), "polygons_wms": GSI_WMS}

    @app.get("/demo/coastal")
    def demo_coastal(at: str):
        _parse_at(at)
        return {"status": "unavailable", "reason": "The Marine Institute publishes surge forecasts for a rolling ~5-day window only; there is no archive for January 2026.", "stations": []}

    @app.get("/demo/alerts")
    def demo_alerts(at: str, min_level: str = "WATCH", county: str | None = None):
        t = _parse_at(at)
        river = state["demo"].rows(t)
        _, surf = state["demo"].hazard_rows("surface", t)
        _, gw = state["demo"].hazard_rows("groundwater", t)
        h = state["hazards"]
        for r in gw:
            r["county"] = h.nearest_county(r["lat"], r["lon"])
        rows = combined_alerts(river, surf, gw, [], _level(min_level))
        if county:
            rows = [r for r in rows if (r.get("county") or "").lower() == county.lower()]
        return {"as_of_utc": decision.iso(demo.nearest_snapshot(t)), "forecast_source": "proxy", "counts_by_type": _type_counts(rows), "alerts": rows}

    return app


def _type_counts(rows: list[dict]) -> dict:
    out: dict[str, dict] = {}
    for r in rows:
        out.setdefault(r["type"], {k: 0 for k in LEVELS})[r["level"]] += 1
    return out
