from datetime import datetime, timedelta, timezone

import pytest

from floodline.decision import (
    DecisionInputs,
    bags_needed,
    critical_ratio,
    decide,
    interp_prob,
    lead_time_h,
    risk_scores,
    task_list,
)

NOW = datetime(2026, 1, 26, 12, tzinfo=timezone.utc)
CUTOFFS = {6: 0.5, 24: 0.5, 48: 0.5, 120: 0.5}


def test_worked_example():
    """N = 1500 bags, 2 crews -> L ~ 10 h, p* ~ 0.06."""
    d = DecisionInputs(defence_length_m=100, bags_high=2, crews=2)
    n = bags_needed(d)
    assert n == 1500
    L = lead_time_h(d)
    assert L == pytest.approx(1500 / 200 + 0.75 + 2)  # 10.25
    assert round(L) == 10
    p = critical_ratio(d)
    assert p == pytest.approx(3000 / 53000)
    assert round(p, 2) == 0.06


def test_defaults():
    d = DecisionInputs()
    assert bags_needed(d) == 3000
    assert lead_time_h(d) == pytest.approx(17.75)


def test_interpolation_log_linear_and_monotone():
    probs = {6: 0.1, 24: 0.3, 48: 0.2, 120: 0.6}  # non-monotone heads get repaired
    assert interp_prob(6, probs) == pytest.approx(0.1)
    assert interp_prob(48, probs) == pytest.approx(0.3)
    assert interp_prob(3, probs) == pytest.approx(0.05)
    assert interp_prob(500, probs) == pytest.approx(0.6)
    mid = interp_prob(12, {6: 0.1, 24: 0.3, 48: 0.3, 120: 0.3})
    assert mid == pytest.approx(0.1 + 0.2 * 0.5)  # log(12) is halfway between log 6 and log 24


@pytest.mark.parametrize(
    "probs,status",
    [
        ({6: 0.05, 24: 0.4, 48: 0.6, 120: 0.8}, "FILL_NOW"),
        ({6: 0.0, 24: 0.01, 48: 0.2, 120: 0.3}, "PREPARE"),
        ({6: 0.0, 24: 0.0, 48: 0.01, 120: 0.15}, "WATCH"),
        ({6: 0.0, 24: 0.0, 48: 0.0, 120: 0.01}, "CLEAR"),
    ],
)
def test_status_ladder(probs, status):
    d = DecisionInputs(defence_length_m=100)  # L = 10.25 h, p* = 0.0566
    assert decide(probs, d, NOW, CUTOFFS)["status"] == status


def test_crossing_and_deadline():
    d = DecisionInputs(defence_length_m=100)
    out = decide({6: 0.1, 24: 0.9, 48: 0.95, 120: 0.99}, d, NOW, CUTOFFS)
    cross = datetime.fromisoformat(out["pred_cross_utc"].replace("Z", "+00:00"))
    deadline = datetime.fromisoformat(out["fill_deadline_utc"].replace("Z", "+00:00"))
    assert NOW < cross <= NOW + timedelta(hours=24)
    assert cross - deadline == timedelta(hours=10.25)
    assert decide({6: 0, 24: 0, 48: 0, 120: 0}, d, NOW, CUTOFFS)["pred_cross_utc"] is None


def test_task_list_offsets():
    cross = NOW + timedelta(hours=30)
    tasks = {t["task"]: t["deadline_utc"] for t in task_list(cross, cross - timedelta(hours=10))}
    assert tasks["clear culvert screens"] == "2026-01-27T10:00:00Z"
    assert tasks["open collection points"] == "2026-01-27T14:00:00Z"
    assert tasks["rest centre on standby"] == "2026-01-26T18:00:00Z"
    assert tasks["public warning"] == "2026-01-27T00:00:00Z"
    assert tasks["fill sandbags"] == "2026-01-27T08:00:00Z"


def test_risk_normalised():
    assert risk_scores([0.5, 0.25, 0.0], [2.0, 2.0, 5.0]) == [100.0, 50.0, 0.0]
    assert risk_scores([0.0], [1.0]) == [0.0]
