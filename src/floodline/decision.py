"""Newsvendor sandbag rule and lead-time task list.

Filling N bags that turn out unneeded costs cost_fill * N; being short when the river
crosses P95 costs cost_short. Fill when P(cross within lead time L) >= p*, where
p* = cost_fill * N / (cost_fill * N + cost_short).
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, fields
from datetime import datetime, timedelta, timezone

from .config import paths

BAGS_PER_M = {1: 5, 2: 15, 3: 30}
TASKS = [
    ("rest centre on standby", 24.0),
    ("public warning", 18.0),
    ("clear culvert screens", 8.0),
    ("open collection points", 4.0),
]

# Supply ratios. Sources: USACE / NDSU "Sandbagging for Flood Protection" (a cubic yard of sand
# fills ~100 bags of 30 lb; 3 bag courses ~ 1 ft high; poly sheeting >= 6 mil with 3 ft
# overlaps). Apron width and tipper payload are planning assumptions.
SAND_T_PER_BAG = 30 * 0.4536 / 1000  # 30 lb fill
SAND_M3_PER_BAG = 0.7646 / 100  # 1 yd^3 per 100 bags
COURSE_HEIGHT_M = 0.3048 / 3
SHEET_APRON_M = 1.0  # sheeting run out on the ground on the water side, weighted with bags
SHEET_OVERLAP = 1.2  # 0.9 m overlaps between sheets
TIPPER_PAYLOAD_T = 20.0


@dataclass
class DecisionInputs:
    defence_length_m: float = 200
    bags_high: int = 2
    crews: int = 2
    fill_rate_bags_per_crew_hour: float = 100
    travel_h: float = 0.75
    margin_h: float = 2
    cost_fill_unneeded_per_bag: float = 2.0
    cost_short: float = 50000
    resupply_h: float = 24  # time to source bags and sand before they can be filled

    @classmethod
    def keys(cls) -> set[str]:
        return {f.name for f in fields(cls)}


def bags_needed(d: DecisionInputs) -> int:
    if d.bags_high not in BAGS_PER_M:
        raise ValueError("bags_high must be 1, 2 or 3")
    return int(round(d.defence_length_m * BAGS_PER_M[d.bags_high]))


def lead_time_h(d: DecisionInputs, n: int | None = None) -> float:
    n = bags_needed(d) if n is None else n
    return n / (d.crews * d.fill_rate_bags_per_crew_hour) + d.travel_h + d.margin_h


def critical_ratio(d: DecisionInputs, n: int | None = None) -> float:
    n = bags_needed(d) if n is None else n
    over = d.cost_fill_unneeded_per_bag * n
    return over / (over + d.cost_short)


def supplies_full(d: DecisionInputs, n: int | None = None) -> dict[str, float]:
    """Everything needed to build the full defence once."""
    n = bags_needed(d) if n is None else n
    face = 2 * d.bags_high * COURSE_HEIGHT_M + SHEET_APRON_M
    sand_t = n * SAND_T_PER_BAG
    return {
        "sandbags": n,
        "sand_t": sand_t,
        "sand_m3": n * SAND_M3_PER_BAG,
        "sheeting_m2": d.defence_length_m * face * SHEET_OVERLAP,
        "tipper_loads": math.ceil(sand_t / TIPPER_PAYLOAD_T) if n else 0,
        "crew_hours": n / d.fill_rate_bags_per_crew_hour,
    }


SUPPLY_UNITS = {
    "sandbags": ("Sandbags", "bags"),
    "sand_t": ("Sand", "t"),
    "sand_m3": ("Sand volume", "m³"),
    "sheeting_m2": ("Polythene sheeting ≥0.15 mm", "m²"),
    "tipper_loads": ("Tipper loads (20 t)", "loads"),
    "crew_hours": ("Filling crew-hours", "h"),
}


def supplies(d: DecisionInputs, probs: dict[int, float], n: int | None = None) -> dict:
    """What to source now, scaled by the chance the defence is needed.

    The horizon is the fill lead time plus the time to source materials. If that probability
    clears the newsvendor threshold p*, the whole kit is worth having on hand; below it the
    station contributes its expected need (p × kit) to a pooled county stock.
    """
    n = bags_needed(d) if n is None else n
    pstar = critical_ratio(d, n)
    p = interp_prob(lead_time_h(d, n) + d.resupply_h, probs)
    full_kit = p >= pstar
    scale = 1.0 if full_kit else p
    items = []
    for key, qty in supplies_full(d, n).items():
        label, unit = SUPPLY_UNITS[key]
        get = qty * scale
        get = math.ceil(get) if key in ("sandbags", "tipper_loads") else round(get, 1)
        items.append({"key": key, "label": label, "unit": unit, "full": round(qty, 1), "get": get})
    return {"p_need": round(p, 4), "horizon_h": round(lead_time_h(d, n) + d.resupply_h, 1), "full_kit": full_kit, "items": items}


def monotone(probs: dict[int, float]) -> dict[int, float]:
    """Heads are trained independently; P(cross within t) must be non-decreasing in t."""
    out, run = {}, 0.0
    for h in sorted(probs):
        run = max(run, float(probs[h]))
        out[h] = min(run, 1.0)
    return out


def interp_prob(t: float, probs: dict[int, float]) -> float:
    """P(cross within t hours), log-linear in time between the 6/24/48/120 h heads.

    Below the shortest head the probability scales linearly from 0 at t=0; beyond the
    longest head it is held flat (no extrapolation).
    """
    p = monotone(probs)
    hs = sorted(p)
    if t <= 0:
        return 0.0
    if t <= hs[0]:
        return p[hs[0]] * t / hs[0]
    if t >= hs[-1]:
        return p[hs[-1]]
    for a, b in zip(hs, hs[1:]):
        if a <= t <= b:
            w = (math.log(t) - math.log(a)) / (math.log(b) - math.log(a))
            return p[a] + w * (p[b] - p[a])
    return p[hs[-1]]


def interp_cutoff(t: float, cutoffs: dict[int, float]) -> float:
    hs = sorted(cutoffs)
    if t <= hs[0]:
        return cutoffs[hs[0]]
    if t >= hs[-1]:
        return cutoffs[hs[-1]]
    for a, b in zip(hs, hs[1:]):
        if a <= t <= b:
            w = (math.log(t) - math.log(a)) / (math.log(b) - math.log(a))
            return cutoffs[a] + w * (cutoffs[b] - cutoffs[a])
    return cutoffs[hs[-1]]


def predicted_crossing_h(probs: dict[int, float], cutoffs: dict[int, float], max_h: int = 120) -> int | None:
    """First hour where interpolated P(cross within t) reaches the (interpolated) model cutoff."""
    for t in range(1, max_h + 1):
        if interp_prob(t, probs) >= interp_cutoff(t, cutoffs):
            return t
    return None


def decide(
    probs: dict[int, float],
    d: DecisionInputs,
    now: datetime,
    cutoffs: dict[int, float],
    already_above: bool = False,
) -> dict:
    n = bags_needed(d)
    L = lead_time_h(d, n)
    pstar = critical_ratio(d, n)
    p_L = interp_prob(L, probs)
    if p_L >= pstar:
        status = "FILL_NOW"
    elif interp_prob(L + 24, probs) >= pstar:
        status = "PREPARE"
    elif interp_prob(120, probs) >= pstar:
        status = "WATCH"
    else:
        status = "CLEAR"
    cross_h = 0 if already_above else predicted_crossing_h(probs, cutoffs)
    cross = now + timedelta(hours=cross_h) if cross_h is not None else None
    deadline = cross - timedelta(hours=L) if cross is not None else None
    return {
        "status": status,
        "bags_needed": n,
        "lead_time_h": round(L, 2),
        "p_star": round(pstar, 4),
        "p_within_L": round(p_L, 4),
        "pred_cross_utc": iso(cross),
        "fill_deadline_utc": iso(deadline),
        "hours_remaining": round((deadline - now).total_seconds() / 3600, 1) if deadline is not None else None,
        "supplies": supplies(d, probs, n),
    }


def task_list(cross: datetime | None, fill_deadline: datetime | None) -> list[dict]:
    if cross is None:
        return []
    tasks = [{"task": name, "deadline_utc": iso(cross - timedelta(hours=h))} for name, h in TASKS]
    tasks.append({"task": "fill sandbags", "deadline_utc": iso(fill_deadline)})
    return sorted(tasks, key=lambda x: x["deadline_utc"])


def iso(t: datetime | None) -> str | None:
    if t is None:
        return None
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def risk_scores(p48: list[float], exposure: list[float]) -> list[float]:
    raw = [a * b for a, b in zip(p48, exposure)]
    top = max(raw) if raw else 0.0
    return [round(100 * r / top, 1) if top > 0 else 0.0 for r in raw]


# ---------- settings (POST /settings) ----------


def load_settings() -> dict:
    p = paths().settings
    if p.exists():
        return json.loads(p.read_text())
    return {"global": {}, "stations": {}}


def save_settings(s: dict) -> None:
    p = paths().settings
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(s, indent=2))


def inputs_for(station_id: str, settings: dict | None = None) -> DecisionInputs:
    s = settings if settings is not None else load_settings()
    merged = {**asdict(DecisionInputs()), **s.get("global", {}), **s.get("stations", {}).get(station_id, {})}
    return DecisionInputs(**{k: v for k, v in merged.items() if k in DecisionInputs.keys()})


def validate_overrides(o: dict) -> dict:
    bad = set(o) - DecisionInputs.keys()
    if bad:
        raise ValueError(f"unknown decision inputs: {sorted(bad)}")
    d = DecisionInputs(**{**asdict(DecisionInputs()), **o})
    bags_needed(d)
    if d.crews <= 0 or d.fill_rate_bags_per_crew_hour <= 0 or d.cost_short <= 0 or d.defence_length_m < 0 or d.resupply_h < 0:
        raise ValueError("crews, fill rate, cost_short must be > 0; defence length and resupply_h >= 0")
    return o

