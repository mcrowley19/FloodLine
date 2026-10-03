"""OPW water level data: station list, Hydro-Data history, waterlevel.ie CSVs and live feed.

Datum note: Hydro-Data series are absolute (ordnance datum, e.g. Malin Head), while
waterlevel.ie CSVs and the live GeoJSON are staff-gauge levels. Everything Floodline stores
is staff-gauge level: history is shifted by the station's gauge datum (checked against the
5-week overlap with the waterlevel.ie month CSV).
"""

from __future__ import annotations

import asyncio
import io
import logging
import zipfile
from datetime import datetime, timedelta

import httpx
import polars as pl

from . import http
from .config import OPW_REF_MAX, OPW_REF_MIN, URLS

log = logging.getLogger("floodline.opw")

GOOD_QUALITY = (31, 254)  # 31 = checked/good, 254 = unchecked provisional; -1 = missing


def station_id(ref: str) -> str:
    """waterlevel.ie refs are 10 digits ('0000025017'); Hydro-Data and CSVs use 5."""
    return str(int(ref)).zfill(5)


async def fetch_station_list(c: httpx.AsyncClient) -> pl.DataFrame:
    """River/lake stations with a water-level sensor (0001), within the OPW republication range."""
    stations = (await http.get(c, URLS["stations"])).json()
    latest = (await http.get(c, URLS["latest"])).json()
    with_level = {
        f["properties"]["station_ref"] for f in latest["features"] if f["properties"].get("sensor_ref") == "0001"
    }
    meta: dict[str, dict] = {}
    try:
        for s in (await http.get(c, URLS["hydro_stations"])).json():
            meta[str(s["station_no"]).zfill(5)] = s
    except Exception as e:  # metadata is an enhancement only
        log.warning("Hydro-Data station metadata unavailable: %s", e)

    rows = []
    for f in stations["features"]:
        ref = f["properties"]["ref"]
        if ref not in with_level or not (OPW_REF_MIN <= int(ref) <= OPW_REF_MAX):
            continue
        sid = station_id(ref)
        m = meta.get(sid, {})
        otype = m.get("object_type", "")
        if otype and "Surface water" not in otype:
            continue  # climate-only stations etc.
        lon, lat = f["geometry"]["coordinates"][:2]
        datum = m.get("station_gauge_datum")
        rows.append(
            {
                "id": sid,
                "ref": ref,
                "name": f["properties"]["name"],
                "lat": float(lat),
                "lon": float(lon),
                "catchment": m.get("catchment_name") or None,
                "gauge_datum": float(datum) if datum not in (None, "") else None,
            }
        )
    df = pl.DataFrame(rows, schema_overrides={"gauge_datum": pl.Float64, "catchment": pl.Utf8})
    return df.unique("id", keep="first").sort("id")


def parse_hydro_zip(content: bytes, start: datetime) -> pl.DataFrame:
    """Parse a Hydro-Data Waterlevel_complete.zip (KISTERS tsvalues.csv) from `start` on."""
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        raw = z.read(name)
    header = raw.find(b"#Timestamp")
    body_start = raw.index(b"\n", header) + 1 if header >= 0 else 0
    # The file is chronological (decades of 15-min data); skip to the first day in the window.
    for d in range(0, 1100):
        pos = raw.find(b"\n" + (start + timedelta(days=d)).strftime("%Y-%m-%d").encode(), body_start)
        if pos >= 0:
            body_start = pos + 1
            break
    body = raw[body_start:]
    if not body.strip():
        return pl.DataFrame(schema={"time": pl.Datetime("us", "UTC"), "value": pl.Float64})
    df = pl.read_csv(
        body,
        separator=";",
        has_header=False,
        new_columns=["ts", "value", "quality"],
        schema_overrides={"ts": pl.Utf8, "value": pl.Float64, "quality": pl.Int64},
        ignore_errors=True,
        truncate_ragged_lines=True,
    )
    return (
        df.filter(pl.col("quality").is_in(GOOD_QUALITY) & pl.col("value").is_not_null())
        .with_columns(pl.col("ts").str.to_datetime("%Y-%m-%dT%H:%M:%S%.fZ", time_zone="UTC", strict=False).alias("time"))
        .filter(pl.col("time").is_not_null() & (pl.col("time") >= start))
        .select("time", "value")
    )


