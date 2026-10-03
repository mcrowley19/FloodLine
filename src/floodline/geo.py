"""Exposure (CFRAM 10-year fluvial extent near each gauge) and county lookup.

Both are optional enrichments: any failure degrades to exposure = 1.0 / county = "Unknown".
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import polars as pl

from .config import URLS, paths, record_health

log = logging.getLogger("floodline.geo")

ITM = "EPSG:2157"
CFRAM_10YR = "esds_floodmap_ext_f_c_0010.shp"
EXPOSURE_RADIUS_M = 5000
EXPOSURE_FLOOR_KM2 = 0.05  # stations outside CFRAM-modelled reaches still rank by probability


def compute_exposure(stations: pl.DataFrame, zip_path: Path) -> pl.DataFrame:
    """km2 of CFRAM 10-year (10% AEP) fluvial extent within 5 km of each station."""
    import geopandas as gpd

    extents = gpd.read_file(f"zip://{zip_path.resolve()}!{CFRAM_10YR}", columns=[], engine="pyogrio")
    if extents.crs is None:
        extents = extents.set_crs(ITM)
    extents = extents.to_crs(ITM)
    extents = extents[extents.geometry.notna() & ~extents.geometry.is_empty]
    pts = gpd.GeoDataFrame(
        {"id": stations["id"].to_list()},
        geometry=gpd.points_from_xy(stations["lon"].to_list(), stations["lat"].to_list()),
        crs="EPSG:4326",
    ).to_crs(ITM)
    pts["geometry"] = pts.buffer(EXPOSURE_RADIUS_M)
    sidx = extents.sindex
    areas = []
    for sid, buf in zip(pts["id"], pts.geometry):
        cand = extents.geometry.iloc[sidx.query(buf, predicate="intersects")]
        if len(cand) == 0:
            areas.append(0.0)
            continue
        inter = cand.make_valid().intersection(buf)
        areas.append(float(inter.union_all().area) / 1e6)
    return pl.DataFrame({"id": pts["id"].to_list(), "exposure_km2": areas}).with_columns(
        pl.max_horizontal(pl.col("exposure_km2"), pl.lit(EXPOSURE_FLOOR_KM2)).alias("exposure")
    )


async def build_exposure(c, stations: pl.DataFrame, force: bool = False) -> pl.DataFrame:
    p = paths()
    out = p.exposure
    if out.exists() and not force:
        return pl.read_parquet(out)
    zip_path = p.raw / "cfram.zip"
    try:
        if not zip_path.exists() or zip_path.stat().st_size < 50_000_000:
            log.info("Downloading CFRAM flood extents (~100 MB)")
            zip_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = zip_path.with_suffix(".part")
            async with c.stream("GET", URLS["cfram"], timeout=900) as r:
                r.raise_for_status()
                with tmp.open("wb") as f:
                    async for chunk in r.aiter_bytes(1 << 20):
                        f.write(chunk)
            tmp.rename(zip_path)
        import asyncio

        df = await asyncio.to_thread(compute_exposure, stations, zip_path)
    except Exception as e:
        # Not written to disk, so the next ingest retries; features default missing exposure to 1.0.
        log.warning("CFRAM exposure unavailable (%s); using exposure = 1.0 for all stations", e)
        record_health("CFRAM", False, f"fallback exposure=1.0: {e}")
        return pl.DataFrame({"id": stations["id"], "exposure": [1.0] * stations.height})
    df.write_parquet(out)
    record_health("CFRAM", True, f"{df.height} stations, 10-year extent within 5 km")
    return df


# Approximate county town coordinates: fallback when boundaries can't be fetched.
COUNTY_TOWNS = {
    "Carlow": (52.84, -6.93), "Cavan": (53.99, -7.36), "Clare": (52.84, -8.98), "Cork": (51.90, -8.47),
    "Donegal": (54.95, -7.73), "Dublin": (53.35, -6.26), "Galway": (53.27, -9.05), "Kerry": (52.27, -9.70),
    "Kildare": (53.16, -6.91), "Kilkenny": (52.65, -7.25), "Laois": (53.03, -7.30), "Leitrim": (54.00, -8.07),
    "Limerick": (52.66, -8.63), "Longford": (53.73, -7.80), "Louth": (53.95, -6.54), "Mayo": (53.86, -9.30),
    "Meath": (53.65, -6.68), "Monaghan": (54.25, -6.97), "Offaly": (53.27, -7.49), "Roscommon": (53.63, -8.19),
    "Sligo": (54.27, -8.47), "Tipperary": (52.47, -7.85), "Waterford": (52.26, -7.11), "Westmeath": (53.53, -7.34),
    "Wexford": (52.34, -6.46), "Wicklow": (52.98, -6.04),
}


def _nearest_town(lat: float, lon: float) -> str:
    import math

    def d(t):
        a, o = COUNTY_TOWNS[t]
        return (a - lat) ** 2 + ((o - lon) * math.cos(math.radians(lat))) ** 2

    return min(COUNTY_TOWNS, key=d)


def _county_name(raw: str) -> str:
    name = raw.replace("County ", "").strip()
    for town in COUNTY_TOWNS:  # 'Dún Laoghaire–Rathdown', 'Fingal', 'South Dublin' -> Dublin etc.
        if town.lower() in name.lower():
            return town
    if name in ("Fingal", "South Dublin", "Dún Laoghaire–Rathdown", "Dun Laoghaire-Rathdown"):
        return "Dublin"
    return name


async def assign_counties(c, stations: pl.DataFrame) -> pl.DataFrame:
    """Point-in-polygon against Natural Earth admin-1 (Irish counties); nearest county town fallback."""
    cache = paths().raw / "counties_ie.geojson"
    try:
        import geopandas as gpd

        if not cache.exists():
            r = await c.get(URLS["counties"], timeout=300)
            r.raise_for_status()
            js = r.json()
            feats = [f for f in js["features"] if f["properties"].get("iso_a2") == "IE"]
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(
                json.dumps(
                    {
                        "type": "FeatureCollection",
                        "features": [
                            {"type": "Feature", "properties": {"name": f["properties"]["name"]}, "geometry": f["geometry"]}
                            for f in feats
                        ],
                    }
                )
            )
        counties = gpd.read_file(cache).to_crs(ITM)
        pts = gpd.GeoDataFrame(
            {"id": stations["id"].to_list()},
            geometry=gpd.points_from_xy(stations["lon"].to_list(), stations["lat"].to_list()),
            crs="EPSG:4326",
        ).to_crs(ITM)
        j = gpd.sjoin_nearest(pts, counties[["name", "geometry"]], how="left", max_distance=5000)
        j = j[~j.index.duplicated()]
        names = [
            _county_name(n) if isinstance(n, str) else _nearest_town(la, lo)
            for n, la, lo in zip(j["name"], stations["lat"], stations["lon"])
        ]
    except Exception as e:
        log.warning("County boundaries unavailable (%s); using nearest county town", e)
        names = [_nearest_town(a, o) for a, o in zip(stations["lat"], stations["lon"])]
    return stations.with_columns(pl.Series("county", names))
