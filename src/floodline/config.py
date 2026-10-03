"""Paths, constants and shared settings.

Paths are resolved at call time from FLOODLINE_DATA / FLOODLINE_MODELS so tests can point
the whole app at a temporary directory.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("floodline")

HORIZONS = (6, 24, 48, 120)
HISTORY_DAYS = 3 * 365
MIN_VALID_HOURS = 500
MAX_CONCURRENCY = 10

# Time split (inclusive bounds, UTC).
TRAIN_END = datetime(2025, 9, 30, 23, tzinfo=timezone.utc)
VAL_START = datetime(2025, 10, 1, tzinfo=timezone.utc)
VAL_END = datetime(2025, 12, 31, 23, tzinfo=timezone.utc)
TEST_START = datetime(2026, 1, 1, tzinfo=timezone.utc)
TEST_END = datetime(2026, 2, 28, 23, tzinfo=timezone.utc)

# Storm Chandra demo window.
DEMO_START = datetime(2026, 1, 22, tzinfo=timezone.utc)
DEMO_END = datetime(2026, 1, 30, tzinfo=timezone.utc)
DEMO_LANDFALL = datetime(2026, 1, 27, tzinfo=timezone.utc)
DEMO_STEP_H = 6

IRELAND_BBOX = (-11.0, 51.0, -5.0, 56.0)  # lon_min, lat_min, lon_max, lat_max

# OPW licence: only stations 00001-41000 may be republished.
OPW_REF_MIN, OPW_REF_MAX = 1, 41000

LIVE_POLL_S = 15 * 60  # never poll waterlevel.ie faster than this
ENSEMBLE_REFRESH_S = 3 * 3600
GFM_REFRESH_S = 30 * 60

USER_AGENT = "Floodline/0.1 (flood lead-time tool for Irish county councils)"

URLS = {
    "stations": "https://waterlevel.ie/geojson/",
    "latest": "https://waterlevel.ie/geojson/latest/",
    "hydro_stations": "https://waterlevel.ie/hydro-data/data/internet/stations/stations.json",
    "hydro_complete": "https://waterlevel.ie/hydro-data/data/internet/stations/0/{id}/S/Waterlevel_complete.zip",
    "wl_month": "https://waterlevel.ie/data/month/{id}_0001.csv",
    "wl_week": "https://waterlevel.ie/data/week/{id}_0001.csv",
    "archive": "https://archive-api.open-meteo.com/v1/archive",
    "archive_customer": "https://customer-archive-api.open-meteo.com/v1/archive",
    "forecast": "https://api.open-meteo.com/v1/forecast",
    "forecast_customer": "https://customer-api.open-meteo.com/v1/forecast",
    "ensemble": "https://ensemble-api.open-meteo.com/v1/ensemble",
    "ensemble_customer": "https://customer-ensemble-api.open-meteo.com/v1/ensemble",
    "cfram": "https://s3.eu-west-1.amazonaws.com/catalogue.floodinfo.opw/cfram/esds_floodmap_ext_f_c.zip",
    "counties": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson",
    "emsr_activation": "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code={code}",
    "gfm_api": "https://api.gfm.eodc.eu/v2",
    "cdse_wms": "https://sh.dataspace.copernicus.eu/ogc/wms/{instance}",
}

ENSEMBLE_MODELS = ("ecmwf_ifs025", "ecmwf_aifs025")


def rain_grid_deg() -> float:
    """Grid used to dedupe Open-Meteo requests. 0.5 deg keeps a 3-year archive pull for
    every Irish gauge inside the free tier's 5,000 calls/hour; use 0.25 (ERA5 native)
    with an OPEN_METEO_API_KEY."""
    default = "0.25" if os.environ.get("OPEN_METEO_API_KEY") else "0.5"
    return float(os.environ.get("FLOODLINE_RAIN_GRID", default))


@dataclass(frozen=True)
class Paths:
    data: Path
    models: Path

    @property
    def raw(self) -> Path:
        return self.data / "raw"

    @property
    def stations(self) -> Path:
        return self.data / "stations.parquet"

    @property
    def levels(self) -> Path:
        return self.data / "levels"

    @property
    def rain(self) -> Path:
        return self.data / "rain"

    @property
    def exposure(self) -> Path:
        return self.data / "exposure.parquet"

    @property
    def features(self) -> Path:
        return self.data / "features"

    @property
    def live(self) -> Path:
        return self.data / "live"

    @property
    def satellite(self) -> Path:
        return self.data / "satellite"

    @property
    def emsr(self) -> Path:
        return self.satellite / "emsr860"

    @property
    def gfm(self) -> Path:
        return self.satellite / "gfm_latest.geojson"

    @property
    def demo(self) -> Path:
        return self.data / "demo.parquet"

    @property
    def settings(self) -> Path:
        return self.data / "settings.json"

    @property
    def health(self) -> Path:
        return self.data / "health.json"

    @property
    def metrics(self) -> Path:
        return self.models / "metrics.json"

    def model(self, h: int) -> Path:
        return self.models / f"lgbm_h{h}.txt"

    @property
    def model_meta(self) -> Path:
        return self.models / "model_meta.json"


def paths() -> Paths:
    return Paths(
        data=Path(os.environ.get("FLOODLINE_DATA", "data")),
        models=Path(os.environ.get("FLOODLINE_MODELS", "models")),
    )


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def record_health(source: str, ok: bool, detail: str = "", **extra) -> None:
    """Persist per-source health so /data-status can report it across processes."""
    p = paths().health
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(p.read_text()) if p.exists() else {}
    except json.JSONDecodeError:
        data = {}
    data[source] = {"ok": ok, "detail": detail, "checked_utc": utcnow().isoformat(), **extra}
    p.write_text(json.dumps(data, indent=2, default=str))


def read_health() -> dict:
    p = paths().health
    try:
        return json.loads(p.read_text()) if p.exists() else {}
    except json.JSONDecodeError:
        return {}


def setup_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(
        level=level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
