"""Satellite layers: Copernicus EMS EMSR860, GFM live flood extent, Sentinel-2 WMS config.

All of these are observations (they confirm flooding, they don't forecast it) and are never
allowed to fail a build or a request.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import zipfile
from urllib.parse import urlencode
from datetime import datetime, timedelta, timezone

import httpx

from . import http
from .config import GFM_REFRESH_S, IRELAND_BBOX, URLS, paths, record_health, utcnow

log = logging.getLogger("floodline.satellite")

EMSR_CODE = "EMSR860"
# Vector layers that represent observed flooding (modelled / depth layers are skipped).
EMSR_LAYERS = ("observedEventA", "maximumFloodExtentA")
# GFM archives name these e.g. EU_..._ENSEMBLE_FLOOD_<time>_....tif / ENSEMBLE_OBSWATER_...
GFM_LAYER_KEYS = {"observed_flood_extent": ("ensemble_flood", "flood_extent", "floodextent", "observed_flood"), "observed_water": ("ensemble_obswater", "observed_water", "observedwater")}
MIN_POLY_HA = 0.5


def empty_fc(**props) -> dict:
    return {"type": "FeatureCollection", "features": [], "properties": props}


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


# ---------- EMSR860 ----------


async def build_emsr(c: httpx.AsyncClient, force: bool = False) -> dict:
    out = paths().emsr
    out.mkdir(parents=True, exist_ok=True)
    index = {"activation": EMSR_CODE, "aois": [], "skipped": [], "built_utc": utcnow().isoformat()}
    try:
        act = (await http.get(c, URLS["emsr_activation"].format(code=EMSR_CODE))).json()["results"][0]
        index["name"] = act.get("name")
        index["event_time"] = act.get("eventTime")
    except Exception as e:
        log.warning("EMSR860 activation metadata unavailable: %s", e)
        record_health("EMSR860", False, str(e))
        (out / "_index.json").write_text(json.dumps(index, indent=1))
        return index

    for aoi in act.get("aois", []):
        aoi_name = aoi["name"]
        slug = _slug(aoi_name.replace("County ", ""))
        features = []
        for prod in aoi.get("products", []):
            img = (prod.get("images") or [{}])[0]
            acq = img.get("acquisitionTime")
            tag = f"{prod.get('type')}_{'MONIT%02d' % prod['monitoringNumber'] if prod.get('monitoring') else 'PRODUCT'}"
            layers = [l for l in prod.get("layers", []) if any(k in l["name"] for k in EMSR_LAYERS) and l.get("json")]
            if not layers or not acq:
                reason = prod.get("version", {}).get("reason") or "no vector layers published"
                index["skipped"].append({"aoi": aoi_name, "product": tag, "reason": reason})
                log.info("EMSR860 %s %s skipped: %s", aoi_name, tag, reason)
                continue
            acq_utc = datetime.fromisoformat(acq).replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            for layer in layers:
                lname = next(k for k in EMSR_LAYERS if k in layer["name"])
                try:
                    r = await http.get(c, layer["json"], timeout=180)
                    r.raise_for_status()
                    fc = r.json()
                except Exception as e:
                    index["skipped"].append({"aoi": aoi_name, "product": f"{tag}/{lname}", "reason": str(e)})
                    log.warning("EMSR860 %s %s/%s unavailable: %s", aoi_name, tag, lname, e)
                    continue
                for f in fc.get("features", []):
                    f["properties"] = {
                        **(f.get("properties") or {}),
                        "aoi": aoi_name,
                        "product": f"{EMSR_CODE}_AOI{aoi['number']:02d}_{tag}_{lname}",
                        "layer": lname,
                        "sensor": img.get("sensorName"),
                        "acquisition_utc": acq_utc,
                    }
                    features.append(f)
        if features:
            (out / f"{slug}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}))
            index["aois"].append({"aoi": aoi_name, "file": f"{slug}.geojson", "features": len(features), "acquisitions": sorted({f["properties"]["acquisition_utc"] for f in features})})
    (out / "_index.json").write_text(json.dumps(index, indent=1))
    n = sum(a["features"] for a in index["aois"])
    record_health("EMSR860", n > 0, f"{n} polygons across {len(index['aois'])} AOI(s); {len(index['skipped'])} products skipped")
    return index


def load_emsr_features() -> list[dict]:
    feats = []
    for f in sorted(paths().emsr.glob("*.geojson")):
        try:
            feats.extend(json.loads(f.read_text()).get("features", []))
        except Exception as e:
            log.warning("Bad EMSR file %s: %s", f, e)
    return feats


def emsr_as_of(features: list[dict], at: datetime) -> dict:
    stamp = at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    sel = [f for f in features if f["properties"].get("acquisition_utc", "9999") <= stamp]
    return {
        "type": "FeatureCollection",
        "features": sel,
        "properties": {"at": stamp, "source": "Copernicus EMS Rapid Mapping EMSR860", "attribution": "© European Union, Copernicus Emergency Management Service"},
    }


# ---------- GFM ----------


class GfmUnavailable(RuntimeError):
    pass


def _gfm_meta_path():
    return paths().gfm.with_suffix(".meta.json")


def gfm_cached() -> tuple[dict, dict]:
    p = paths().gfm
    meta = json.loads(_gfm_meta_path().read_text()) if _gfm_meta_path().exists() else {}
    fc = json.loads(p.read_text()) if p.exists() else empty_fc()
    return fc, meta


def _write_gfm(fc: dict, meta: dict) -> None:
    p = paths().gfm
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(fc))
    _gfm_meta_path().write_text(json.dumps(meta, indent=1))


def polygonise_tif(data: bytes, layer: str) -> list[dict]:
    """Binary flood/water GeoTIFF -> WGS84 polygons, dropping polygons < 0.5 ha."""
    import geopandas as gpd
    import rasterio
    from rasterio.features import shapes
    from shapely.geometry import shape

    with rasterio.MemoryFile(data) as mf, mf.open() as src:
        band = src.read(1)
        mask = (band == 1)
        geoms = [shape(g) for g, v in shapes(band.astype("uint8"), mask=mask, transform=src.transform) if v == 1]
        crs = src.crs
    if not geoms:
        return []
    g = gpd.GeoSeries(geoms, crs=crs)
    merged = gpd.GeoSeries([g.union_all()], crs=crs).explode(index_parts=False)
    itm = merged.to_crs("EPSG:2157")
    keep = itm.area >= MIN_POLY_HA * 10_000
    out = merged[keep.values].to_crs("EPSG:4326")
    return [{"type": "Feature", "properties": {"layer": layer, "area_ha": round(float(a) / 10_000, 2)}, "geometry": json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"]} for geom, a in zip(out, itm[keep.values].area)]


async def fetch_gfm(c: httpx.AsyncClient) -> tuple[dict, dict]:
    user, pw = os.environ.get("GFM_USER"), os.environ.get("GFM_PASS")
    if not user or not pw:
        raise GfmUnavailable("GFM_USER / GFM_PASS not set (free account: https://portal.gfm.eodc.eu)")
    base = URLS["gfm_api"]
    r = await c.post(f"{base}/auth/login", json={"email": user, "password": pw}, timeout=60)
    if r.status_code != 200:
        raise GfmUnavailable(f"GFM login failed: HTTP {r.status_code}")
    tok = r.json()
    hdr = {"Authorization": f"Bearer {tok['access_token']}"}
    user_id = tok.get("client_id")

    aois = (await c.get(f"{base}/aoi/user/{user_id}", headers=hdr, timeout=60)).json().get("aois", [])
    aoi = next((a for a in aois if a.get("aoi_name") == "floodline-ireland"), None)
    if aoi is None:
        x0, y0, x1, y1 = IRELAND_BBOX
        body = {
            "aoi_name": "floodline-ireland",
            "description": "Floodline Ireland-wide bounding box",
            "user_id": user_id,
            "geoJSON": {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]},
        }
        cr = await c.post(f"{base}/aoi/create", json=body, headers=hdr, timeout=60)
        if cr.status_code not in (200, 201):
            raise GfmUnavailable(f"GFM AOI create failed: HTTP {cr.status_code} {cr.text[:200]}")
        aoi = cr.json()
    aoi_id = aoi["aoi_id"]

    now = utcnow()
    params = {"time": "range", "from": (now - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%S"), "to": now.strftime("%Y-%m-%dT%H:%M:%S")}
    prods = (await c.get(f"{base}/aoi/{aoi_id}/products", params=params, headers=hdr, timeout=120)).json().get("products", [])
    if not prods:
        return empty_fc(), {"observed_at": None, "status": "ok", "reason": "no Sentinel-1 acquisitions over Ireland in the last 10 days"}
    latest = max(prods, key=lambda p: p["product_time"])
    observed_at = latest["product_time"].replace(" ", "T")
    observed_at = observed_at if observed_at.endswith("Z") else observed_at + "Z"
    dl = (await c.get(f"{base}/download/product/{latest['product_id']}/{user_id}", headers=hdr, timeout=120)).json()
    link = dl.get("download_link")
    if not link:
        raise GfmUnavailable("GFM returned no download link")
    blob = (await c.get(link, timeout=600)).content
    features = await _features_from_gfm_blob(blob)
    for f in features:
        f["properties"]["observed_at"] = observed_at
    return {"type": "FeatureCollection", "features": features}, {"observed_at": observed_at, "status": "ok", "reason": None, "product_id": latest["product_id"]}


async def _features_from_gfm_blob(blob: bytes) -> list[dict]:
    import asyncio

    feats: list[dict] = []
    try:
        z = zipfile.ZipFile(io.BytesIO(blob))
        names = z.namelist()
    except zipfile.BadZipFile:
        js = json.loads(blob)
        return js.get("features", [])
    def layer_of(n: str) -> str | None:
        low = n.lower().replace("-", "_")
        return next((k for k, keys in GFM_LAYER_KEYS.items() if any(s in low for s in keys)), None)

    # GFM also ships an unfiltered GeoJSON of the flood raster; prefer the raster when both exist.
    tif_layers = {layer_of(n) for n in names if n.lower().endswith((".tif", ".tiff"))}
    for n in names:
        low = n.lower()
        layer = layer_of(n)
        if layer is None:
            continue
        if low.endswith((".tif", ".tiff")):
            feats.extend(await asyncio.to_thread(polygonise_tif, z.read(n), layer))
        elif low.endswith((".geojson", ".json")) and layer not in tif_layers:
            for f in json.loads(z.read(n)).get("features", []):
                f.setdefault("properties", {})["layer"] = layer
                feats.append(f)
    return feats


async def refresh_gfm(c: httpx.AsyncClient, force: bool = False) -> dict:
    _, meta = gfm_cached()
    fetched = meta.get("fetched_utc")
    if not force and fetched and (utcnow() - datetime.fromisoformat(fetched)).total_seconds() < GFM_REFRESH_S:
        return meta
    try:
        fc, meta = await fetch_gfm(c)
        record_health("GFM", True, f"{len(fc['features'])} polygons, observed {meta.get('observed_at')}")
    except Exception as e:
        reason = str(e) or type(e).__name__
        log.info("GFM unavailable: %s", reason)
        fc, meta = empty_fc(), {"observed_at": None, "status": "unavailable", "reason": reason}
        record_health("GFM", False, reason)
    meta["fetched_utc"] = utcnow().isoformat()
    _write_gfm(fc, meta)
    return meta


def gfm_clip(bbox: tuple[float, float, float, float] | None) -> dict:
    fc, meta = gfm_cached()
    feats = fc.get("features", [])
    if bbox and feats:
        from shapely import clip_by_rect
        from shapely.geometry import mapping, shape

        out = []
        for f in feats:
            g = clip_by_rect(shape(f["geometry"]), *bbox)
            if not g.is_empty:
                out.append({**f, "geometry": mapping(g)})
        feats = out
    return {
        "type": "FeatureCollection",
        "features": feats,
        "properties": {
            "observed_at": meta.get("observed_at"),
            "source": "Copernicus GFM / Sentinel-1",
            "status": meta.get("status", "unavailable"),
            "reason": meta.get("reason", "GFM has not been fetched yet (run `floodline satellite-build`)"),
            "attribution": "© European Union, Copernicus Emergency Management Service; contains modified Copernicus Sentinel data",
        },
    }


# ---------- Sentinel-2 WMS (config only, no imagery download) ----------


def wms_config() -> dict:
    instance = os.environ.get("CDSE_CLIENT_ID")
    if not instance:
        return {"available": False, "reason": "CDSE_CLIENT_ID not set (see README: Copernicus Data Space configuration instance ID)"}
    layer = os.environ.get("CDSE_WMS_LAYER", "TRUE_COLOR")
    maxcc = int(os.environ.get("CDSE_MAX_CLOUD", "30"))
    end = utcnow().date()
    url = URLS["cdse_wms"].format(instance=instance)
    params = {
        "SERVICE": "WMS",
        "REQUEST": "GetMap",
        "VERSION": "1.3.0",
        "LAYERS": layer,
        "FORMAT": "image/png",
        "TRANSPARENT": "true",
        "CRS": "EPSG:3857",
        "MAXCC": maxcc,
        "TIME": f"{end - timedelta(days=30)}/{end}",
        "WIDTH": 256,
        "HEIGHT": 256,
    }
    return {
        "available": True,
        "url": url,
        "layer": layer,
        "max_cloud_cover_param": "MAXCC",
        "params": params,
        # MapLibre substitutes {bbox-epsg-3857} per tile; appended raw so the braces aren't encoded.
        "tile_url_template": f"{url}?{urlencode(params)}&BBOX={{bbox-epsg-3857}}",
        "attribution": f"Contains modified Copernicus Sentinel data {end.year}",
    }


# ---------- stage ----------


async def build(force: bool = False) -> None:
    async with http.client() as c:
        idx = await build_emsr(c, force)
        log.info("EMSR860: %s", {a["aoi"]: a["features"] for a in idx["aois"]} or "no products")
        meta = await refresh_gfm(c, force=True)
        log.info("GFM: status=%s %s", meta.get("status"), meta.get("reason") or meta.get("observed_at"))
    record_health("CDSE WMS", wms_config()["available"], "config only" if wms_config()["available"] else "CDSE_CLIENT_ID not set")
