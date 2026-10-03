"""FastAPI app: JSON/GeoJSON endpoints for the Floodline frontend."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import polars as pl
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import decision, demo, satellite
from .config import HORIZONS, paths, read_health, utcnow
from .service import LiveState, assemble, lead_time_rows, public_risk

log = logging.getLogger("floodline.api")

HEALTH_SOURCES = ("OPW", "OPW live", "Open-Meteo archive", "Open-Meteo recent", "Open-Meteo IFS", "Open-Meteo AIFS", "CFRAM", "GFM", "EMSR860", "CDSE WMS")


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
        self.emsr: list[dict] = []
        self.cutoffs: dict[int, float] = {}

    def load(self) -> None:
        p = paths()
        if p.demo.exists():
            self.df = pl.read_parquet(p.demo)
        self.emsr = satellite.load_emsr_features()
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


def create_app(start_background: bool = True) -> FastAPI:
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        live = LiveState()
        dm = Demo()
        state.update(live=live, demo=dm)
        if start_background:
            if not paths().demo.exists() and live.predictor is not None:
                log.info("Precomputing demo snapshots")
                try:
                    await demo.build()
                except Exception:
                    log.exception("Demo build failed; /demo endpoints will return 503")
            dm.load()
            await live.start()
            asyncio.create_task(_gfm_loop())
        else:
            dm.load()
            live.recompute()
        yield
        await live.stop()

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

    return app
