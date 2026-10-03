"""`floodline <stage>` entry point. Stages are idempotent: skipped when output exists unless --force."""

from __future__ import annotations

import argparse
import asyncio
import logging
import time

from . import dotenv  # noqa: F401  (loads .env before config reads the environment)
from .config import paths, setup_logging

log = logging.getLogger("floodline")

STAGES = ("ingest", "features", "train", "satellite-build", "hazards-build", "demo-build")


def _done(stage: str) -> bool:
    p = paths()
    return {
        "ingest": lambda: p.stations.exists() and any(p.levels.glob("*.parquet")) and any(p.rain.glob("*.parquet")),
        "features": lambda: (p.features / "_SUCCESS").exists(),
        "train": lambda: p.metrics.exists() and p.model_meta.exists(),
        "satellite-build": lambda: (p.emsr / "_index.json").exists(),
        "hazards-build": lambda: (p.hazards / "_SUCCESS").exists(),
        "demo-build": lambda: p.demo.exists(),
    }[stage]()


def run_stage(stage: str, force: bool, limit: int | None = None) -> str:
    if not force and _done(stage):
        log.info("[%s] output exists, skipping (use --force to rebuild)", stage)
        return "skipped"
    if stage == "ingest":
        from . import ingest

        asyncio.run(ingest.run(force=force, limit=limit))
    elif stage == "features":
        from . import features

        features.build_all()
    elif stage == "train":
        from . import train

        train.train_all()
    elif stage == "satellite-build":
        from . import satellite

        asyncio.run(satellite.build(force=force))
    elif stage == "hazards-build":
        from . import hazards

        asyncio.run(hazards.build(force=force))
    elif stage == "demo-build":
        from . import demo

        asyncio.run(demo.build())
    return "ran"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="floodline", description=__doc__)
    ap.add_argument("command", choices=(*STAGES, "serve", "all"))
    ap.add_argument("--force", action="store_true", help="rebuild even if the stage output exists")
    ap.add_argument("--limit", type=int, default=None, help="ingest only the first N stations (dev)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-serve", action="store_true", help="with `all`: stop after demo-build")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    setup_logging(logging.DEBUG if a.verbose else logging.INFO)

    if a.command == "serve":
        _serve(a.host, a.port)
        return
    stages = STAGES if a.command == "all" else (a.command,)
    timings = []
    t_all = time.perf_counter()
    for s in stages:
        t0 = time.perf_counter()
        outcome = run_stage(s, a.force, a.limit)
        dt = time.perf_counter() - t0
        timings.append((s, outcome, dt))
        print(f"[timing] {s:<16} {outcome:<8} {dt:8.1f} s", flush=True)
    if a.command == "all":
        print("\nStage            Outcome   Seconds")
        for s, o, dt in timings:
            print(f"{s:<16} {o:<8} {dt:8.1f}")
        print(f"{'TOTAL':<16} {'':<8} {time.perf_counter() - t_all:8.1f}\n", flush=True)
        if not a.no_serve:
            _serve(a.host, a.port)


def _serve(host: str, port: int) -> None:
    import uvicorn

    from .api import create_app

    uvicorn.run(create_app(), host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
