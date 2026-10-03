"""Ask Floodline: tool behaviour and the agent loop, with a scripted stand-in for the LLM."""

from __future__ import annotations

import json

from floodline import agent


def _scripted(*steps):
    """Chat function that replays assistant messages and records what it was sent."""
    seen: list[list[dict]] = []
    it = iter(steps)

    async def chat(messages):
        seen.append([dict(m) for m in messages])
        yield next(it)

    return chat, seen


def _call(name, **args):
    return {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": name, "arguments": args}}]}


def test_search_docs_finds_decision_layer():
    r = agent.search_docs("how is the sandbag fill deadline calculated")
    assert r["results"] and r["results"][0]["section"] == "Decision layer"


def test_ask_runs_tools_and_answers(client, monkeypatch):
    chat, seen = _scripted(
        _call("river_risk", county="Kilkenny", limit=5),
        _call("station_detail", station="alpha"),
        {"role": "assistant", "content": "<think>x</think>Alpha Bridge is the gauge to watch."},
    )
    monkeypatch.setattr(agent, "ollama_chat", chat)
    r = client.post("/ask", json={"question": "Anything in Kilkenny?", "history": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]})
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "Alpha Bridge is the gauge to watch."
    assert [t["tool"] for t in body["tools_used"]] == ["river_risk", "station_detail"]
    final = seen[-1]
    assert [m["role"] for m in final[:4]] == ["system", "user", "assistant", "user"]
    risk = json.loads(next(m for m in final if m.get("tool_name") == "river_risk")["content"])
    assert risk["gauges_matched"] == 1 and risk["gauges"][0]["name"] == "Alpha Bridge"
    detail = json.loads(next(m for m in final if m.get("tool_name") == "station_detail")["content"])
    assert detail["id"] == "00001" and len(detail["top_factors_24h"]) == 5


def test_ask_status_and_unknown_tool(client, monkeypatch):
    chat, seen = _scripted(_call("system_status"), _call("nope"), {"role": "assistant", "content": "ok"})
    monkeypatch.setattr(agent, "ollama_chat", chat)
    assert client.post("/ask", json={"question": "Is the data fresh?"}).json()["answer"] == "ok"
    tools = [m for m in seen[-1] if m["role"] == "tool"]
    status = json.loads(tools[0]["content"])
    assert status["stations_loaded"] == 3 and "24h" in status["model_test_accuracy_jan_feb_2026"]
    assert "unknown tool" in tools[1]["content"]


def test_ask_demo_mode(client, monkeypatch):
    chat, seen = _scripted(_call("alerts", min_level="WATCH"), {"role": "assistant", "content": "done"})
    monkeypatch.setattr(agent, "ollama_chat", chat)
    r = client.post("/ask", json={"question": "What was happening?", "at": "2026-01-27T00:00:00Z"})
    assert r.status_code == 200
    assert "REPLAY at 2026-01-27" in seen[0][0]["content"]


def test_ask_validation_and_unavailable(client, monkeypatch):
    assert client.post("/ask", json={"question": "  "}).status_code == 422

    async def down(messages):
        raise agent.AgentUnavailable("Cannot reach Ollama")
        yield {}

    monkeypatch.setattr(agent, "ollama_chat", down)
    for stream in (False, True):
        r = client.post("/ask", json={"question": "hi", "stream": stream})
        assert r.status_code == 503 and "Ollama" in r.json()["detail"]


def test_ask_streams_events(client, monkeypatch):
    async def chat(messages):
        if messages[-1]["role"] == "user":  # first step: preamble text, then a tool call
            yield {"content": "Let me check. "}
            yield {"tool_calls": [{"function": {"name": "alerts", "arguments": {}}}]}
        else:
            for w in ("Two ", "alerts."):
                yield {"content": w}

    monkeypatch.setattr(agent, "ollama_chat", chat)
    r = client.post("/ask", json={"question": "Alerts?", "stream": True})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    events = [json.loads(line) for line in r.text.splitlines()]
    assert [e["type"] for e in events] == ["tool", "delta", "delta", "done"]
    assert "".join(e["text"] for e in events[1:3]) == "Two alerts."
    assert events[-1]["tools_used"] == [{"tool": "alerts", "args": {}}]


def test_ask_nudges_model_to_use_tools(client, monkeypatch):
    chat, seen = _scripted(
        {"role": "assistant", "content": "From general knowledge: Cork."},
        _call("search_docs", query="Storm Chandra"),
        {"role": "assistant", "content": "Wicklow, Wexford and Carlow."},
    )
    monkeypatch.setattr(agent, "ollama_chat", chat)
    r = client.post("/ask", json={"question": "Where was worst hit?", "stream": True})
    events = [json.loads(line) for line in r.text.splitlines()]
    assert [e["type"] for e in events] == ["tool", "delta", "done"]
    assert events[1]["text"] == "Wicklow, Wexford and Carlow."
    assert "tools first" in seen[1][-1]["content"]


def test_ask_accepts_answer_after_one_nudge(client, monkeypatch):
    chat, _ = _scripted({"role": "assistant", "content": "Hello"}, {"role": "assistant", "content": "Hello!"})
    monkeypatch.setattr(agent, "ollama_chat", chat)
    body = client.post("/ask", json={"question": "hi"}).json()
    assert body["answer"] == "Hello!" and body["tools_used"] == []
