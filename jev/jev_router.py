#!/usr/bin/env python3
"""Jev model router: sizes a message and says which helper model should do the work.

Usage:
  jev_router.py on | off | status
  jev_router.py route "<message>"          # real use; counted in status
  jev_router.py route --test "<message>"   # ignores the switch, not counted in status

Output of `route` is one JSON line. It NEVER raises and never blocks for more than
TIMEOUT_S: on any failure it returns {"route": "self", "reason": "fallback: ..."}.
"""
import json
import os
import pathlib
import socket
import sys
import time
import urllib.error
import urllib.request

URL = "https://openrouter.ai/api/alpha/decisions"
JEV_MODEL = "typesafe/jev-1.13"
TIMEOUT_S = 3.0
SURE_THRESHOLD = 0.60      # below this, Claude handles it itself
CONTEXT_REPLY_THRESHOLD = 0.5

CONF_DIR = pathlib.Path(os.environ.get("JEV_DIR", pathlib.Path.home() / ".config" / "jev"))
KEY_FILE = CONF_DIR / "openrouter_key"
STATE_FILE = CONF_DIR / "router_state.json"

# Smallest to biggest. Values are the Agent tool's `model` names available in this setup.
SIZES = {
    "tiny": "haiku",
    "everyday": "sonnet",
    "large": "opus",
    "hardest": "opus",  # Fable is off for now (owner, 2026-11-02); was "fable"
}

QUESTIONS = {
    "size": {
        "type": "choice",
        "instructions": (
            "What is the smallest AI model size that can do the job in `message` well? "
            "Judge the work the request needs, not how long the message is."
        ),
        "criteria": {
            "tiny": {
                "what": "A quick lookup, a rename, a conversion, or a one-line answer.",
                "examples": ["What's the capital of Peru?", "Rename this variable to user_count"],
            },
            "everyday": {
                "what": "A normal email, social post, short document, or a small explanation or code snippet.",
                "examples": ["Write a polite email declining a meeting", "Explain what a hash map is"],
            },
            "large": {
                "what": "A multi-step build, research across sources, or a full report.",
                "examples": ["Build a REST API with auth and tests", "Research and compare three vector databases"],
            },
            "hardest": {
                "what": "Strategy, high-stakes decisions, or anything where a wrong call is expensive.",
                "not_for": "Work that is long but routine.",
                "examples": ["Should we pivot the company to enterprise?", "Plan our response to a data breach"],
            },
        },
    },
    "context_reply": {
        "type": "noul",
        "instructions": (
            "Is `message` a short follow-up reply that only makes sense inside an ongoing "
            "conversation, because it refers to earlier messages without restating them?"
        ),
        "criteria": {
            "true": "It points back to something unstated, like 'yes do that but shorter' or 'try the second option'.",
            "false": "It is a self-contained request someone could act on without seeing earlier messages.",
        },
    },
}

DEFAULT_STATE = {
    "enabled": False,
    "counts": {**{s: 0 for s in SIZES}, "self_unsure": 0, "self_context": 0, "self_fallback": 0},
    "jev_calls": 0,
    "jev_cost_usd": 0.0,
}


def load_state() -> dict:
    try:
        state = json.loads(STATE_FILE.read_text())
        merged = json.loads(json.dumps(DEFAULT_STATE))
        merged.update({k: v for k, v in state.items() if k != "counts"})
        merged["counts"].update(state.get("counts", {}))
        return merged
    except Exception:
        return json.loads(json.dumps(DEFAULT_STATE))


def save_state(state: dict) -> None:
    try:
        CONF_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2))
        tmp.replace(STATE_FILE)
    except Exception:
        pass  # stats are best-effort; never block a message


def load_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key and KEY_FILE.exists():
        key = KEY_FILE.read_text().strip()
    return key


def ask_jev(message: str) -> dict:
    payload = {"model": JEV_MODEL, "questions": QUESTIONS, "state": {"message": message}}
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {load_key()}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read())


def route(message: str, test: bool) -> dict:
    state = load_state()
    if not test and not state["enabled"]:
        return {"route": "off"}

    start = time.perf_counter()
    try:
        if not load_key():
            raise RuntimeError("no API key")
        body = ask_jev(message)
        size_ans = body["answers"]["size"]
        size = size_ans["choice"]
        sure = float(size_ans["probabilities"][size])
        context_p = float(body["answers"]["context_reply"]["noul"])
        cost = float(body.get("usage", {}).get("cost", 0.0))
    except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
        result = {"route": "self", "reason": f"fallback: {type(e).__name__}: {getattr(e, 'reason', e)}"}
        if not test:
            state["counts"]["self_fallback"] += 1
            save_state(state)
        return result | {"latency_s": round(time.perf_counter() - start, 3)}
    except Exception as e:  # malformed response, missing key, anything else
        result = {"route": "self", "reason": f"fallback: {type(e).__name__}: {e}"}
        if not test:
            state["counts"]["self_fallback"] += 1
            save_state(state)
        return result | {"latency_s": round(time.perf_counter() - start, 3)}

    latency = round(time.perf_counter() - start, 3)
    base = {"size": size, "sure": round(sure, 3), "context_reply_p": round(context_p, 3),
            "jev_cost_usd": cost, "latency_s": latency}

    if context_p >= CONTEXT_REPLY_THRESHOLD:
        result, bucket = {"route": "self", "reason": "short reply that needs conversation context"} | base, "self_context"
    elif sure < SURE_THRESHOLD:
        result, bucket = {"route": "self", "reason": f"Jev only {sure:.0%} sure"} | base, "self_unsure"
    elif size not in SIZES:
        result, bucket = {"route": "self", "reason": f"unknown size {size!r}"} | base, "self_fallback"
    else:
        result, bucket = {"route": "helper", "model": SIZES[size]} | base, size

    if not test:
        state["counts"][bucket] += 1
        state["jev_calls"] += 1
        state["jev_cost_usd"] = round(state["jev_cost_usd"] + cost, 9)
        save_state(state)
    return result


def status() -> str:
    s = load_state()
    c = s["counts"]
    lines = [f"Router: {'ON' if s['enabled'] else 'OFF'}", ""]
    for size, model in SIZES.items():
        lines.append(f"  {size:<9} -> {model:<7} {c[size]:>5}")
    lines += [
        f"  handled by Claude (Jev unsure)     {c['self_unsure']:>5}",
        f"  handled by Claude (context reply)  {c['self_context']:>5}",
        f"  handled by Claude (fallback/error) {c['self_fallback']:>5}",
        "",
        f"Jev calls: {s['jev_calls']}   Jev cost so far: ${s['jev_cost_usd']:.6f}",
    ]
    return "\n".join(lines)


def main(argv: list[str]) -> None:
    if not argv:
        print(__doc__)
        return
    cmd = argv[0]
    if cmd in ("on", "off"):
        s = load_state()
        s["enabled"] = cmd == "on"
        save_state(s)
        print(f"Router {cmd.upper()}")
    elif cmd == "status":
        print(status())
    elif cmd == "route":
        test = "--test" in argv
        msg = " ".join(a for a in argv[1:] if a != "--test")
        print(json.dumps(route(msg, test)))
    else:
        print(__doc__)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as e:  # absolute last resort: never break the caller
        print(json.dumps({"route": "self", "reason": f"fallback: {type(e).__name__}"}))
