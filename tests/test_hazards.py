import io
from datetime import datetime, timedelta, timezone

import numpy as np
import polars as pl
import pytest

from floodline import coastal, groundwater, surface
from floodline.hazards import SOIL_CLASSES, block_mean, decode_soil_png, susceptibility

AT = datetime(2026, 1, 26, 12, tzinfo=timezone.utc)


def _hourly(at, past_mm_per_h=0.0, future=None, hours_past=168, hours_future=72, models=3):
    t0 = np.datetime64(at.replace(tzinfo=None), "h")
    times = t0 + np.arange(-hours_past + 1, hours_future + 1).astype("timedelta64[h]")
    mat = np.zeros((len(times), models), dtype=np.float32)
    mat[: hours_past] = past_mm_per_h
    if future is not None:
        for k, v in future.items():  # hours ahead -> mm in that hour (all models)
            mat[hours_past - 1 + k] = v
    return times, mat


# ---------- surface water ----------


def test_threshold_factor_and_wetness():
    assert surface.wetness(5) == 0 and surface.wetness(30) == 0.5 and surface.wetness(80) == 1
    assert surface.threshold_factor(0, 0) == 1.0
    assert surface.threshold_factor(1, 1) == 0.7
    assert surface.threshold_factor(0.5, 0.5) == pytest.approx(0.825)


def test_dry_forecast_is_clear():
    times, mat = _hourly(AT)
    r = surface.assess_cell(times, mat, AT, susceptibility=0.9, urban_share=0.5)
    assert r["level"] == "CLEAR" and r["models_available"] == 3


def test_intense_burst_is_high_on_susceptible_ground_only_moderate_on_dry_ground():
    # 25 mm in one hour, 10 hours ahead, all 3 models agree.
    times, mat = _hourly(AT, future={10: 25.0})
    dry_ground = surface.assess_cell(times, mat, AT, susceptibility=0.0, urban_share=0.0)
    assert dry_ground["driver"] == "1h" and dry_ground["ratio"] == pytest.approx(25 / 20)
    assert dry_ground["level"] == "MODERATE"
    times, mat = _hourly(AT, past_mm_per_h=0.4, future={10: 25.0})  # ~67 mm last week: saturated
    wet_urban = surface.assess_cell(times, mat, AT, susceptibility=1.0, urban_share=0.5)
    assert wet_urban["thresholds_mm"]["1h"] == pytest.approx(14.0)  # 25 / 14 = 1.79 >= 1.5
    assert wet_urban["level"] == "HIGH" and wet_urban["models_agreeing"] == 3
    assert wet_urban["peak_utc"].startswith("2026-01-26T")


def test_high_needs_two_models():
    times, mat = _hourly(AT, future={10: 60.0})
    mat[:, 1:] = 0.0  # only one model has the downpour
    r = surface.assess_cell(times, mat, AT, susceptibility=0.0, urban_share=0.0)
    assert r["ratio"] >= 1.5 and r["models_agreeing"] == 1 and r["level"] == "MODERATE"


def test_ensemble_p90_feeds_24h_window():
    times, mat = _hourly(AT)
    r = surface.assess_cell(times, mat, AT, susceptibility=0.0, urban_share=0.0, ens_rain24_p90=45.0)
    assert r["driver"] == "24h" and r["level"] == "MODERATE"


def test_priority_favours_towns():
    cells = pl.DataFrame(
        {"cell_id": ["A", "B"], "lat": [53.0, 53.1], "lon": [-7.0, -7.1], "county": ["X", "X"], "susceptibility": [0.5, 0.5], "urban_share": [0.6, 0.0],
         "poor_frac": [0.2, 0.2], "very_poor_frac": [0.0, 0.0], "peat_frac": [0.0, 0.0], "land_frac": [1.0, 1.0]}
    )
    rain = {cid: _hourly(AT, future={5: 30.0}) for cid in ("A", "B")}
    rows = surface.assess_all(cells, rain, AT)
    assert [r["cell_id"] for r in rows] == ["A", "B"] and rows[0]["priority"] == 100.0 and rows[1]["priority"] == 25.0


# ---------- groundwater ----------


def _daily_rain(days: int, mm: float, end: datetime, spike_days: int = 0, spike_mm: float = 0.0) -> pl.DataFrame:
    times = pl.datetime_range(end - timedelta(days=days), end, "1d", time_zone="UTC", eager=True)
    vals = np.full(len(times), mm)
    if spike_days:
        vals[-spike_days:] = spike_mm
    return pl.DataFrame({"time": times, "precip": vals.astype(np.float32)})


