"""`floodline ingest`: stations, hourly levels, hourly rain archive, CFRAM exposure.

OPW levels, Open-Meteo rain and CFRAM run concurrently. Each station / rain cell is written
to its own Parquet file as soon as it lands, so a failure only loses that one item, and a
re-run (without --force) only fetches what is missing.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import timedelta

import polars as pl

from . import geo, http, openmeteo, opw
from .config import HISTORY_DAYS, MAX_CONCURRENCY, paths, record_health, utcnow

log = logging.getLogger("floodline.ingest")


async def ingest_stations(c, force: bool) -> pl.DataFrame:
    p = paths()
    if p.stations.exists() and not force:
        return pl.read_parquet(p.stations)
    df = await opw.fetch_station_list(c)
    df = await geo.assign_counties(c, df)
    df = openmeteo.assign_cells(df)
    p.stations.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(p.stations)
    log.info("Stations: %d river/lake gauges with sensor 0001", df.height)
    return df


async def ingest_levels(c, stations: pl.DataFrame, force: bool, limit: int | None = None) -> None:
    p = paths()
    p.levels.mkdir(parents=True, exist_ok=True)
    start = (utcnow() - timedelta(days=HISTORY_DAYS)).replace(hour=0, minute=0, second=0, microsecond=0)
    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    rows = stations.head(limit) if limit else stations
    todo = [r for r in rows.iter_rows(named=True) if force or not (p.levels / f"{r['id']}.parquet").exists()]
    log.info("Levels: %d stations to fetch (%d already on disk)", len(todo), rows.height - len(todo))
    done = {"ok": 0, "fallback": 0, "failed": 0}

    async def one(r):
        async with sem:
            try:
                hourly, info = await opw.fetch_station_levels(c, r["id"], r["gauge_datum"], start)
            except Exception as e:
                done["failed"] += 1
                log.warning("Levels %s failed: %s", r["id"], e)
                return
        if hourly.height == 0:
            done["failed"] += 1
            log.warning("Levels %s: no data (%s)", r["id"], info.get("error"))
            return
        hourly.with_columns(pl.col("level").cast(pl.Float32)).write_parquet(p.levels / f"{r['id']}.parquet")
        (p.levels / f"{r['id']}.json").write_text(json.dumps(info))
        done["fallback" if info["source"] != "hydro-data" else "ok"] += 1
        n = sum(done.values())
        if n % 25 == 0:
            log.info("Levels: %d/%d done", n, len(todo))

    await asyncio.gather(*(one(r) for r in todo))
    total = len(list(p.levels.glob("*.parquet")))
    record_health(
        "OPW",
        total > 0,
        f"{total} stations on disk; this run ok={done['ok']} fallback={done['fallback']} failed={done['failed']}",
    )
    log.info("Levels: ok=%d fallback=%d failed=%d", done["ok"], done["fallback"], done["failed"])


async def ingest_rain(c, stations: pl.DataFrame, force: bool) -> None:
    p = paths()
    p.rain.mkdir(parents=True, exist_ok=True)
    end = utcnow().date()
    start = end - timedelta(days=HISTORY_DAYS)
    cells = sorted({(a, o) for a, o in zip(stations["cell_lat"], stations["cell_lon"])})
    todo = [cl for cl in cells if force or not (p.rain / f"{openmeteo.cell_key(*cl)}.parquet").exists()]
    days = (end - start).days + 1
    bs = openmeteo.archive_batch_size(days)
    log.info(
        "Rain archive: %d cells to fetch (%d on disk), %d per request, ~%.0f weighted calls",
        len(todo), len(cells) - len(todo), bs, openmeteo.call_weight(len(todo), days),
    )
    limiter = openmeteo.WeightLimiter()
    sem = asyncio.Semaphore(2)
    failed: list[str] = []
    stop = asyncio.Event()

    async def batch(cl):
        if stop.is_set():
            failed.extend(openmeteo.cell_key(*x) for x in cl)
            return
        async with sem:
            try:
                res = await openmeteo.fetch_archive_cells(c, cl, start, end, limiter)
            except openmeteo.RateLimitExceeded as e:
                stop.set()
                log.warning("Open-Meteo rate limit (%s); remaining cells will be fetched on the next run", e)
                failed.extend(openmeteo.cell_key(*x) for x in cl)
                return
            except Exception as e:
                log.warning("Rain batch failed (%s)", e)
                failed.extend(openmeteo.cell_key(*x) for x in cl)
                return
        for cell, df in res.items():
            df.write_parquet(p.rain / f"{openmeteo.cell_key(*cell)}.parquet")

    await asyncio.gather(*(batch(todo[i : i + bs]) for i in range(0, len(todo), bs)))
    have = len(list(p.rain.glob("*.parquet")))
    record_health("Open-Meteo archive", have > 0, f"{have}/{len(cells)} cells; failed this run: {len(failed)}")
    log.info("Rain archive: %d/%d cells on disk", have, len(cells))


async def run(force: bool = False, limit: int | None = None) -> None:
    async with http.client() as c:
        stations = await ingest_stations(c, force)
        if limit:
            stations = stations.head(limit)
        await asyncio.gather(
            ingest_levels(c, stations, force),
            ingest_rain(c, stations, force),
            geo.build_exposure(c, stations, force),
        )
