"""Live state: latest levels, ensemble rain, predictions and decisions.

Background loops respect upstream etiquette: waterlevel.ie at most every 15 min, the
Open-Meteo ensemble every 6 h (cached on disk across restarts), GFM every 30 min.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta

import numpy as np
import polars as pl

from . import decision, http, openmeteo, opw
from .config import ENSEMBLE_REFRESH_S, HORIZONS, LIVE_POLL_S, MAX_CONCURRENCY, paths, record_health, utcnow
from .predict import Predictor, future_from_summary

log = logging.getLogger("floodline.service")

RISK_FIELDS = (
    "id", "name", "lat", "lon", "level_now", "p95", "pct_of_record", "p6", "p24", "p48", "p120", "risk",
    "status", "pred_cross_utc", "fill_deadline_utc", "bags_needed", "rain48_p50", "rain48_p90",
)


# ---------- shared assembly (live + demo) ----------


def assemble(metas: list[dict], probs: dict[int, np.ndarray], at: datetime, cutoffs: dict[int, float], settings: dict | None = None) -> list[dict]:
    """Risk rows sorted by risk (desc). `metas` carry station/level/rain context per row."""
    settings = settings if settings is not None else decision.load_settings()
    rows = []
    for i, m in enumerate(metas):
        pr = decision.monotone({h: float(probs[h][i]) for h in HORIZONS})
        d = decision.decide(pr, decision.inputs_for(m["id"], settings), at, cutoffs, already_above=m["level_now"] >= m["p95"])
        rows.append({**m, **{f"p{h}": round(pr[h], 4) for h in HORIZONS}, **d})
    risks = decision.risk_scores([r["p48"] for r in rows], [r.get("exposure", 1.0) for r in rows])
    for r, k in zip(rows, risks):
        r["risk"] = k
    rows.sort(key=lambda r: (-r["risk"], -r["p48"]))
    return rows


def public_risk(r: dict) -> dict:
    out = {k: r.get(k) for k in RISK_FIELDS}
    for k in ("as_of_utc", "forecast_source"):
        if k in r:
            out[k] = r[k]
    return out


def lead_time_rows(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        cross = decision.parse_iso(r["pred_cross_utc"])
        deadline = decision.parse_iso(r["fill_deadline_utc"])
        out.append(
            {
                "id": r["id"],
                "name": r["name"],
                "status": r["status"],
                "L": r["lead_time_h"],
                "pred_cross_utc": r["pred_cross_utc"],
                "fill_deadline_utc": r["fill_deadline_utc"],
                "hours_remaining": r["hours_remaining"],
                "tasks": decision.task_list(cross, deadline),
                "supplies": r["supplies"],
                **({"forecast_source": r["forecast_source"]} if "forecast_source" in r else {}),
            }
        )
    return out


def merge_rain(archive: pl.DataFrame | None, recent: pl.DataFrame | None) -> pl.DataFrame:
    """Archive where it has values; recent (forecast API past_days) fills the archive's ~5-day lag."""
    parts = []
    if archive is not None and archive.height:
        parts.append(archive.filter(pl.col("precip").is_not_null()).select("time", pl.col("precip").cast(pl.Float32)))
    if recent is not None and recent.height:
        r = recent.filter(pl.col("precip").is_not_null()).select("time", pl.col("precip").cast(pl.Float32))
        if parts:
            r = r.filter(pl.col("time") > parts[0]["time"].max())
        parts.append(r)
    if not parts:
        return pl.DataFrame(schema={"time": pl.Datetime("us", "UTC"), "precip": pl.Float32})
    return pl.concat(parts).sort("time")


# ---------- live state ----------


