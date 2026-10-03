"""Shared async HTTP helpers."""

from __future__ import annotations

import asyncio
import logging

import httpx

from .config import MAX_CONCURRENCY, USER_AGENT

log = logging.getLogger("floodline.http")


def client(timeout: float = 90.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(timeout, connect=20.0),
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        limits=httpx.Limits(max_connections=MAX_CONCURRENCY, max_keepalive_connections=MAX_CONCURRENCY),
    )


async def get(
    c: httpx.AsyncClient, url: str, *, params=None, retries: int = 3, backoff: float = 2.0, **kw
) -> httpx.Response:
    """GET with retry on network errors and 5xx. 4xx responses are returned to the caller."""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            r = await c.get(url, params=params, **kw)
            if r.status_code < 500:
                return r
            last = httpx.HTTPStatusError(f"{r.status_code} for {url}", request=r.request, response=r)
        except (httpx.TransportError, httpx.TimeoutException) as e:
            last = e
        await asyncio.sleep(backoff * (2**attempt))
    assert last is not None
    raise last