def parse_wl_csv(text: str) -> pl.DataFrame:
    """waterlevel.ie day/week/month CSV: 'datetime,value' rows, UTC, staff-gauge level."""
    if not text.strip().lower().startswith("datetime"):
        return pl.DataFrame(schema={"time": pl.Datetime("us", "UTC"), "value": pl.Float64})
    df = pl.read_csv(io.StringIO(text), schema_overrides={"datetime": pl.Utf8, "value": pl.Float64}, ignore_errors=True)
    return (
        df.with_columns(pl.col("datetime").str.to_datetime("%Y-%m-%d %H:%M", time_zone="UTC", strict=False).alias("time"))
        .filter(pl.col("time").is_not_null() & pl.col("value").is_not_null())
        .select("time", "value")
    )


def to_hourly(df: pl.DataFrame, col: str = "value") -> pl.DataFrame:
    """15-min -> hourly mean, labelled by the hour start."""
    return (
        df.with_columns(pl.col("time").dt.truncate("1h"))
        .group_by("time")
        .agg(pl.col(col).mean().alias("level"))
        .sort("time")
    )


def datum_offset(hist: pl.DataFrame, live: pl.DataFrame, gauge_datum: float | None) -> tuple[float, str]:
    """Offset to subtract from Hydro-Data values to get staff-gauge level."""
    if hist.height and live.height:
        j = hist.join(live, on="time", suffix="_live")
        if j.height >= 24:
            off = float((j["value"] - j["value_live"]).median())
            return off, "overlap"
    if gauge_datum is not None and hist.height:
        # Only trust the metadata datum if it lands the series in a plausible staff range.
        med = float(hist["value"].median()) - gauge_datum
        if -2.0 <= med <= 20.0:
            return gauge_datum, "gauge_datum"
    return 0.0, "none"


async def fetch_station_levels(
    c: httpx.AsyncClient, sid: str, gauge_datum: float | None, start: datetime
) -> tuple[pl.DataFrame, dict]:
    """Hourly staff-gauge level for one station from `start` to now, plus provenance."""
    live = pl.DataFrame(schema={"time": pl.Datetime("us", "UTC"), "value": pl.Float64})
    try:
        r = await http.get(c, URLS["wl_month"].format(id=sid))
        if r.status_code == 200:
            live = parse_wl_csv(r.text)
    except Exception as e:
        log.debug("month CSV %s failed: %s", sid, e)

    hist = None
    source, err = "hydro-data", ""
    try:
        r = await http.get(c, URLS["hydro_complete"].format(id=sid), timeout=240)
        if r.status_code == 200:
            hist = await asyncio.to_thread(parse_hydro_zip, r.content, start)
        else:
            err = f"HTTP {r.status_code}"
    except Exception as e:
        err = str(e) or type(e).__name__

    if hist is not None and hist.height:
        off, method = datum_offset(hist, live, gauge_datum)
        hist = hist.with_columns(pl.col("value") - off)
        merged = pl.concat([hist, live.filter(pl.col("time") > hist["time"].max())]) if live.height else hist
    else:
        source, off, method = "waterlevel.ie month CSV (fallback)", 0.0, "staff"
        merged = live
    hourly = to_hourly(merged)
    info = {
        "id": sid,
        "source": source,
        "offset": off,
        "offset_method": method,
        "hours": hourly.height,
        "error": err,
    }
    return hourly, info


async def fetch_latest(c: httpx.AsyncClient) -> pl.DataFrame:
    """Live reading per station (sensor 0001) from /geojson/latest/."""
    js = (await http.get(c, URLS["latest"])).json()
    rows = []
    for f in js["features"]:
        p = f["properties"]
        if p.get("sensor_ref") != "0001":
            continue
        try:
            rows.append(
                {
                    "id": station_id(p["station_ref"]),
                    "time": datetime.fromisoformat(p["datetime"].replace("Z", "+00:00")),
                    "value": float(p["value"]),
                    "err_code": p.get("err_code"),
                }
            )
        except (TypeError, ValueError):
            continue
    return pl.DataFrame(rows, schema={"id": pl.Utf8, "time": pl.Datetime("us", "UTC"), "value": pl.Float64, "err_code": pl.Int64})


async def fetch_recent_week(c: httpx.AsyncClient, sid: str) -> pl.DataFrame:
    r = await http.get(c, URLS["wl_week"].format(id=sid))
    return parse_wl_csv(r.text) if r.status_code == 200 else parse_wl_csv("")