def test_groundwater_percentiles_and_levels():
    rng = np.random.default_rng(0)
    end = AT
    rain = _daily_rain(3 * 365, 0, end)
    rain = rain.with_columns(pl.Series("precip", rng.gamma(0.8, 4.0, rain.height).astype(np.float32)))
    # Last 90 days at the long-run average (3.2 mm/day), so "normal" really is typical.
    recent = pl.col("time") > end - timedelta(days=90)
    rain = rain.with_columns(pl.when(recent).then(3.2).otherwise(pl.col("precip")).cast(pl.Float32).alias("precip"))
    normal = groundwater.cell_wetness(rain, end, future_7d=22.0)
    wet = groundwater.cell_wetness(rain.with_columns(pl.when(pl.col("time") > end - timedelta(days=60)).then(15.0).otherwise(pl.col("precip")).alias("precip")), end, future_7d=80.0)
    assert normal["percentile"] < 0.9 and wet["percentile"] >= 0.98
    zones = pl.DataFrame({"zone_id": ["h", "m", "l"], "probability": ["high", "medium", "low"], "area_ha": [10.0, 10.0, 10.0], "lat": [53.0] * 3, "lon": [-9.0] * 3})
    key = groundwater.openmeteo.cell_key(*groundwater.openmeteo.cell_of(53.0, -9.0))
    rows = {r["zone_id"]: r["level"] for r in groundwater.assess_zones(zones, {key: wet}, end)}
    assert rows == {"h": "HIGH", "m": "MODERATE", "l": "WATCH"}
    summer = {r["zone_id"]: r["level"] for r in groundwater.assess_zones(zones, {key: wet}, datetime(2026, 7, 1, tzinfo=timezone.utc))}
    assert summer == {"h": "MODERATE", "m": "WATCH", "l": "CLEAR"}


def test_groundwater_needs_history():
    assert groundwater.cell_wetness(_daily_rain(30, 5, AT), AT, 0.0)["percentile"] is None


# ---------- coastal ----------


def _surge(total_peak: float, surge_peak: float) -> pl.DataFrame:
    t = pl.datetime_range(AT, AT + timedelta(hours=48), "10m", time_zone="UTC", eager=True)
    n = len(t)
    tide = np.sin(np.linspace(0, 8 * np.pi, n)) * (total_peak - surge_peak)
    surge = np.full(n, surge_peak)
    return pl.DataFrame({"station_id": ["X"] * n, "time": t, "tide": tide, "surge": surge}).with_columns((pl.col("tide") + pl.col("surge")).alias("total"))


@pytest.mark.parametrize("peak,surge,level", [(2.6, 0.5, "HIGH"), (2.25, 0.2, "MODERATE"), (2.05, 0.1, "WATCH"), (1.5, 0.45, "WATCH"), (1.5, 0.1, "CLEAR")])
def test_coastal_levels(peak, surge, level):
    st = {"station_id": "X", "name": "X", "lat": 53.0, "lon": -9.0, "hw_p95": 2.0, "hw_p99": 2.2}
    r = coastal.assess_station(st, _surge(peak, surge))
    assert r["level"] == level
    assert r["peak_total_m"] == pytest.approx(peak, abs=0.02)


def test_coastal_without_tide_station_uses_surge():
    st = {"station_id": "X", "name": "X", "lat": 53.0, "lon": -9.0, "hw_p95": None, "hw_p99": None}
    assert coastal.assess_station(st, _surge(1.0, 0.7))["level"] == "MODERATE"
    assert coastal.assess_station(st, _surge(1.0, 0.1))["level"] == "CLEAR"


# ---------- static layers ----------


def test_decode_soil_png_only_exact_codes():
    import rasterio
    from rasterio.io import MemoryFile

    red = np.array([[10, 30, 255], [11, 70, 80]], dtype=np.uint8)
    rgb = np.stack([red, np.zeros_like(red), np.zeros_like(red)])
    with MemoryFile() as mf:
        with mf.open(driver="PNG", width=3, height=2, count=3, dtype="uint8") as dst:
            dst.write(rgb)
        png = mf.read()
    out = decode_soil_png(png)
    assert out.tolist() == [[10, 30, 0], [0, 70, 80]]
    assert set(SOIL_CLASSES.values()) >= {10, 30, 70, 80}


def test_block_mean_and_susceptibility():
    a = np.zeros((4, 4))
    a[:2, :2] = 1
    assert block_mean(a, 2).tolist() == [[1, 0], [0, 0]]
    base = {k: [0.0] for k in ("poor_frac", "very_poor_frac", "imperfect_frac", "peat_frac", "made_frac", "sw_2015_16_frac", "alluvium_frac", "nifm_fluvial100_frac")}
    dry = susceptibility(pl.DataFrame({**base, "land_frac": [1.0]}))
    wet = susceptibility(pl.DataFrame({**base, "land_frac": [1.0], "poor_frac": [1.0], "sw_2015_16_frac": [0.05], "alluvium_frac": [0.2]}))
    assert dry["susceptibility"][0] == 0.0 and wet["susceptibility"][0] == pytest.approx(1.0)
