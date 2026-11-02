#!/usr/bin/env python3
"""Jev skill picker: points at the one skill that should handle a request. It never runs a skill.

Usage:
  skill_picker.py pick "<request>"           # real use; respects the on/off switch; counted
  skill_picker.py pick --try "<request>"     # try it any time, ignores the switch, not counted
  skill_picker.py on | off | status

Output of `pick` is one JSON line, within ~3 s, and never raises:
  {"use": "jev", "skill": "<key>", "load_as": "...", "sure": 0.93, ...}
  {"use": "jev", "skill": null, ...}                   # Jev says none of these fit
  {"use": "self", "reason": "..."}                     # Jev unsure, off, or any error
"""
import json
import os
import pathlib
import sys
import time
import urllib.request

URL = "https://openrouter.ai/api/alpha/decisions"
JEV_MODEL = "typesafe/jev-1.13"
TIMEOUT_S = 3.0           # total budget for all Jev rounds
SURE = 0.60               # below this, Claude picks the normal way
GROUP_SIZE = int(os.environ.get("JEV_GROUP_SIZE", "120"))  # options per question before splitting
NONE_KEY = "none_of_these"

CONF_DIR = pathlib.Path(os.environ.get("JEV_DIR", pathlib.Path.home() / ".config" / "jev"))
KEY_FILE = CONF_DIR / "openrouter_key"
SKILLS_FILE = CONF_DIR / "skills.json"
STATE_FILE = CONF_DIR / "picker_state.json"

DEFAULT_STATE = {"enabled": False, "picks": 0, "none": 0, "self": 0, "jev_cost_usd": 0.0}


def load_state() -> dict:
    try:
        return {**DEFAULT_STATE, **json.loads(STATE_FILE.read_text())}
    except Exception:
        return dict(DEFAULT_STATE)


def save_state(state: dict) -> None:
    try:
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2))
        tmp.replace(STATE_FILE)
    except Exception:
        pass


def key() -> str:
    k = os.environ.get("OPENROUTER_API_KEY", "")
    return k or (KEY_FILE.read_text().strip() if KEY_FILE.exists() else "")


def ask(request: str, options: dict, deadline: float) -> tuple[str, float, float]:
    """One Choice question over `options` plus a none option. Returns (choice, prob, cost)."""
    criteria = {k: v for k, v in options.items()}
    criteria[NONE_KEY] = "None of these skills fits; the request can be handled without any of them."
    payload = {
        "model": JEV_MODEL,
        "state": {"request": request},
        "questions": {
            "skill": {
                "type": "choice",
                "instructions": (
                    "Which one skill (saved instructions for an AI assistant) should handle `request`? "
                    "Pick the skill whose purpose matches what the request actually asks to be done. "
                    "If no skill clearly fits, pick none_of_these."
                ),
                "criteria": criteria,
            }
        },
    }
    remaining = deadline - time.perf_counter()
    if remaining <= 0.05:
        raise TimeoutError("time budget used up")
    req = urllib.request.Request(
        URL, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {key()}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=remaining) as resp:
        body = json.loads(resp.read())
    ans = body["answers"]["skill"]
    return ans["choice"], float(ans["probabilities"][ans["choice"]]), float(body.get("usage", {}).get("cost", 0.0))


def pick(request: str, try_mode: bool) -> dict:
    state = load_state()
    if not try_mode and not state["enabled"]:
        return {"use": "self", "reason": "picker off"}
    start = time.perf_counter()
    deadline = start + TIMEOUT_S
    try:
        if not key():
            raise RuntimeError("no API key")
        skills = json.loads(SKILLS_FILE.read_text())["skills"]
        lines = {k: v["line"] for k, v in skills.items()}
        keys = list(lines)
        cost, rounds = 0.0, 1

        if len(keys) <= GROUP_SIZE:
            choice, sure, c = ask(request, lines, deadline)
            cost += c
        else:
            # Groups run in parallel; winners (excluding "none") go to a final round.
            from concurrent.futures import ThreadPoolExecutor
            groups = [keys[i:i + GROUP_SIZE] for i in range(0, len(keys), GROUP_SIZE)]
            with ThreadPoolExecutor(len(groups)) as pool:
                results = list(pool.map(lambda g: ask(request, {k: lines[k] for k in g}, deadline), groups))
            cost += sum(r[2] for r in results)
            winners = [r[0] for r in results if r[0] != NONE_KEY]
            rounds = 2
            if not winners:
                choice, sure = NONE_KEY, min(r[1] for r in results)
            else:
                choice, sure, c = ask(request, {k: lines[k] for k in winners}, deadline)
                cost += c
    except Exception as e:
        result = {"use": "self", "reason": f"fallback: {type(e).__name__}: {getattr(e, 'reason', e)}"}
        if not try_mode:
            state["self"] += 1
            save_state(state)
        return result | {"latency_s": round(time.perf_counter() - start, 3)}

    latency = round(time.perf_counter() - start, 3)
    base = {"sure": round(sure, 3), "rounds": rounds, "jev_cost_usd": round(cost, 9), "latency_s": latency}
    if sure < SURE:
        result, bucket = {"use": "self", "reason": f"Jev only {sure:.0%} sure", "jev_guess": choice} | base, "self"
    elif choice == NONE_KEY:
        result, bucket = {"use": "jev", "skill": None} | base, "none"
    else:
        result, bucket = {"use": "jev", "skill": choice, "load_as": skills[choice]["load_as"]} | base, "picks"

    if not try_mode:
        state[bucket] += 1
        state["jev_cost_usd"] = round(state["jev_cost_usd"] + cost, 9)
        save_state(state)
    return result


def main(argv: list[str]) -> None:
    cmd = argv[0] if argv else ""
    if cmd in ("on", "off"):
        s = load_state(); s["enabled"] = cmd == "on"; save_state(s)
        print(f"Skill picker {cmd.upper()}")
    elif cmd == "status":
        s = load_state()
        print(f"Skill picker: {'ON' if s['enabled'] else 'OFF'}\n"
              f"  Jev picked a skill: {s['picks']}\n  Jev said none fit: {s['none']}\n"
              f"  Claude picked (Jev unsure or error): {s['self']}\n  Jev cost so far: ${s['jev_cost_usd']:.6f}")
    elif cmd == "pick":
        try_mode = "--try" in argv
        print(json.dumps(pick(" ".join(a for a in argv[1:] if a != "--try"), try_mode)))
    else:
        print(__doc__)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as e:
        print(json.dumps({"use": "self", "reason": f"fallback: {type(e).__name__}"}))
