"""Ask Floodline: a question-answering agent over the live system, run on an open-weights
model (Qwen via Ollama by default).

The harness is deliberately small: the model gets a system prompt and a fixed set of
read-only tools, and the loop runs its tool calls against the in-memory state until it
answers (or hits MAX_STEPS). Every number in an answer should come from a tool result;
the model never sees the raw parquet files.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable

import httpx

from . import decision
from .config import utcnow
from .hazard_state import LEVEL_RANK, HazardState, combined_alerts
from .service import LiveState, public_risk

log = logging.getLogger("floodline.agent")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
MODEL = os.environ.get("FLOODLINE_LLM_MODEL", "qwen3:8b")
MAX_STEPS = 6
MAX_HISTORY = 8
DOCS = Path(__file__).resolve().parents[2] / "BACKEND.md"

SYSTEM = """You are Ask Floodline, the assistant inside Floodline, an Ireland-wide flood early-warning tool for county councils.

What Floodline does: for every OPW river gauge it predicts the probability that the level reaches the gauge's own 95th percentile (P95) within 6/24/48/120 hours (LightGBM models trained on 3 years of OPW levels and Open-Meteo rain, driven live by ~100 ECMWF IFS + AIFS ensemble members). A decision layer turns that into a status (FILL_NOW, PREPARE, WATCH, CLEAR), a predicted crossing time, a sandbag fill deadline and a bag count. It also screens surface water, groundwater and coastal flooding with rule-based indicators (levels CLEAR, WATCH, MODERATE, HIGH) and merges everything into one alert list.

