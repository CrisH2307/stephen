# Verify 3: review #3 fixes on main @ 5287a20

The repo was built with `npm run build` and nothing under it was edited (`git status` is clean). The only probe adaptations were: the desktop probes' expectations now encode the OLD behaviour, so a "failure" there means the issue is fixed; and the voice probe gained cooldown cases. New regression probe: `regress.probe.ts`. Outputs: `desktop-probe.v2.out`, `voice-probe.v2.out`.

The real `claude` was run only against a dead `ANTHROPIC_BASE_URL` with a dummy key and a throw-away HOME. `grep sk-ant-dummy` over both fake HOMEs found nothing, so the key was not written to disk.

## Findings

| # | Status | Evidence |
|---|---|---|
| 1 | FIXED | The new argv has no `--resume`. Voice probe "after reply": `['open youtube resume=-']`. The cooldown cases show `resume=false` on every run. A fresh server still has no taint (probe 4b is unchanged), but it now always pairs with a fresh conversation. |
| 2 | FIXED | The argv now includes `--tools "" --permission-mode dontAsk --setting-sources ""`. The real claude reports `TOOLS []` and `permissionMode dontAsk`, including with user settings `{"defaultMode":"acceptEdits","allow":["SendMessage"]}`. |
| 3 | PARTIAL (documented) | The 20 s cooldown works: with a 5 s gap the second wake is `ignored: 1`, and Claude runs once. With gaps of 19 s, 21 s and 30 s (wake heard after about 20 s), "open terminal" runs. The tools still refuse it, and STEPHEN.md and VOICE.md now say the cooldown doesn't stop a video that talks later. |
| 4 | FIXED | In agent mode, `asked 1` for both Chrome and Zen. R6: declined or no approval channel → nothing opens. R7: when the agent browser is attached, the tab path is used with no extra prompt. |
| 5 | PARTIAL | Known redirectors now ask (`google.com/url?q=` → `asked 1`), as do http(s) URLs embedded in a query, fragment or path, including double-encoded ones. Still opened with no prompt: an attacker-owned site's own 302 (`https://evil.example/go`), a protocol-relative target (`?u=//chase.com/`, R5: `asked 0`) and a bare-host target (`?u=chase.com`). DESKTOP.md does not mention this limit. |
| 6 | PARTIAL (documented) | `~/Applications` spoof → `asked 1`, and the launch is `open -a <realPath>`. A symlink from `/Applications` to `~` → asks (R2). Not fixed: a spoof planted in `/Applications`, which the admin group can write to, opens with no prompt when `codesign --verify` passes: R1 gives `asked 0`, argv `["-a","/Applications/Spotify Helper.app"]`. An ad-hoc signature passes; checking the signing Team ID is left for phase 2 (DESKTOP.md:34). This was simulated with the fake codesign; I have not checked it on a real Mac. |
| 7 | FIXED | Script Debugger, Python Launcher, Hammerspoon, Keyboard Maestro, Raycast, Alfred, Docker, UTM, Termius, Wave, ChatGPT, Codex, GitHub Desktop, Console and the others are now denied. A generic Platypus-made app (`org.platypus.*`) still asks, which is acceptable. |
| 8 | FIXED | The app name now appears only inside `<untrusted_web_content source="desktop">`. Results refer to the app by bundle id. |
| 9 | FIXED | `mcpperm.mjs`: a pre-existing dir and file become `700`/`600`, and a planted symlink target stays `orig`. VOICE.md shows `--confirm dialog`. STEPHEN.md says the wake word cancels a run while Claude is working. |

## Regression checks (new code)

- **Cooldown.** It is counted in audio time and starts only after a command that reached Claude. The stop phrase is unaffected. Enter re-arms it (rearm probe: two runs). No regression found.
- **`open -a <path>`.** The path is always absolute, so a file named `-a Weird.app` is passed as `/Applications/-a Weird.app` and can't be read as an option. The launch uses `realPath`, which is the bundle the policy checked. No regression found. The one gap is the `/Applications` residual in #6.
- **Redirector rule.** No false positive on `youtube.com/watch?v=`. The gaps are listed under #5. Suggested fix: also flag `//host` values and values that look like a bare host. Better still: on the unattached path, ask for any host that isn't on an allow-list, or open via the attached browser so the landing check runs.
- **Agent-mode prompt.** Declined or no-channel answers fail closed. Attached agent mode is not prompted. No regression found.
