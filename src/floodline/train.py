"""`floodline train`: one pooled LightGBM classifier per horizon.

Split: train <= 2025-09-30, validate 2025-10-01..12-31 (early stopping, Platt calibration,
F1-optimal cutoff), test 2026-01-01..02-28 (Storm Chandra; reported only).

Probabilities are Platt-calibrated on validation because scale_pos_weight inflates raw
scores, and the decision layer compares probabilities against a cost ratio p*.
"""

from __future__ import annotations

import json
import logging
import time

import lightgbm as lgb
import numpy as np
import polars as pl

from .config import HORIZONS, TEST_END, TEST_START, TRAIN_END, VAL_END, VAL_START, paths, utcnow
from .features import CATEGORICAL, FEATURES, load_meta

log = logging.getLogger("floodline.train")

MAX_TRAIN_ROWS = 2_500_000
NEG_KEEP_MOD = 6  # pre-subsample: keep 1 in 6 hours that are negative at every horizon (bounds RAM)
LEAD_BINS = [(0, 0, "missed"), (1, 6, "1-6h"), (7, 12, "7-12h"), (13, 24, "13-24h"), (25, 48, "25-48h"), (49, 72, "49-72h"), (73, 120, "73-120h")]

PARAMS = {
    "objective": "binary",
    "learning_rate": 0.07,
    "num_leaves": 63,
    "min_data_in_leaf": 200,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "max_bin": 255,
    "metric": "average_precision",
    "verbose": -1,
    "seed": 7,
}


# ---------- metrics helpers (numpy only) ----------


def pr_curve(y: np.ndarray, p: np.ndarray):
    """Precision/recall at every distinct threshold, thresholds descending."""
    order = np.argsort(-p, kind="mergesort")
    y, p = y[order], p[order]
    tp = np.cumsum(y)
    fp = np.cumsum(1 - y)
    last = np.r_[np.where(np.diff(p))[0], len(p) - 1]
    tp, fp, thr = tp[last], fp[last], p[last]
    precision = tp / np.maximum(tp + fp, 1)
    recall = tp / max(y.sum(), 1)
    return precision, recall, thr


def average_precision(y: np.ndarray, p: np.ndarray) -> float:
    if y.sum() == 0:
        return float("nan")
    prec, rec, _ = pr_curve(y, p)
    return float(np.sum(np.diff(np.r_[0.0, rec]) * prec))


def best_f1_cutoff(y: np.ndarray, p: np.ndarray) -> tuple[float, float]:
    prec, rec, thr = pr_curve(y, p)
    f1 = 2 * prec * rec / np.maximum(prec + rec, 1e-12)
    i = int(np.argmax(f1))
    return float(thr[i]), float(f1[i])


def prf(y: np.ndarray, p: np.ndarray, cutoff: float) -> dict:
    pred = p >= cutoff
    tp = int((pred & (y == 1)).sum())
    fp = int((pred & (y == 0)).sum())
    fn = int((~pred & (y == 1)).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4), "tp": tp, "fp": fp, "fn": fn}


def fit_platt(raw: np.ndarray, y: np.ndarray, iters: int = 50) -> tuple[float, float]:
    """Logistic regression of y on the raw (logit) score: p = sigmoid(a * raw + b)."""
    x = raw.astype(np.float64)
    y = y.astype(np.float64)

    def nll(a, b):
        z = a * x + b
        return float(np.sum(np.logaddexp(0, z) - y * z))

    a, b = 1.0, 0.0
    cur = nll(a, b)
    for _ in range(iters):
        q = 1 / (1 + np.exp(-np.clip(a * x + b, -35, 35)))
        w = q * (1 - q) + 1e-9
        g = np.array([np.sum((q - y) * x), np.sum(q - y)])
        H = np.array([[np.sum(w * x * x), np.sum(w * x)], [np.sum(w * x), np.sum(w)]]) + 1e-6 * np.eye(2)
        step = np.linalg.solve(H, g)
        t = 1.0  # backtracking: undamped Newton diverges when classes are near-separable
        while t > 1e-6 and nll(a - t * step[0], b - t * step[1]) > cur:
            t /= 2
        if t <= 1e-6:
            break
        a, b = a - t * step[0], b - t * step[1]
        new = nll(a, b)
        if cur - new < 1e-9 * max(cur, 1.0):
            break
        cur = new
    return float(a), float(b)


