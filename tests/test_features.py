import numpy as np
import pytest

from floodline.features import FEATURES, _shift, compute_features, ffill, future_max, station_stats


def _build(level, rain):
    level = np.asarray(level, dtype=float)
    stats = station_stats(level)
    static = {"lat": 53.0, "lon": -7.0, "exposure": 2.0, "station_code": 4}
    return compute_features(level, np.asarray(rain, dtype=float), stats, np.sort(level[~np.isnan(level)]), static), stats


def test_shift_past_and_future():
    a = np.arange(5.0)
    assert np.isnan(_shift(a, 2)[:2]).all() and list(_shift(a, 2)[2:]) == [0, 1, 2]
    assert list(_shift(a, -1)[:4]) == [1, 2, 3, 4] and np.isnan(_shift(a, -1)[4])


def test_ffill_respects_limit():
    a = np.array([1.0, np.nan, np.nan, np.nan, np.nan, 2.0])
    out = ffill(a, 3)
    assert list(out[:4]) == [1, 1, 1, 1] and np.isnan(out[4]) and out[5] == 2


def test_lags_rise_rates_and_percentile():
    level = np.arange(48, dtype=float)  # +1 m per hour
    f, stats = _build(level, np.zeros(48))
    t = 30
    assert f["level_now"][t] == 30
    for k in (1, 3, 6, 12, 24):
        assert f[f"level_lag{k}h"][t] == 30 - k
    assert f["rise_rate_3h"][t] == pytest.approx(1.0)
    assert f["rise_rate_6h"][t] == pytest.approx(1.0)
    assert f["pct_of_record"][t] == pytest.approx(31 / 48)
    assert f["level_to_p95"][t] == pytest.approx(30 - stats["stn_p95"])
    assert f["station_id"][t] == 4 and f["exposure"][t] == 2.0


def test_rain_windows_past_and_future():
    n = 24 * 60
    rain = np.zeros(n)
    rain[500] = 10.0  # 10 mm in the hour ending at t=500
    f, _ = _build(np.ones(n) + np.linspace(0, 1, n), rain)
    assert f["rain_past_1h"][500] == 10 and f["rain_past_1h"][501] == 0
    assert f["rain_past_6h"][505] == 10 and f["rain_past_6h"][506] == 0
    assert f["rain_past_30d"][500 + 719] == 10 and f["rain_past_30d"][500 + 720] == 0
    # future windows exclude the current hour
    assert f["rain_next_6h"][499] == 10 and f["rain_next_6h"][500] == 0
    assert f["rain_next_6h"][494] == 10 and f["rain_next_6h"][493] == 0
    assert f["rain_next_7d"][500 - 168] == 10
    assert np.isnan(f["rain_next_7d"][n - 10])  # incomplete window at the record end


def test_labels_follow_future_max_against_p95():
    n = 400
    level = np.full(n, 1.0) + np.linspace(0, 0.01, n)
    level[300] = 5.0  # single spike above P95
    f, stats = _build(level, np.zeros(n))
    assert stats["stn_p95"] < 5.0
    assert f["label_6"][299] == 1 and f["label_6"][294] == 1 and f["label_6"][293] == 0
    assert f["label_24"][276] == 1 and f["label_24"][275] == 0
    assert f["label_120"][180] == 1 and f["label_120"][179] == 0
    assert f["label_6"][300] == 0  # the crossing hour itself is not in its own future window
    assert np.isnan(f["label_6"][n - 1])


def test_future_max_ignores_gaps():
    a = np.array([1.0, np.nan, 3.0, np.nan, np.nan])
    fm = future_max(a, 2)
    assert fm[0] == 3.0 and fm[1] == 3.0 and np.isnan(fm[3]) and np.isnan(fm[4])


def test_feature_list_complete():
    f, _ = _build(np.linspace(0, 1, 800), np.zeros(800))
    assert all(k in f for k in FEATURES)