Rules:
- Always call at least one tool before answering; never answer from general knowledge. Answer questions about current conditions, stations, counties, alerts and data freshness from tool results, and questions about methods, data sources, models, accuracy and limitations from search_docs. Never invent numbers, stations or times.
- If a tool says something is unavailable or not built, say so plainly.
- Be concise (under ~200 words): a short direct answer first, then the key figures. Summarise long lists rather than repeating every field. Use plain language for council staff; explain jargon (P95, ensemble, p*) briefly when you use it.
- Probabilities as percentages. Times are UTC; say so.
- Use above_p95_now / level_minus_p95_m to say whether a gauge is above P95; P95 is a statistical level (exceeded 5% of the time), not a flood level. For rain over 48 h: under 10 mm is light, 20-50 mm significant, over 50 mm heavy. Do not call rain heavy unless the numbers say so.
- No disclaimers or safety boilerplate; the app shows one already.
- For how-it-works questions, quote the formulas, thresholds and worked examples from search_docs exactly. Do not make up your own examples or redo the arithmetic.
- Plain text and simple markdown (bold, bullet lists) only: no LaTeX, no tables, no headings.
- Do not output your reasoning or tool syntax, only the answer."""


def _tool(name: str, description: str, props: dict | None = None, required: list[str] | None = None) -> dict:
    return {"type": "function", "function": {"name": name, "description": description,
                                             "parameters": {"type": "object", "properties": props or {}, "required": required or []}}}


_COUNTY = {"county": {"type": "string", "description": "Irish county name, e.g. Cork. Omit for all of Ireland."}}

TOOLS = [
    _tool("system_status", "Data freshness and health: stations loaded/scored, when levels, rain ensemble and risk were last updated, "
          "per-source health, and model test accuracy per horizon. Use for 'is the data up to date', 'how accurate', 'what sources'."),
    _tool("river_risk", "River gauges ranked by risk, with status, P(reach P95) at 6/24/48/120 h, current level vs P95, forecast 48 h rain, "
          "predicted crossing and sandbag fill deadline. Also returns counts per status.",
          {**_COUNTY, "status": {"type": "string", "enum": ["FILL_NOW", "PREPARE", "WATCH", "CLEAR"], "description": "Only gauges with this status."},
           "limit": {"type": "integer", "description": "Max gauges to return (default 8)."}}),
    _tool("station_detail", "Full detail for one river gauge: probabilities with rain-uncertainty band, decision inputs and lead time, "
          "last-72 h level summary, ensemble rain and the top 5 factors driving its 24 h prediction.",
          {"station": {"type": "string", "description": "Gauge name (or part of it) or 5-digit OPW id."}}, ["station"]),
    _tool("alerts", "Combined alert list across river, surface water, groundwater and coastal, most severe first, with counts per hazard type.",
          {**_COUNTY, "min_level": {"type": "string", "enum": ["WATCH", "MODERATE", "HIGH"], "description": "Lowest level to include (default WATCH)."},
           "limit": {"type": "integer", "description": "Max alerts to return (default 15)."}}),
    _tool("search_docs", "Search Floodline's technical documentation: how the models, features, labels, decision layer (sandbags, p*, lead time), "
          "surface water / groundwater / coastal screens, data sources, licences, accuracy and known limitations work.",
          {"query": {"type": "string", "description": "What to look up, e.g. 'how is the fill deadline calculated'."}}, ["query"]),
]


# ---------- tools ----------


def _vs_p95(r: dict) -> dict:
    """Spell out where the level sits: a small model misreads bare `pct_of_record` (e.g. as years of record)."""
    lv, p95 = r.get("level_now"), r.get("p95")
    if lv is None or p95 is None:
        return {}
    return {"above_p95_now": lv >= p95, "level_minus_p95_m": round(lv - p95, 3)}


def _sections() -> list[tuple[str, str]]:
    if not DOCS.exists():
        return []
    out, title, buf = [], "Overview", []
    for line in DOCS.read_text().splitlines():
        if line.startswith("## ") or line.startswith("### "):
            if buf:
                out.append((title, "\n".join(buf).strip()))
            title, buf = line.lstrip("# ").strip(), []
        else:
            buf.append(line)
    if buf:
        out.append((title, "\n".join(buf).strip()))
    return out


_STOP = set("the a an of to in is are how what why does do for and or on with by it this that be from at as which when where".split())


def search_docs(query: str, k: int = 2) -> dict:
    words = [w for w in re.findall(r"[a-z0-9]+", query.lower()) if w not in _STOP and len(w) > 1]
    scored = []
    for title, body in _sections():
        t, b = title.lower(), body.lower()
        s = sum(3 * t.count(w) + b.count(w) for w in words)
        if s:
            scored.append((s, title, body))
    scored.sort(key=lambda x: -x[0])
    if not scored:
        return {"results": [], "note": "No matching documentation section."}
    return {"results": [{"section": t, "text": b[:2800]} for _, t, b in scored[:k]]}


def _match_county(rows: list[dict], county: str | None) -> list[dict]:
    c = (county or "").lower().removeprefix("county ").removeprefix("co. ").strip()
    if c in ("", "all", "any", "ireland", "national", "nationwide", "none"):
        return rows
    return [r for r in rows if (r.get("county") or "").lower() == c]


@dataclass
class Context:
    """What the tools can see. In demo mode `river_rows` and the hazard rows are the replay snapshot."""

    live: LiveState
    hazards: HazardState
    data_status: Callable[[], dict]
    river_rows: list[dict]
    surface_rows: list[dict] = field(default_factory=list)
    groundwater_rows: list[dict] = field(default_factory=list)
    coastal_rows: list[dict] = field(default_factory=list)
    demo_at: str | None = None

    def system_status(self) -> dict:
        s = self.data_status()
        m = s.get("model_metrics") or {}
        acc = {f"{h}h": {k: v["test"][k] for k in ("precision", "recall", "auc_pr")} for h, v in (m.get("horizons") or {}).items()}
        return {
            **{k: v for k, v in s.items() if k not in ("model_metrics", "sources")},
            "sources": {k: {"ok": v.get("ok"), "detail": str(v.get("detail", ""))[:160], "checked_utc": v.get("checked_utc")} for k, v in s["sources"].items()},
            "model_test_accuracy_jan_feb_2026": acc,
            "model_trained_utc": m.get("trained_utc"),
        }

    def river_risk(self, county: str | None = None, status: str | None = None, limit: int = 8) -> dict:
        rows = _match_county(self.river_rows, county)
        counts = {k: 0 for k in ("FILL_NOW", "PREPARE", "WATCH", "CLEAR")}
        for r in rows:
            counts[r["status"]] += 1
        if status:
            rows = [r for r in rows if r["status"] == status.upper()]
        keep = ("id", "name", "status", "level_now", "p95", "p24", "p48", "p120", "rain48_p50", "pred_cross_utc", "fill_deadline_utc", "bags_needed")
        out = [{"county": r.get("county"), **{k: public_risk(r).get(k) for k in keep}, **_vs_p95(r), "hours_to_deadline": r.get("hours_remaining")} for r in rows[: max(1, min(int(limit or 8), 40))]]
        if not self.river_rows:
            return {"note": "No river predictions available (models not trained or live data not loaded yet)."}
        above = sum(1 for r in rows if _vs_p95(r).get("above_p95_now"))
        return {"gauges_matched": len(rows), "gauges_above_p95_now": above, "counts_by_status": counts, "gauges": out}

    def station_detail(self, station: str) -> dict:
        q = station.strip().lower()
        rows = self.river_rows
        hit = [r for r in rows if r["id"] == q.zfill(5)] if q.isdigit() else []
        hit = hit or [r for r in rows if r["name"].lower() == q] or [r for r in rows if q in r["name"].lower()]
        if not hit:
            return {"error": f"No gauge matching '{station}'.", "hint": "Try river_risk to list gauges."}
        if len(hit) > 5:
            return {"error": "Ambiguous", "candidates": [{"id": r["id"], "name": r["name"], "county": r.get("county")} for r in hit[:15]]}
        r = hit[0]
        risk = public_risk(r)
        pct = risk.pop("pct_of_record", None)
        out: dict[str, Any] = {"county": r.get("county"), **risk, **_vs_p95(r),
                               "level_percentile_in_own_record (%)": pct,
                               "decision": {"lead_time_h (hours needed to fill and place bags)": r.get("lead_time_h"),
                                            "action_threshold_p_star (fill when P(cross within lead time) >= this; set by cost ratio)": r.get("p_star"),
                                            "p_cross_within_lead_time": r.get("p_within_L"),
                                            "hours_to_fill_deadline (negative = passed)": r.get("hours_remaining")}}
        if len(hit) > 1:
            out["other_matches"] = [{"id": x["id"], "name": x["name"]} for x in hit[1:]]
        if self.demo_at is None:
            d = self.live.detail(r["id"])
            if d:
                hist = [p["level"] for p in d["history_72h"]]
                out["level_72h"] = {"min": min(hist), "max": max(hist), "first": hist[0], "last": hist[-1]} if hist else None
                out["ensemble_rain"] = d["ensemble"]
                out["prob_band_rain_p10_p90"] = d["uncertainty_rain_p10_p90"]
                out["decision_inputs"] = d["decision_inputs"]
                out["top_factors_24h"] = d["shap_top5_24h"]
            if self.live.predictor is not None:
                # Hourly values behind P95; a few weeks of summer data makes P95 a low-flow level.
                out["record_length_days"] = round(len(self.live.predictor.record_sorted(r["id"])) / 24)
        return out

    def alerts(self, county: str | None = None, min_level: str = "WATCH", limit: int = 15) -> dict:
        lv = (min_level or "WATCH").upper()
        lv = lv if lv in LEVEL_RANK else "WATCH"
        rows = _match_county(combined_alerts(self.river_rows, self.surface_rows, self.groundwater_rows, self.coastal_rows, lv), county)
        by_type: dict[str, dict] = {}
        for a in rows:
            by_type.setdefault(a["type"], {}).setdefault(a["level"], 0)
            by_type[a["type"]][a["level"]] += 1
        keep = ("type", "name", "county", "level", "headline", "time_utc")
        note = None
        if not self.hazards.available:
            note = "Surface-water, groundwater and coastal layers are not built; only river alerts are included."
        elif self.demo_at:
            note = "Replay: coastal surge has no archive for January 2026, so coastal alerts are absent."
        return {"total": len(rows), "counts_by_type": by_type, "alerts": [{k: a.get(k) for k in keep} for a in rows[: max(1, min(int(limit or 15), 40))]], "note": note}

    def search_docs(self, query: str) -> dict:
        return search_docs(query)

    def call(self, name: str, args: dict) -> Any:
        fn = {"system_status": self.system_status, "river_risk": self.river_risk, "station_detail": self.station_detail,
              "alerts": self.alerts, "search_docs": self.search_docs}.get(name)
        if fn is None:
            return {"error": f"unknown tool {name}"}
        try:
            return fn(**{k: v for k, v in (args or {}).items() if v not in (None, "")})
        except TypeError as e:
            return {"error": f"bad arguments for {name}: {e}"}


# ---------- loop ----------


class AgentUnavailable(RuntimeError):
    pass


# A chat function takes the message list and yields partial assistant messages:
# {"content": "<text delta>"} and/or {"tool_calls": [...]}.
ChatFn = Callable[[list[dict]], AsyncIterator[dict]]


async def ollama_chat(messages: list[dict]) -> AsyncIterator[dict]:
    """One streamed /api/chat round trip."""
    body = {"model": MODEL, "messages": messages, "tools": TOOLS, "stream": True, "think": False, "keep_alive": "30m",
            "options": {"temperature": 0.2, "num_ctx": 16384}}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=5.0)) as c:
            async with c.stream("POST", f"{OLLAMA_URL}/api/chat", json=body) as r:
                if r.status_code == 404:
                    raise AgentUnavailable(f"Model {MODEL} is not pulled. Run `ollama pull {MODEL}`.")
                if r.status_code >= 400:
                    raise AgentUnavailable(f"Ollama error {r.status_code}: {(await r.aread())[:300].decode(errors='replace')}")
                async for line in r.aiter_lines():
                    if line.strip():
                        chunk = json.loads(line)
                        if chunk.get("error"):
                            raise AgentUnavailable(f"Ollama error: {chunk['error']}")
                        yield chunk.get("message") or {}
    except httpx.TransportError as e:
        raise AgentUnavailable(f"Cannot reach Ollama at {OLLAMA_URL} ({e.__class__.__name__}). Start it with `ollama serve` and `ollama pull {MODEL}`.")


_THINK = re.compile(r"<think>.*?</think>", re.S)


async def ask_stream(question: str, ctx: Context, history: list[dict] | None = None, chat: ChatFn | None = None) -> AsyncIterator[dict]:
    """Run the agent, yielding events: {"type": "tool", tool, args} when a tool runs,
    {"type": "delta", text} as answer text arrives, and finally {"type": "done", tools_used, model}."""
    chat = chat or ollama_chat
    now = decision.iso(utcnow())
    where = f"The user is viewing the Storm Chandra REPLAY at {ctx.demo_at} UTC; river and hazard tools return that snapshot." if ctx.demo_at else f"Mode: live. Current time {now} UTC."
    messages: list[dict] = [{"role": "system", "content": f"{SYSTEM}\n\n{where}"}]
    for m in (history or [])[-MAX_HISTORY:]:
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            messages.append({"role": m["role"], "content": m["content"][:4000]})
    messages.append({"role": "user", "content": question})

    used: list[dict] = []
    nudged = False
    for step in range(MAX_STEPS + 1):
        if step == MAX_STEPS:  # out of steps: ask for a final answer from what it has
            messages.append({"role": "user", "content": "Answer now from the tool results above, without calling tools."})
        # Until a tool has run, hold text back: an answer with no lookup is likely ungrounded.
        stream_now, streamed = bool(used), False
        content, calls = "", []
        async for part in chat(messages):
            if part.get("tool_calls"):
                calls.extend(part["tool_calls"])
            text = part.get("content") or ""
            if text:
                content += text
                if stream_now and not calls:
                    streamed = True
                    yield {"type": "delta", "text": text}
        if not calls and not used and not nudged and step < MAX_STEPS:
            nudged = True
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": "Look this up with the tools first (search_docs for how things work, the data tools for current conditions), then answer."})
            continue
        if not calls or step == MAX_STEPS:
            if not streamed and content:
                yield {"type": "delta", "text": content}
            yield {"type": "done", "tools_used": used, "model": MODEL}
            return
        messages.append({"role": "assistant", "content": content, "tool_calls": calls})
        if streamed:
            yield {"type": "reset"}  # text emitted before a tool call was preamble, not the answer
        for tc in calls:
            fn = tc.get("function", {})
            name, args = fn.get("name", ""), fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            yield {"type": "tool", "tool": name, "args": args}
            result = ctx.call(name, args)
            used.append({"tool": name, "args": args})
            log.info("ask tool %s %s", name, args)
            messages.append({"role": "tool", "tool_name": name, "content": json.dumps(result, default=str, separators=(",", ":"))[:12000]})


async def ask(question: str, ctx: Context, history: list[dict] | None = None, chat: ChatFn | None = None) -> dict:
    """Non-streaming wrapper: the whole answer at once."""
    text, done = "", {}
    async for ev in ask_stream(question, ctx, history, chat):
        if ev["type"] == "delta":
            text += ev["text"]
        elif ev["type"] == "reset":
            text = ""
        elif ev["type"] == "done":
            done = ev
    return {"answer": _THINK.sub("", text).strip(), "tools_used": done.get("tools_used", []), "model": MODEL}