class LiveState:
    def __init__(self):
        p = paths()
        self.stations = pl.read_parquet(p.stations) if p.stations.exists() else pl.DataFrame()
        self.station_map = {r["id"]: r for r in self.stations.iter_rows(named=True)} if self.stations.height else {}
        try:
            self.predictor: Predictor | None = Predictor()
        except Exception as e:
            log.warning("Models unavailable (%s); /risk will be empty until `floodline train` has run", e)
            self.predictor = None
        self.levels: dict[str, pl.DataFrame] = {}
        self.live15: pl.DataFrame = self._load_live15()
        self.recent_rain: dict[str, pl.DataFrame] = {}
        self.ens_members: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self.ens_fetched: datetime | None = None
        self.last_live_reading: datetime | None = None
        self.last_live_poll: datetime | None = None
        self.rows: list[dict] = []
        self.details: dict[str, dict] = {}
        self.computed_at: datetime | None = None
        self._last: tuple | None = None
        self._tasks: list[asyncio.Task] = []
        self._lock = asyncio.Lock()
        self._load_levels()
        self._load_rain_cache()

    # ----- disk caches -----
    def _load_levels(self) -> None:
        cutoff = utcnow() - timedelta(days=40)
        for sid in self.station_map:
            lp = paths().levels / f"{sid}.parquet"
            if lp.exists():
                self.levels[sid] = pl.read_parquet(lp).filter(pl.col("time") >= cutoff).with_columns(pl.col("level").cast(pl.Float64))

    def _load_live15(self) -> pl.DataFrame:
        f = paths().live / "levels_live.parquet"
        if f.exists():
            return pl.read_parquet(f)
        return pl.DataFrame(schema={"id": pl.Utf8, "time": pl.Datetime("us", "UTC"), "value": pl.Float64})

    def _load_rain_cache(self) -> None:
        live = paths().live
        meta = live / "ensemble_meta.json"
        if meta.exists():
            m = json.loads(meta.read_text())
            self.ens_fetched = datetime.fromisoformat(m["fetched_utc"])
            for f in (live / "ensemble").glob("*.npz"):
                z = np.load(f)
                self.ens_members[f.stem] = (z["times"].astype("datetime64[h]"), z["members"])
        rr = live / "recent_rain.parquet"
        if rr.exists():
            df = pl.read_parquet(rr)
            for (cell,), g in df.group_by("cell"):
                self.recent_rain[cell] = g.drop("cell")

    # ----- refreshers -----
    async def refresh_levels(self, c) -> None:
        latest = await opw.fetch_latest(c)
        self.last_live_poll = utcnow()
        latest = latest.filter(pl.col("id").is_in(list(self.station_map)) & (pl.col("value") > -50))
        self.live15 = (
            pl.concat([self.live15, latest.select("id", "time", "value")])
            .unique(["id", "time"], keep="last")
            .filter(pl.col("time") >= utcnow() - timedelta(days=8))
        )
        f = paths().live / "levels_live.parquet"
        f.parent.mkdir(parents=True, exist_ok=True)
        self.live15.write_parquet(f)
        if latest.height:
            self.last_live_reading = latest["time"].max()
        record_health("OPW live", True, f"{latest.height} live readings", last_reading_utc=str(self.last_live_reading))

    async def backfill_recent(self, c) -> None:
        """If stored history is stale (e.g. ingest ran days ago), pull the last week per station."""
        stale = [sid for sid, df in self.levels.items() if df.height == 0 or df["time"].max() < utcnow() - timedelta(hours=3)]
        stale += [sid for sid in self.station_map if sid not in self.levels]
        if not stale:
            return
        log.info("Backfilling last 7 days for %d stations", len(stale))
        sem = asyncio.Semaphore(MAX_CONCURRENCY)

        async def one(sid):
            async with sem:
                try:
                    w = await opw.fetch_recent_week(c, sid)
                except Exception:
                    return None
            return w.with_columns(pl.lit(sid).alias("id")).select("id", "time", "value") if w.height else None

        parts = [x for x in await asyncio.gather(*(one(s) for s in stale)) if x is not None]
        if parts:
            self.live15 = pl.concat([self.live15, *parts]).unique(["id", "time"], keep="last")

    async def refresh_rain(self, c, force: bool = False) -> None:
        """Ensemble members and recent past rain, each refreshed at most every 6 h (disk-cached)."""
        cells = sorted({(r["cell_lat"], r["cell_lon"]) for r in self.station_map.values()})
        limiter = openmeteo.WeightLimiter()
        live = paths().live
        (live / "ensemble").mkdir(parents=True, exist_ok=True)
        if force or not self._fresh(self.ens_fetched) or not self.ens_members:
            await self._refresh_ensemble(c, cells, limiter)
        else:
            self._record_ensemble_health(cached=True)
        rr = live / "recent_rain.parquet"
        recent_at = datetime.fromtimestamp(rr.stat().st_mtime).astimezone() if rr.exists() else None
        if force or not self._fresh(recent_at) or not self.recent_rain:
            await self._refresh_recent(c, cells, limiter)

    @staticmethod
    def _fresh(t: datetime | None) -> bool:
        return t is not None and (utcnow() - t).total_seconds() < ENSEMBLE_REFRESH_S

    def _record_ensemble_health(self, cached: bool = False, names: list[str] | None = None) -> None:
        if names is None:
            any_cell = next(iter(self.ens_members.values()), None)
            total = any_cell[1].shape[1] if any_cell else 0
            # Cached matrices don't keep member names; IFS and AIFS each contribute ~half.
            n_by = {"IFS": total // 2, "AIFS": total - total // 2}
        else:
            n_by = {"IFS": sum(1 for k in names if "ecmwf_ifs025" in k), "AIFS": sum(1 for k in names if "ecmwf_aifs025" in k)}
        when = decision.iso(self.ens_fetched) if self.ens_fetched else "?"
        for m, n in n_by.items():
            record_health(f"Open-Meteo {m}", n > 0, f"{n} members x {len(self.ens_members)} cells, fetched {when}{' (cache)' if cached else ''}")

    async def _refresh_ensemble(self, c, cells, limiter) -> None:
        live = paths().live
        try:
            ens = await openmeteo.fetch_ensemble_cells(c, cells, limiter)
            for cell, (times, mat, names) in ens.items():
                key = openmeteo.cell_key(*cell)
                self.ens_members[key] = (times, mat)
                np.savez_compressed(live / "ensemble" / f"{key}.npz", times=times.astype("datetime64[h]"), members=mat)
            self.ens_fetched = utcnow()
            (live / "ensemble_meta.json").write_text(json.dumps({"fetched_utc": self.ens_fetched.isoformat()}))
            self._record_ensemble_health(names=next(iter(ens.values()))[2] if ens else [])
        except Exception as e:
            log.warning("Ensemble refresh failed: %s", e)
            record_health("Open-Meteo IFS", False, str(e))
            record_health("Open-Meteo AIFS", False, str(e))

    async def _refresh_recent(self, c, cells, limiter) -> None:
        live = paths().live
        try:
            rec = await openmeteo.fetch_recent_cells(c, cells, limiter)
            frames = []
            for cell, df in rec.items():
                key = openmeteo.cell_key(*cell)
                self.recent_rain[key] = df
                frames.append(df.with_columns(pl.lit(key).alias("cell")))
            if frames:
                pl.concat(frames).write_parquet(live / "recent_rain.parquet")
            record_health("Open-Meteo recent", True, f"{len(rec)} cells, past 31 days")
        except Exception as e:
            log.warning("Recent rain refresh failed: %s", e)
            record_health("Open-Meteo recent", False, str(e))

    # ----- compute -----
    def station_levels(self, sid: str) -> pl.DataFrame:
        base = self.levels.get(sid, pl.DataFrame(schema={"time": pl.Datetime("us", "UTC"), "level": pl.Float64}))
        live = self.live15.filter(pl.col("id") == sid)
        if live.height:
            hourly = opw.to_hourly(live.select("time", "value"))
            base = pl.concat([base.filter(~pl.col("time").is_in(hourly["time"].implode())), hourly]).sort("time")
        return base

    def station_rain(self, cell: str) -> pl.DataFrame:
        rp = paths().rain / f"{cell}.parquet"
        archive = pl.read_parquet(rp).filter(pl.col("time") >= utcnow() - timedelta(days=40)) if rp.exists() else None
        return merge_rain(archive, self.recent_rain.get(cell))

    def recompute(self) -> None:
        if self.predictor is None:
            return
        now = utcnow().replace(minute=0, second=0, microsecond=0)
        snaps, metas, extras = [], [], {}
        for sid, st in self.station_map.items():
            lv = self.station_levels(sid)
            if lv.height == 0:
                continue
            at = min(now, lv["time"].max())
            summary = {}
            if st["rain_cell"] in self.ens_members:
                times, mat = self.ens_members[st["rain_cell"]]
                summary = openmeteo.summarise_members(times, mat, at)
            source = "ensemble" if summary.get("n_members") else "unavailable"
            fut = future_from_summary(summary, "p50")
            row = self.predictor.snapshot(sid, lv, self.station_rain(st["rain_cell"]), at, future=fut)
            if row is None:
                continue
            stc = self.predictor.static[sid]
            snaps.append(row)
            metas.append(
                {
                    "id": sid,
                    "name": st["name"],
                    "county": st.get("county"),
                    "lat": st["lat"],
                    "lon": st["lon"],
                    "level_now": round(row["level_now"], 3),
                    "p95": round(stc["stn_p95"], 3),
                    "pct_of_record": round(100 * row["pct_of_record"], 1),
                    "exposure": stc["exposure"],
                    "rain48_p50": round(summary.get("rain48_p50", 0.0), 1),
                    "rain48_p90": round(summary.get("rain48_p90", 0.0), 1),
                    "as_of_utc": decision.iso(at),
                    "forecast_source": source,
                }
            )
            extras[sid] = {"row": row, "summary": summary, "levels": lv, "at": at}
        probs = self.predictor.predict(snaps)
        self._last = (metas, probs, now)
        rows = assemble(metas, probs, now, self.predictor.cutoffs)
        # Uncertainty band: rerun with ensemble p10 / p90 rain.
        band = {}
        for pct in ("p10", "p90"):
            alt = [{**extras[m["id"]]["row"], **future_from_summary(extras[m["id"]]["summary"], pct)} for m in metas]
            band[pct] = self.predictor.predict(alt)
        idx = {m["id"]: i for i, m in enumerate(metas)}
        self.details = {}
        for r in rows:
            i = idx[r["id"]]
            e = extras[r["id"]]
            e["band"] = {f"p{h}": [round(float(band["p10"][h][i]), 4), round(float(band["p90"][h][i]), 4)] for h in HORIZONS}
            self.details[r["id"]] = e
        self.rows = rows
        self.computed_at = utcnow()

    def redecide(self) -> None:
        """Re-apply the decision layer (e.g. after POST /settings) without re-predicting."""
        if self.predictor is not None and self._last:
            metas, probs, now = self._last
            self.rows = assemble(metas, probs, now, self.predictor.cutoffs)

    def detail(self, sid: str) -> dict | None:
        row = next((r for r in self.rows if r["id"] == sid), None)
        if row is None or self.predictor is None:
            return None
        e = self.details[sid]
        hist = e["levels"].filter(pl.col("time") > e["at"] - timedelta(hours=72))
        s = e["summary"]
        return {
            **public_risk(row),
            "county": row.get("county"),
            "history_72h": [{"t": decision.iso(t), "level": round(v, 3)} for t, v in zip(hist["time"], hist["level"]) if v == v],
            "ensemble_fan": s.get("fan", []),
            "ensemble": {k: round(v, 3) for k, v in s.items() if k.startswith(("rain", "p_rain"))} | {"n_members": s.get("n_members", 0)},
            "decision_inputs": decision.asdict(decision.inputs_for(sid)),
            "decision": {k: row[k] for k in ("lead_time_h", "p_star", "p_within_L", "hours_remaining")},
            "uncertainty_rain_p10_p90": e["band"],
            "shap_top5_24h": self.predictor.shap_top5(e["row"], 24),
        }

    # ----- lifecycle -----
    async def start(self) -> None:
        self._tasks.append(asyncio.create_task(self._loop()))

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()

    async def _loop(self) -> None:
        async with http.client() as c:
            try:
                await self.backfill_recent(c)
            except Exception as e:
                log.warning("Backfill failed: %s", e)
            while True:
                for name, fn in (("levels", self.refresh_levels), ("rain", self.refresh_rain)):
                    try:
                        await fn(c)
                    except Exception as e:
                        log.warning("Live %s refresh failed: %s", name, e)
                        if name == "levels":
                            record_health("OPW live", False, str(e))
                try:
                    async with self._lock:
                        await asyncio.to_thread(self.recompute)
                    log.info("Live risk recomputed for %d stations", len(self.rows))
                except Exception:
                    log.exception("Recompute failed")
                await asyncio.sleep(LIVE_POLL_S)
