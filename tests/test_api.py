RISK_KEYS = {
    "id", "name", "lat", "lon", "level_now", "p95", "pct_of_record", "p6", "p24", "p48", "p120", "risk",
    "status", "pred_cross_utc", "fill_deadline_utc", "bags_needed", "rain48_p50", "rain48_p90",
}
STATUSES = {"FILL_NOW", "PREPARE", "WATCH", "CLEAR"}


def test_stations(client):
    r = client.get("/stations").json()
    assert len(r) == 3
    assert set(r[0]) == {"id", "name", "lat", "lon", "county"}


def test_risk_shape_and_order(client):
    r = client.get("/risk").json()
    assert len(r) == 3
    for row in r:
        assert RISK_KEYS <= set(row)
        assert row["status"] in STATUSES
        assert 0 <= row["p6"] <= row["p24"] <= row["p48"] <= row["p120"] <= 1
        assert 0 <= row["risk"] <= 100
    risks = [x["risk"] for x in r]
    assert risks == sorted(risks, reverse=True) and max(risks) in (0.0, 100.0)


def test_station_detail(client):
    sid = client.get("/risk").json()[0]["id"]
    d = client.get(f"/station/{sid}").json()
    assert RISK_KEYS <= set(d)
    assert 60 <= len(d["history_72h"]) <= 72 and {"t", "level"} == set(d["history_72h"][0])
    assert isinstance(d["ensemble_fan"], list)
    assert d["decision_inputs"]["crews"] == 2
    assert len(d["shap_top5_24h"]) == 5 and {"feature", "value", "contribution"} == set(d["shap_top5_24h"][0])
    assert client.get("/station/99999").status_code == 404


def test_lead_times(client):
    r = client.get("/lead-times").json()
    assert len(r) == 3
    assert {"id", "name", "status", "L", "pred_cross_utc", "fill_deadline_utc", "hours_remaining", "tasks"} <= set(r[0])
    for row in r:
        if row["pred_cross_utc"]:
            assert {t["task"] for t in row["tasks"]} == {
                "clear culvert screens", "fill sandbags", "open collection points", "rest centre on standby", "public warning",
            }


def test_settings_override(client):
    sid = client.get("/risk").json()[0]["id"]
    r = client.post("/settings", json={"stations": {sid: {"defence_length_m": 100}}})
    assert r.status_code == 200
    row = next(x for x in client.get("/risk").json() if x["id"] == sid)
    assert row["bags_needed"] == 1500
    lt = next(x for x in client.get("/lead-times").json() if x["id"] == sid)
    assert lt["L"] == 10.25
    assert client.post("/settings", json={"global": {"bogus": 1}}).status_code == 422
    assert client.post("/settings", json={"global": {"bags_high": 7}}).status_code == 422
    client.post("/settings", json={"stations": {sid: {"defence_length_m": 200}}})


def test_satellite_endpoints(client):
    s = client.get("/satellite/latest", params={"bbox": "-8,52,-6,53"}).json()
    assert s["type"] == "FeatureCollection"
    assert s["properties"]["status"] == "unavailable" and s["properties"]["source"] == "Copernicus GFM / Sentinel-1"
    assert "reason" in s["properties"] and "observed_at" in s["properties"]
    assert client.get("/satellite/latest", params={"bbox": "nonsense"}).status_code == 400
    assert client.get("/satellite/wms").json() == {"available": False, "reason": client.get("/satellite/wms").json()["reason"]}


def test_data_status(client):
    d = client.get("/data-status").json()
    assert d["stations_loaded"] == 3 and d["feature_rows"] > 0
    assert set(d["model_metrics"]["horizons"]) == {"6", "24", "48", "120"}
    for src in ("OPW", "Open-Meteo IFS", "Open-Meteo AIFS", "CFRAM", "GFM", "EMSR860", "CDSE WMS"):
        assert src in d["sources"]


def test_demo_timeline(client):
    t = client.get("/demo/timeline").json()
    assert len(t["snapshots"]) == 33
    assert t["snapshots"][0]["at"] == "2026-01-22T00:00:00Z" and t["snapshots"][-1]["at"] == "2026-01-30T00:00:00Z"
    assert t["landfall_utc"] == "2026-01-27T00:00:00Z"
    assert [s["at"] for s in t["snapshots"] if s["is_landfall"]] == ["2026-01-27T00:00:00Z"]


def test_demo_risk_and_lead_times(client):
    r = client.get("/demo/risk", params={"at": "2026-01-26T12:00:00Z"}).json()
    assert len(r) == 3
    assert RISK_KEYS <= set(r[0]) and r[0]["forecast_source"] == "proxy"
    lt = client.get("/demo/lead-times", params={"at": "2026-01-26T12:00:00Z"}).json()
    assert len(lt) == 3 and lt[0]["forecast_source"] == "proxy"
    assert client.get("/demo/risk", params={"at": "garbage"}).status_code == 400


def test_demo_uses_only_past_levels(client):
    """level_now in a demo snapshot must equal the stored level at that hour, not a later one."""
    import polars as pl

    from floodline.config import paths

    at = "2026-01-24T06:00:00Z"
    row = client.get("/demo/risk", params={"at": at}).json()[0]
    lv = pl.read_parquet(paths().levels / f"{row['id']}.parquet")
    expected = lv.filter(pl.col("time") == pl.lit(at).str.to_datetime(time_zone="UTC"))["level"][0]
    assert abs(row["level_now"] - expected) < 1e-3
