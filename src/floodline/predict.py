"""Model loading and single-timestamp feature snapshots (shared by live and demo)."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

import lightgbm as lgb
import numpy as np
import polars as pl

from .config import HORIZONS, paths
from .features import FEATURES, RAIN_NEXT, compute_features, hourly_grid
from .train import calibrate

log = logging.getLogger("floodline.predict")

SNAPSHOT_HOURS = 31 * 24 + 1  # enough history for the 30-day antecedent rain feature


class Predictor:
    def __init__(self):
        p = paths()
        self.meta = json.loads(p.model_meta.read_text())
        self.boosters = {h: lgb.Booster(model_file=str(p.model(h))) for h in HORIZONS}
        self.calib = {int(h): v for h, v in self.meta["calibration"].items()}
        self.cutoffs = {h: self.calib[h]["cutoff"] for h in HORIZONS}
        self.codes: dict[str, int] = self.meta["station_codes"]
        static = pl.read_parquet(p.features / "_static.parquet")
        self.static = {r["id"]: r for r in static.iter_rows(named=True)}
        self._record: dict[str, np.ndarray] = {}

    def record_sorted(self, sid: str) -> np.ndarray:
        """Sorted 3-year record for the percentile-of-record feature (cached)."""
        if sid not in self._record:
            lp = paths().levels / f"{sid}.parquet"
            v = pl.read_parquet(lp)["level"].drop_nans().drop_nulls().to_numpy() if lp.exists() else np.array([])
            self._record[sid] = np.sort(v.astype(np.float32))
        return self._record[sid]

    def snapshot(
        self,
        sid: str,
        levels: pl.DataFrame,
        rain: pl.DataFrame,
        at: datetime,
        future: dict[str, float] | None = None,
    ) -> dict[str, float] | None:
        """Feature row for station `sid` as of hour `at`, using only data <= at.

        `future` maps RAIN_NEXT feature names to forecast accumulations. If omitted, the
        future window of `rain` is used (perfect-forecast proxy, demo only).
        """
        st = self.static.get(sid)
        if st is None:
            return None
        at = at.replace(minute=0, second=0, microsecond=0)
        start = at - timedelta(hours=SNAPSHOT_HOURS - 1)
        end = at + timedelta(hours=168) if future is None else at
        lv = levels.filter(pl.col("time").is_between(start, at))
        if lv.height == 0 or lv["time"].max() < at - timedelta(hours=3):
            return None  # no recent level: can't nowcast this gauge
        level = hourly_grid(lv, start, end, "level")
        rain_arr = hourly_grid(rain.filter(pl.col("time").is_between(start, end)), start, end, "precip") if rain.height else np.zeros(len(level))
        stats = {k: st[k] for k in ("stn_p50", "stn_p95", "stn_max", "stn_std")}
        static = {"lat": st["lat"], "lon": st["lon"], "exposure": st["exposure"], "station_code": st["station_code"]}
        f = compute_features(level, rain_arr, stats, self.record_sorted(sid), static, with_labels=False)
        i = SNAPSHOT_HOURS - 1
        row = {k: float(v[i]) for k, v in f.items()}
        if future is not None:
            row.update({k: float(future[k]) for k in RAIN_NEXT})
        return row

    def _matrix(self, rows: list[dict]) -> np.ndarray:
        return np.array([[r[k] for k in FEATURES] for r in rows], dtype=np.float32)

    def predict(self, rows: list[dict]) -> dict[int, np.ndarray]:
        if not rows:
            return {h: np.array([]) for h in HORIZONS}
        X = self._matrix(rows)
        return {h: calibrate(self.boosters[h].predict(X, raw_score=True), self.calib[h]["a"], self.calib[h]["b"]) for h in HORIZONS}

    def shap_top5(self, row: dict, h: int = 24) -> list[dict]:
        """Top-5 feature contributions (calibrated log-odds units) for one row."""
        contrib = self.boosters[h].predict(self._matrix([row]), pred_contrib=True)[0][:-1] * self.calib[h]["a"]
        order = np.argsort(-np.abs(contrib))[:5]
        # A missing feature (e.g. a lag over a gap in the gauge feed) is NaN, which isn't valid JSON.
        return [
            {"feature": FEATURES[i], "value": round(v, 3) if np.isfinite(v := row[FEATURES[i]]) else None, "contribution": round(float(contrib[i]), 4)}
            for i in order
        ]


def future_from_summary(summary: dict, pct: str = "p50") -> dict[str, float]:
    """Map ensemble accumulations (rain{h}_pXX) onto the model's future-rain features."""
    return {name: summary.get(f"rain{h}_{pct}", 0.0) for name, h in RAIN_NEXT.items()}
