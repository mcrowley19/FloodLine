from conftest import ACQ


def test_empty_before_first_acquisition(client):
    fc = client.get("/demo/satellite", params={"at": "2026-01-27T00:00:00Z"}).json()
    assert fc["type"] == "FeatureCollection" and fc["features"] == []


def test_non_empty_after_acquisition(client):
    fc = client.get("/demo/satellite", params={"at": "2026-01-30T00:00:00Z"}).json()
    assert len(fc["features"]) == 1
    props = fc["features"][0]["properties"]
    assert props["aoi"] == "County Kilkenny" and props["acquisition_utc"] == ACQ


def test_boundary_is_inclusive(client):
    assert len(client.get("/demo/satellite", params={"at": ACQ}).json()["features"]) == 1
    assert client.get("/demo/satellite", params={"at": "2026-01-29T18:12:00Z"}).json()["features"] == []
