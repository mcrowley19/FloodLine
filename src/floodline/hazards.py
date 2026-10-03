"""`floodline hazards-build`: static susceptibility layers on a 10 km national grid.

Every layer is rasterised onto one Irish Transverse Mercator (EPSG:2157) grid and summarised
per 10 km assessment cell as "fraction of the cell covered":

- Soil drainage (EPA/Teagasc National Soils Hydrology Map, 250 m): rendered server-side by
  EPA's GeoServer in 60 km tiles with a style that encodes each drainage class as a pixel
  value, because the 490k-polygon vector layer is too large to download per build.
- OPW flood extents (50 m): CFRAM fluvial 10-year, NIFM fluvial 100-year (covers small
  ungauged rivers), national coastal 10-year.
- GSI (50 m): groundwater flood probability (high / medium / low), historic groundwater
  flooding, and observed 2015/16 surface-water ponding.

Outputs (data/hazards/): cells.parquet + cells.geojson (assessment grid with fractions and a
surface-water susceptibility score), groundwater_zones.parquet (GSI probability zones as points;
the polygons are drawn from GSI's WMS), coastal_stations.parquet (Marine Institute surge
points with tide thresholds and nearby coastal flood extent).

Every layer is optional: a failed download leaves its fractions at 0 and is logged.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import zipfile
from pathlib import Path

import httpx
import numpy as np
import polars as pl

from . import http
from .config import URLS, paths, record_health

log = logging.getLogger("floodline.hazards")

ITM = "EPSG:2157"
X0, Y0, X1, Y1 = 410_000, 500_000, 770_000, 970_000  # ITM extent of the Republic of Ireland
CELL_M = 10_000
FINE_M = 50
SOIL_M = 250
SOIL_TILE_M = 60_000

SOIL_CLASSES = {"Well": 10, "Imperfect": 20, "Poor": 30, "Very Poor": 40, "Peat": 50, "Alluvium": 60, "Made": 70, "Water": 80}

# (zip url key, zip filename, member name fragment) -> output fraction column
VECTOR_LAYERS = {
    "cfram_fluvial10_frac": ("cfram", "cfram.zip", "esds_floodmap_ext_f_c_0010.shp"),
    "nifm_fluvial100_frac": ("nifm", "nifm_ext_f_c.zip", "nifm_ext_f_c_0100.shp"),
    "coastal10_frac": ("coastal_extents", "ncfhm_ext_c_c_a.zip", "ncfhm_itm_ext_c_c_0010.shp"),
    "gw_high_frac": ("gsi_gw_probability", "IE_GSI_Groundwater_Flood_Probability_Maps_20k_IE26_ITM.zip", "High_Probability"),
    "gw_medium_frac": ("gsi_gw_probability", "IE_GSI_Groundwater_Flood_Probability_Maps_20k_IE26_ITM.zip", "Medium_Probability"),
    "gw_low_frac": ("gsi_gw_probability", "IE_GSI_Groundwater_Flood_Probability_Maps_20k_IE26_ITM.zip", "Low_Probability"),
    "gw_historic_frac": ("gsi_historic", "IE_GSI_Historic_Flooding_Data_20k_IE26_ITM.zip", "Historic_Groundwater_Flood_Map"),
    "sw_2015_16_frac": ("gsi_historic", "IE_GSI_Historic_Flooding_Data_20k_IE26_ITM.zip", "2015_2016_Surface_Water"),
}


def grid_shape(res: int) -> tuple[int, int]:
    return (Y1 - Y0) // res, (X1 - X0) // res  # rows, cols


def grid_transform(res: int):
    from rasterio.transform import from_origin

    return from_origin(X0, Y1, res, res)


def block_mean(a: np.ndarray, k: int) -> np.ndarray:
    r, c = a.shape[0] // k, a.shape[1] // k
    return a[: r * k, : c * k].reshape(r, k, c, k).mean(axis=(1, 3))


# ---------- downloads ----------


async def download(c: httpx.AsyncClient, url: str, dest: Path, min_bytes: int = 1_000_000) -> Path:
    if dest.exists() and dest.stat().st_size >= min_bytes:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    log.info("Downloading %s", url)
    async with c.stream("GET", url, timeout=1800) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            async for chunk in r.aiter_bytes(1 << 20):
                f.write(chunk)
    tmp.rename(dest)
    return dest


# ---------- soil drainage via EPA WMS ----------


def soil_sld() -> str:
    rules = "".join(
        f"<Rule><ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>SOILDRAINAGECLASS</ogc:PropertyName>"
        f"<ogc:Literal>{name}</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter><PolygonSymbolizer><Fill>"
        f'<CssParameter name="fill">#{code:02x}0000</CssParameter></Fill></PolygonSymbolizer></Rule>'
        for name, code in SOIL_CLASSES.items()
    )
    return (
        '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">'
        f"<NamedLayer><Name>EPA:SOILS_WETDRY</Name><UserStyle><FeatureTypeStyle>{rules}</FeatureTypeStyle></UserStyle></NamedLayer>"
        "</StyledLayerDescriptor>"
    )


def decode_soil_png(png: bytes) -> np.ndarray:
    """Red channel -> class code; anything else (white background, stray pixels) -> 0.
    Requires antialias:none, otherwise edge blends would round into the wrong class."""
    import warnings

    import rasterio
    from rasterio.errors import NotGeoreferencedWarning

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with rasterio.MemoryFile(png) as mf, mf.open() as src:
            red = src.read(1).astype(int)
    valid = np.isin(red, list(SOIL_CLASSES.values()))
    return np.where(valid, red, 0).astype(np.uint8)


async def fetch_soil_raster(c: httpx.AsyncClient) -> np.ndarray:
    rows, cols = grid_shape(SOIL_M)
    out = np.zeros((rows, cols), dtype=np.uint8)
    tile_px = SOIL_TILE_M // SOIL_M
    sld = soil_sld()
    sem = asyncio.Semaphore(4)
    failed = 0

    async def tile(tx: int, ty: int):
        nonlocal failed
        x0 = X0 + tx * SOIL_TILE_M
        ytop = Y1 - ty * SOIL_TILE_M
        params = {
            "service": "WMS", "version": "1.1.1", "request": "GetMap", "layers": "EPA:SOILS_WETDRY", "srs": ITM,
            "bbox": f"{x0},{ytop - SOIL_TILE_M},{x0 + SOIL_TILE_M},{ytop}", "width": tile_px, "height": tile_px,
            "format": "image/png", "bgcolor": "0xFFFFFF", "format_options": "antialias:none", "SLD_BODY": sld,
        }
        async with sem:
            for attempt in range(3):
                try:
                    r = await c.post(URLS["epa_wms"], data=params, timeout=120)
                    if r.headers.get("content-type", "").startswith("image/png"):
                        arr = decode_soil_png(r.content)
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(2 * (attempt + 1))
            else:
                failed += 1
                return
        r0, c0 = ty * tile_px, tx * tile_px
        h, w = min(tile_px, rows - r0), min(tile_px, cols - c0)
        out[r0 : r0 + h, c0 : c0 + w] = arr[:h, :w]

    nx = -(-(X1 - X0) // SOIL_TILE_M)
    ny = -(-(Y1 - Y0) // SOIL_TILE_M)
    await asyncio.gather(*(tile(tx, ty) for tx in range(nx) for ty in range(ny)))
    if failed:
        log.warning("Soil drainage: %d/%d tiles failed", failed, nx * ny)
    return out


# ---------- vector rasterisation ----------


def _member(zip_path: Path, fragment: str) -> str:
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".shp") and fragment.lower() in n.lower()]
    if not names:
        raise FileNotFoundError(f"{fragment} not in {zip_path.name}")
    return names[0]


def rasterize_layer(zip_path: Path, fragment: str, res: int = FINE_M, batch: int = 4000) -> np.ndarray:
    """Binary mask of a (possibly huge) zipped shapefile on the national grid, read in batches."""
    import pyogrio
    from rasterio.enums import MergeAlg
    from rasterio.features import rasterize

    src = f"/vsizip/{zip_path.resolve()}/{_member(zip_path, fragment)}"
    info = pyogrio.read_info(src)
    n = int(info["features"])
    mask = np.zeros(grid_shape(res), dtype=np.uint8)
    tr = grid_transform(res)
    for off in range(0, n, batch):
        df = pyogrio.read_dataframe(src, skip_features=off, max_features=batch, columns=[])
        if df.crs is not None and df.crs.to_epsg() != 2157:
            df = df.to_crs(ITM)
        geoms = [g for g in df.geometry if g is not None and not g.is_empty]
        if geoms:
            rasterize(((g, 1) for g in geoms), out=mask, transform=tr, merge_alg=MergeAlg.replace)
    return mask


# ---------- cells ----------


def susceptibility(df: pl.DataFrame) -> pl.DataFrame:
    """Surface-water susceptibility in [0, 1]: impeded drainage, observed ponding, flood-prone ground.

    Heuristic weights (not trained; there is no open record of surface-water flood events):
    - drainage (50%): share of land with poor / very poor drainage, peat, or made ground (urban),
      imperfect drainage counted at 60%;
    - observed ponding (25%): GSI 2015/16 surface-water flooding, saturating at 2% of the cell;
    - flood-prone ground (25%): alluvium + NIFM 100-year extent, saturating at 10% of the cell.
    """
    land = pl.max_horizontal(pl.col("land_frac"), pl.lit(1e-6))
    drain = (pl.col("poor_frac") + pl.col("very_poor_frac") + 0.6 * pl.col("imperfect_frac") + 0.8 * pl.col("peat_frac") + pl.col("made_frac")) / land
    ponding = (pl.col("sw_2015_16_frac") / 0.02).clip(0, 1)
    prone = ((pl.col("alluvium_frac") + pl.col("nifm_fluvial100_frac")) / 0.10).clip(0, 1)
    return df.with_columns(
        drain.clip(0, 1).alias("s_drainage"),
        ponding.alias("s_ponding"),
        prone.alias("s_flood_prone"),
    ).with_columns(
        (0.5 * pl.col("s_drainage") + 0.25 * pl.col("s_ponding") + 0.25 * pl.col("s_flood_prone")).round(3).alias("susceptibility"),
        (pl.col("made_frac") / pl.max_horizontal(pl.col("land_frac"), pl.lit(1e-6))).round(4).alias("urban_share"),
    )


def build_cells(soil: np.ndarray | None, fine: dict[str, np.ndarray]) -> pl.DataFrame:
    from pyproj import Transformer

    rows, cols = grid_shape(CELL_M)
    data: dict[str, np.ndarray] = {}
    if soil is not None and soil.any():
        k = CELL_M // SOIL_M
        for name, code in SOIL_CLASSES.items():
            data[f"{name.lower().replace(' ', '_')}_frac"] = block_mean((soil == code).astype(np.float32), k)
        data["land_frac"] = block_mean(((soil > 0) & (soil != SOIL_CLASSES["Water"])).astype(np.float32), k)
    for col, m in fine.items():
        data[col] = block_mean(m.astype(np.float32), CELL_M // FINE_M)
    for name in SOIL_CLASSES:
        data.setdefault(f"{name.lower().replace(' ', '_')}_frac", np.zeros((rows, cols), np.float32))
    for col in VECTOR_LAYERS:
        data.setdefault(col, np.zeros((rows, cols), np.float32))
    if "land_frac" not in data:  # no soil map: fall back to "every cell touching a flood layer is land"
        data["land_frac"] = np.ones((rows, cols), np.float32)

    rr, cc = np.meshgrid(np.arange(rows), np.arange(cols), indexing="ij")
    e = X0 + (cc + 0.5) * CELL_M
    n = Y1 - (rr + 0.5) * CELL_M
    lon, lat = Transformer.from_crs(ITM, "EPSG:4326", always_xy=True).transform(e.ravel(), n.ravel())
    df = pl.DataFrame(
        {
            "cell_id": [f"E{int(a) // 1000:03d}N{int(b) // 1000:03d}" for a, b in zip(e.ravel() - CELL_M / 2, n.ravel() - CELL_M / 2)],
            "e_itm": (e.ravel() - CELL_M / 2).astype(np.int64),
            "n_itm": (n.ravel() - CELL_M / 2).astype(np.int64),
            "lat": np.round(lat, 4),
            "lon": np.round(lon, 4),
            **{k: np.round(v.ravel(), 4) for k, v in data.items()},
        }
    )
    return susceptibility(df.filter(pl.col("land_frac") >= 0.05))


def cells_geojson(cells: pl.DataFrame) -> dict:
    from pyproj import Transformer

    t = Transformer.from_crs(ITM, "EPSG:4326", always_xy=True)
    feats = []
    for r in cells.iter_rows(named=True):
        x, y = r["e_itm"], r["n_itm"]
        ring = [t.transform(a, b) for a, b in ((x, y), (x + CELL_M, y), (x + CELL_M, y + CELL_M), (x, y + CELL_M), (x, y))]
        feats.append({"type": "Feature", "id": r["cell_id"], "properties": {"cell_id": r["cell_id"]}, "geometry": {"type": "Polygon", "coordinates": [[[round(a, 5), round(b, 5)] for a, b in ring]]}})
    return {"type": "FeatureCollection", "features": feats}


# ---------- groundwater polygons ----------


def groundwater_zones(zip_path: Path) -> pl.DataFrame:
    """GSI groundwater flood probability zones as points (id, class, area, representative point).

    Geometry is not redistributed: the GSI licence is CC BY-NC-ND and the full-resolution
    polygons are ~265 MB as GeoJSON. Frontends draw them from GSI's own WMS (see
    `GSI_WMS`) and join on location.
    """
    import geopandas as gpd

    rows = []
    for cls in ("High", "Medium", "Low"):
        df = gpd.read_file(f"/vsizip/{zip_path.resolve()}/{_member(zip_path, cls + '_Probability')}", engine="pyogrio")
        if df.crs is None:
            df = df.set_crs(ITM)
        pts = df.geometry.representative_point().to_crs("EPSG:4326")
        area = df.to_crs(ITM).geometry.area
        for i, (pt, a) in enumerate(zip(pts, area)):
            if pt is None or pt.is_empty:
                continue
            rows.append({"zone_id": f"gw-{cls.lower()}-{i}", "probability": cls.lower(), "area_ha": round(float(a) / 1e4, 2), "lat": round(pt.y, 5), "lon": round(pt.x, 5)})
    return pl.DataFrame(rows)


GSI_WMS = {
    "url": "https://gsi.geodata.gov.ie/server/services/Groundwater/IE_GSI_Groundwater_Historic_and_Probability_Flood_Maps_20K_IE26_ITM/MapServer/WMSServer",
    "layers": {"high": "1", "medium": "2", "low": "3", "historic": "7", "surface_water_2015_16": "6"},
    "attribution": "Geological Survey Ireland, CC BY-NC-ND 4.0",
}


# ---------- coastal stations ----------


async def coastal_stations(c: httpx.AsyncClient, coastal_mask: np.ndarray | None) -> pl.DataFrame:
    """Surge forecast points with tide thresholds (P95/P99 of predicted high water 2026-2028 at
    the nearest Marine Institute tide-prediction station) and coastal 10-year extent within 10 km."""
    base = URLS["erddap"]
    pts = pl.read_csv(io.StringIO((await http.get(c, f"{base}/imiSurgePrediction.csv?stationID,longitude,latitude&distinct()")).text), skip_rows_after_header=1)
    hl = pl.read_csv(
        io.StringIO((await http.get(c, f"{base}/IMI_TidePrediction_HighLow.csv?stationID,longitude,latitude,tide_time_category,Water_Level_ODMalin&tide_time_category=%22HIGH%22", timeout=300)).text),
        skip_rows_after_header=1,
    )
    thr = hl.group_by("stationID").agg(
        pl.col("longitude").first().alias("t_lon"),
        pl.col("latitude").first().alias("t_lat"),
        pl.col("Water_Level_ODMalin").quantile(0.95).alias("hw_p95"),
        pl.col("Water_Level_ODMalin").quantile(0.99).alias("hw_p99"),
        pl.col("Water_Level_ODMalin").max().alias("hw_max"),
    )
    from pyproj import Transformer

    to_itm = Transformer.from_crs("EPSG:4326", ITM, always_xy=True)
    rows = []
    for p in pts.iter_rows(named=True):
        d = ((thr["t_lat"] - p["latitude"]) ** 2 + ((thr["t_lon"] - p["longitude"]) * np.cos(np.radians(p["latitude"]))) ** 2).sqrt() * 111.0
        i = int(d.arg_min())
        near = thr.row(i, named=True)
        km = float(d[i])
        expo = None
        if coastal_mask is not None:
            x, y = to_itm.transform(p["longitude"], p["latitude"])
            r0, c0 = int((Y1 - y) // FINE_M), int((x - X0) // FINE_M)
            rad = 10_000 // FINE_M
            win = coastal_mask[max(r0 - rad, 0) : r0 + rad, max(c0 - rad, 0) : c0 + rad]
            expo = round(float(win.sum()) * FINE_M * FINE_M / 1e6, 3)
        rows.append(
            {
                "station_id": p["stationID"],
                "name": p["stationID"].replace("_", " "),
                "lat": float(p["latitude"]),
                "lon": float(p["longitude"]),
                "tide_station": near["stationID"] if km <= 40 else None,
                "tide_station_km": round(km, 1),
                "hw_p95": round(near["hw_p95"], 3) if km <= 40 else None,
                "hw_p99": round(near["hw_p99"], 3) if km <= 40 else None,
                "coastal10_km2_within_10km": expo,
            }
        )
    return pl.DataFrame(rows)


# ---------- stage ----------


async def build(force: bool = False) -> None:
    p = paths()
    out = p.hazards
    out.mkdir(parents=True, exist_ok=True)
    raw = p.raw
    async with http.client() as c:
        zips: dict[str, Path | None] = {}

        async def get_zip(key, fname):
            try:
                zips[fname] = await download(c, URLS[key], raw / fname)
            except Exception as e:
                log.warning("Download failed for %s: %s", fname, e)
                zips[fname] = None

        unique = {(k, f) for k, f, _ in VECTOR_LAYERS.values()}
        soil_task = asyncio.create_task(fetch_soil_raster(c))
        await asyncio.gather(*(get_zip(k, f) for k, f in unique))
        try:
            soil = await soil_task
            record_health("EPA soils", bool(soil.any()), f"{int((soil > 0).sum())} 250 m pixels classified")
        except Exception as e:
            log.warning("Soil drainage map unavailable: %s", e)
            record_health("EPA soils", False, str(e))
            soil = None

        fine: dict[str, np.ndarray] = {}
        for col, (_, fname, frag) in VECTOR_LAYERS.items():
            zp = zips.get(fname)
            if zp is None:
                continue
            try:
                fine[col] = await asyncio.to_thread(rasterize_layer, zp, frag)
                log.info("Rasterised %s: %.1f km2", col, fine[col].sum() * FINE_M * FINE_M / 1e6)
            except Exception as e:
                log.warning("Layer %s unavailable: %s", col, e)
        record_health("OPW NIFM / coastal extents", "nifm_fluvial100_frac" in fine and "coastal10_frac" in fine, ", ".join(k for k in fine if k in ("nifm_fluvial100_frac", "coastal10_frac")) or "none")
        record_health("GSI groundwater", "gw_high_frac" in fine, ", ".join(k for k in fine if k.startswith(("gw_", "sw_"))) or "none")

        cells = build_cells(soil, fine)
        cells = await _with_counties(c, cells)
        cells.write_parquet(out / "cells.parquet")
        (out / "cells.geojson").write_text(json.dumps(cells_geojson(cells)))
        log.info("Hazard grid: %d land cells of 10 km", cells.height)

        gsi_zip = zips.get(VECTOR_LAYERS["gw_high_frac"][1])
        if gsi_zip is not None:
            try:
                gw = await asyncio.to_thread(groundwater_zones, gsi_zip)
                gw.write_parquet(out / "groundwater_zones.parquet")
                log.info("Groundwater zones: %d GSI polygons", gw.height)
            except Exception as e:
                log.warning("Groundwater polygons unavailable: %s", e)
        try:
            cs = await coastal_stations(c, fine.get("coastal10_frac"))
            cs.write_parquet(out / "coastal_stations.parquet")
            record_health("Marine Institute tides", True, f"{cs.height} surge points, {cs['hw_p99'].is_not_null().sum()} with tide thresholds")
        except Exception as e:
            log.warning("Coastal station setup failed: %s", e)
            record_health("Marine Institute tides", False, str(e))
    (out / "_SUCCESS").write_text("ok")


async def _with_counties(c, cells: pl.DataFrame) -> pl.DataFrame:
    from . import geo

    tmp = cells.select(pl.col("cell_id").alias("id"), "lat", "lon")
    named = await geo.assign_counties(c, tmp)
    return cells.with_columns(named["county"])


def load_cells() -> pl.DataFrame | None:
    f = paths().hazards / "cells.parquet"
    return pl.read_parquet(f) if f.exists() else None