def calibrate(raw: np.ndarray, a: float, b: float) -> np.ndarray:
    return 1 / (1 + np.exp(-np.clip(a * raw + b, -35, 35)))


# ---------- data ----------


def _scan() -> pl.LazyFrame:
    return pl.scan_parquet(str(paths().features / "[0-9]*.parquet"))


def load_frame(lo, hi, subsample: bool = False) -> pl.DataFrame:
    q = _scan().filter(pl.col("time").is_between(lo, hi))
    if subsample:
        keep = (pl.col("label_120") == 1) | (pl.struct("id", "time").hash(seed=42) % NEG_KEEP_MOD == 0)
        q = q.filter(keep)
    return q.collect()


def to_xy(df: pl.DataFrame, h: int) -> tuple[np.ndarray, np.ndarray, pl.DataFrame]:
    d = df.filter(pl.col(f"label_{h}").is_not_nan())
    X = d.select(FEATURES).to_numpy().astype(np.float32)
    y = d[f"label_{h}"].to_numpy().astype(np.int8)
    return X, y, d


# ---------- lead time ----------


def crossing_events(level: np.ndarray, p95: float, quiet_h: int = 24) -> np.ndarray:
    """Indices where the level reaches P95 after >= quiet_h hours below it."""
    above = np.nan_to_num(level, nan=-np.inf) >= p95
    ev = []
    last_above = -10**9
    for i, a in enumerate(above):
        if a:
            if i - last_above > quiet_h and i >= quiet_h:
                ev.append(i)
            last_above = i
    return np.array(ev, dtype=int)


def lead_times(test: pl.DataFrame, probs: dict[int, np.ndarray], cutoffs: dict[int, float]) -> dict:
    """For every real P95 crossing in test: hours between first alert and the crossing."""
    t = test.with_columns(*[pl.Series(f"prob_{h}", probs[h]) for h in HORIZONS]).sort("id", "time")
    leads: dict[str, list[int]] = {str(h): [] for h in HORIZONS}
    leads["any"] = []
    for _, g in t.group_by("id", maintain_order=True):
        lvl = g["level_raw"].to_numpy()
        p95 = float(g["stn_p95"][0])
        times = g["time"].to_numpy().astype("datetime64[h]").astype(np.int64)
        for c in crossing_events(lvl, p95):
            best_any = 0
            for h in HORIZONS:
                win = (times >= times[c] - h) & (times < times[c])
                alert = win & (g[f"prob_{h}"].to_numpy() >= cutoffs[h])
                lead = int(times[c] - times[alert].min()) if alert.any() else 0
                leads[str(h)].append(lead)
                best_any = max(best_any, lead)
            leads["any"].append(best_any)
    out = {}
    for k, v in leads.items():
        arr = np.array(v, dtype=int)
        hist = {label: int(((arr >= lo) & (arr <= hi)).sum()) for lo, hi, label in LEAD_BINS}
        out[k] = {
            "n_crossings": int(arr.size),
            "detected": int((arr > 0).sum()),
            "median_lead_h": float(np.median(arr[arr > 0])) if (arr > 0).any() else None,
            "histogram": hist,
        }
    return out


# ---------- main ----------


def train_all() -> dict:
    p = paths()
    p.models.mkdir(parents=True, exist_ok=True)
    meta = load_meta()
    t0 = time.perf_counter()
    train_df = load_frame(_min_time(), TRAIN_END, subsample=True)
    val_df = load_frame(VAL_START, VAL_END)
    test_df = load_frame(TEST_START, TEST_END)
    log.info("Rows: train=%d (pre-subsampled) val=%d test=%d", train_df.height, val_df.height, test_df.height)

    calib, metrics, test_probs = {}, {"horizons": {}}, {}
    rng = np.random.default_rng(7)
    for h in HORIZONS:
        th = time.perf_counter()
        X, y, _ = to_xy(train_df, h)
        pos = np.flatnonzero(y == 1)
        neg = np.flatnonzero(y == 0)
        n_neg = min(len(neg), max(MAX_TRAIN_ROWS - len(pos), 0))
        idx = np.sort(np.r_[pos, rng.choice(neg, n_neg, replace=False)])
        X, y = X[idx], y[idx]
        spw = float(np.clip((y == 0).sum() / max((y == 1).sum(), 1), 10, 200))
        Xv, yv, _ = to_xy(val_df, h)
        dtrain = lgb.Dataset(X, y, feature_name=FEATURES, categorical_feature=CATEGORICAL, free_raw_data=True)
        dval = lgb.Dataset(Xv, yv, reference=dtrain)
        booster = lgb.train(
            {**PARAMS, "scale_pos_weight": spw},
            dtrain,
            num_boost_round=500,
            valid_sets=[dval],
            callbacks=[lgb.early_stopping(40, verbose=False)],
        )
        booster.save_model(str(p.model(h)), num_iteration=booster.best_iteration)

        raw_v = booster.predict(Xv, num_iteration=booster.best_iteration, raw_score=True)
        a, b = fit_platt(raw_v, yv)
        pv = calibrate(raw_v, a, b)
        cutoff, f1v = best_f1_cutoff(yv, pv)
        calib[h] = {"a": a, "b": b, "cutoff": cutoff}

        Xt, yt, _ = to_xy(test_df, h)
        pt = calibrate(booster.predict(Xt, num_iteration=booster.best_iteration, raw_score=True), a, b)
        # Lead time needs a probability for every test row, including ones with unknown labels.
        test_probs[h] = calibrate(
            booster.predict(test_df.select(FEATURES).to_numpy().astype(np.float32), num_iteration=booster.best_iteration, raw_score=True),
            a,
            b,
        )
        imp = booster.feature_importance("gain")
        metrics["horizons"][str(h)] = {
            "cutoff": round(cutoff, 4),
            "scale_pos_weight": round(spw, 2),
            "best_iteration": booster.best_iteration,
            "n_train": int(len(y)),
            "train_pos_rate": round(float(y.mean()), 4),
            "validation": {**prf(yv, pv, cutoff), "auc_pr": round(average_precision(yv, pv), 4), "base_rate": round(float(yv.mean()), 4)},
            "test": {**prf(yt, pt, cutoff), "auc_pr": round(average_precision(yt, pt), 4), "base_rate": round(float(yt.mean()), 4)},
            "top_features": [FEATURES[i] for i in np.argsort(-imp)[:8]],
            "train_seconds": round(time.perf_counter() - th, 1),
        }
        m = metrics["horizons"][str(h)]
        log.info(
            "H=%3dh: cutoff=%.3f test P=%.3f R=%.3f AUC-PR=%.3f (base %.3f), %d iters, %.0fs",
            h, cutoff, m["test"]["precision"], m["test"]["recall"], m["test"]["auc_pr"], m["test"]["base_rate"],
            booster.best_iteration, m["train_seconds"],
        )

    metrics["lead_time_test"] = lead_times(test_df, test_probs, {h: calib[h]["cutoff"] for h in HORIZONS})
    metrics["split"] = {
        "train_end": TRAIN_END.isoformat(),
        "validation": [VAL_START.isoformat(), VAL_END.isoformat()],
        "test": [TEST_START.isoformat(), TEST_END.isoformat()],
    }
    metrics["n_stations"] = len(meta["station_codes"])
    metrics["trained_utc"] = utcnow().isoformat()
    metrics["train_seconds_total"] = round(time.perf_counter() - t0, 1)
    p.metrics.write_text(json.dumps(metrics, indent=2))
    p.model_meta.write_text(
        json.dumps(
            {
                "features": FEATURES,
                "categorical": CATEGORICAL,
                "horizons": list(HORIZONS),
                "calibration": {str(h): v for h, v in calib.items()},
                "station_codes": meta["station_codes"],
                "trained_utc": metrics["trained_utc"],
            },
            indent=1,
        )
    )
    log.info("Lead time (any head): %s", metrics["lead_time_test"]["any"])
    return metrics


def _min_time():
    return _scan().select(pl.col("time").min()).collect().item()
