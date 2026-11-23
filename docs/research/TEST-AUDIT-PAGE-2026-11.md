# Test audit: `test/page`, 2026-11

Date: 2026-11-22. Base: `origin/qa` at `39cb0dc`. Lane: review. Status: **report only**.

This report audits the 172 tests in `test/page/` against four definitions of low value (duplicate coverage,
tests of constants, tests that only assert a mock, tests that keep dead code alive) plus tests that sleep
instead of waiting for an event. No test, source or helper file is changed. Every recommendation is for the
dev lane to accept or reject.

The folder was read at `9d07bd3`. `origin/qa` moved to `39cb0dc` while the audit ran. The commits between
them touch `AGENTS.md` and `test/voice`, not `src/page` or `test/page`, so every finding below still applies.

## How this was done

- Two read-only readers covered the folder in parallel. One read `actions`, `snapshot`, `read` and `robust`;
  the other read `security`, `review2`, `format` and `png`. Both read `test/page/helpers.ts` and the source
  under `src/page/` and `src/safety/` that the tests exercise.
- Every dead-code claim was checked with grep over `src/`, `helper/` and `test/`.
- Baseline: `npm run build`, `npm run typecheck` and `npx vitest run test/page` pass at this base.
- No file was edited. No test was deleted.

## Definitions used

1. **Duplicate:** two tests assert the same behavior, or one repeats another file's case with no new input.
2. **Constant:** the test asserts an exported constant equals a literal, with no behavior behind it.
3. **Mock only:** the mock returns X and the test asserts X came back, so no real code path is proven.
4. **Dead-code keeper:** the test is the only caller of an otherwise unused export or branch.
5. **Sleep:** the test waits a fixed time instead of waiting for an event, which is a flake risk.

A test that pins a security or safety behavior is valuable even when it looks repetitive. A test with a fake
browser or page is fine when it exercises real formatting, parsing, frame or gate logic. The two readers found
no mock-only tests in this folder: every case drives real Chromium over CDP or BiDi against fixture HTML.

## Flagged tests

| File | Test name | Category | Why | Code it keeps alive | Safe to delete |
|---|---|---|---|---|---|
| `test/page/robust.int.test.ts:100` | `snapshots a large page quickly` | duplicate | Same assertions as `review2.int.test.ts:277`: truncated is true, text is at most 20000, elapsed is under 5000, and `Delete 1499` is found. Only the row count differs (1500 vs 30000), and the larger case is strictly stronger. | `src/page/index.ts` `snapshot()` lines 231 to 278 and the frame walk budget | yes |
| `test/page/snapshot.int.test.ts:240` | `shows an empty-state hint when nothing interactive is visible` | constant | Only asserts a hardcoded UI string and `refCount` 0. The hint plumbing is already unit tested in `format.test.ts:83`. | `src/page/index.ts:261-264` `emptyHint`, consumed at `format.ts:173` | maybe: the `emptyHint` branch loses its only end-to-end check, but the string is cosmetic |
| `test/page/robust.int.test.ts:31` | `runs its runtime in an isolated world the page can neither see nor pre-empt` (line 46 only) | constant | `expect(RUNTIME_KEY).toMatch(/^__bh_[0-9a-f]{10}$/)` asserts the shape of an exported constant. The rest of the test is valuable: it poisons the real key and checks that nothing leaks. The export is **not** test-only; the test needs the real key at line 37. | `src/page/frames.ts:27`, used at 222, 249 and 289 | no: delete line 46 only, keep the export |
| `test/page/read.int.test.ts:54` | `find searches inside iframes and scoped text candidates` (lines 60 to 65 only) | duplicate | The click-cross-link, `waitFor('cross clicked')`, then read `#out` block repeats `snapshot.int.test.ts:225-233` and `robust.int.test.ts:162-167`. The find assertions in the same test are unique. | `src/page/index.ts` `click()` and `frames.ts` `resolveRef()` | no: delete lines 60 to 65 only |
| `test/page/actions.int.test.ts:188` | `waits for text to appear / disappear and times out` (line 197 only) | timing | `expect(Date.now() - t0).toBeGreaterThanOrEqual(300)` is implied by the 400 ms in-page timer that sets the text. `waitFor` cannot resolve before the text exists. | `src/page/index.ts` `waitFor()` polling loop | no: delete the assertion only |
| `test/page/format.test.ts:249` | `screenshot capture planning (finding #14) > clips very long pages so the output height ≤ 8000 and captured pixels ≤ 25 MP` | constant (self-referential bound) | The bounds are `MAX_OUTPUT_DIM` and `MAX_CAPTURE_PIXELS`, the same constants `planCapture` defaults to, so changing 8000 to 4000 still passes. The 8000 in the name is never pinned. | `planCapture`, `src/page/png.ts:282-303`, constants at 263-265 | no: replace the bounds with the literals 8000 and 25000000 |
| `test/page/format.test.ts:258` | `screenshot capture planning (finding #14) > reduces the scale for very wide pages instead of exceeding 8000 px` | constant (self-referential bound) | The width bound repeats `MAX_OUTPUT_DIM`; only `clipped` is independent. The real 8000 is pinned end to end by `security.int.test.ts:386`. | `planCapture` width branch, `src/page/png.ts:293-296` | maybe: keep it and assert 8000 literally |
| `test/page/format.test.ts:31` | `summaryLine > says when the walk stopped for time / size (review #2 finding 15)` | duplicate (one assertion) | The `chars` call hits the same truncated-summary branch as the previous test's non-null `truncatedAt`; `src/page/format.ts:136-139` treats both identically. The `time` and `nodes` cases are unique. | `summaryLine`, `src/page/format.ts:133-140` | no: drop only the `chars` line |
| `test/page/review2.int.test.ts:194` | `#4 describeFocused reports a focused button, and null for the body` (one assertion) | duplicate | The blur-to-null assertion repeats `security.int.test.ts:360`. The button shape assertion is new. | `describeFocused`, `src/page/index.ts:1179-1207` | no: drop the null assertion only |

## Sleep-based tests

| File | Test name | Sleep | Why it is a risk | Safe to delete |
|---|---|---|---|---|
| `test/page/security.int.test.ts:139` | `#11 after TIMEOUT no further text lands, even once the page unblocks` | `setTimeout(r, 1_500)` | A fixed 1.5 s window to prove "nothing arrives later". A chunk landing after 1.5 s would pass. The test is valuable; rewrite the wait as a fixture flag. | no: rewrite the wait |
| `test/page/security.int.test.ts:250` | `#9 a page that poisons JSON/String/Array/Map and DOM methods cannot forge lines or refs` | `setTimeout(r, 200)` | The poison script runs before the load event that `env.open` already waits for, so the 200 ms masks a race. The test is valuable; rewrite as a flag or drop the wait. | no: rewrite the wait |
| `test/page/actions.int.test.ts:256` | `times out instead of hanging when the page is blocked` | `setTimeout(r, 100)` | A fixed delay to let a 20 s busy loop start, under a 40 s cap. It covers the `describe` timeout path, so keep it, but the race is load-bearing and fixed. | no: rewrite the race |
| `test/page/robust.int.test.ts:173` | `reports a hung cross-site frame as unreadable without failing the snapshot` | `setTimeout(r, 300)` | A fixed wait for a busy frame, then a 12 s wall-clock bound. It covers the `(unreadable)` branch. | no: rewrite the wait |
| `test/page/actions.int.test.ts:188` | `waits for text to appear / disappear and times out` | none, but a wall-clock assertion | `>= 300` elapsed adds nothing; see the table above. | no: drop the assertion |

Related wall-clock bounds that are not sleeps: `security.int.test.ts:113,137,370` and
`review2.int.test.ts:282,292,297,308,312,316,320` use 5 s, 16.5 s, 25 s, 2 s and 500 ms limits. They carry the
same flake risk on a loaded machine. The limits are generous, so keep them and watch CI.

## Cross-file duplicates

- `snapshot.int.test.ts:27` `renders the §3.2 format with header, indented tree and summary` overlaps `format.test.ts:47`. Keep: it exercises
  the real runtime role and ref emission.
- `snapshot.int.test.ts:183` `truncates at a line boundary` overlaps `format.test.ts:64` and
  `review2.int.test.ts:277`. Keep: only here is the hidden count at the cut verified.
- `snapshot.int.test.ts:127` repeats the reload-to-STALE_REF case from `security.int.test.ts:207`. Keep: the
  rename, remove and bad-ref cases are unique.
- `read.int.test.ts:17` find ranking overlaps `format.test.ts:99`. Keep: it proves real candidate extraction
  and `describe().idAttr`.
- `actions.int.test.ts:214` repeats the 640 by 450 screenshot case from `security.int.test.ts:377`. Keep: the
  scale and element-size cases are unique.
- `actions.int.test.ts:41` repeats the `describeFocused` null case from `review2.int.test.ts:194` and
  `security.int.test.ts:346`. Keep: the iframe focus and ref shape are unique.
- `actions.int.test.ts:141` repeats the `Hyper+Q` invalid-key assertion from `format.test.ts:160`. Keep: the
  real key dispatch and modifier-release log are unique.
- `security.int.test.ts:158-161` and `review2.int.test.ts:229-242` both pin the OBSCURED split (message carries
  role and ref, page text carries the name). Review2 adds a hostile cover name and ref stability. Keep both.
- `format.test.ts:265-278` and `review2.int.test.ts:247-262` both cover invisible characters. One is unit
  level, the other is end to end. Keep both.
- No exact cross-file duplicate was found. The only full duplicate is `robust.int.test.ts:100`, listed above.

## Tests kept, and why

Actions: typing append, clear, submit, textarea and non-ASCII (63); contenteditable append and clear (81);
refusal on button, readonly and combobox (91); select by label or value, multi, invalid and custom control
(101); double, right and hover (125); modifier log and ControlOrMeta select-all (141); window and element
scroll plus STALE_REF (172); screenshot scale, full page and element (214); visible and hidden file inputs,
not-multiple and missing file (237).

Snapshot: secret redaction across interactive and all filters (46); Gmail roles, shadow DOM, contenteditable
and JS rows (80); hidden prompt injection omitted in snapshot, readText and find (107); ref stability, rename,
remove, malformed refs and reload (127); scope subtree and WRONG_TAB (167); same and cross-origin frames,
hidden and blank skipped (199); acting inside frames by ref (220).

Read: placeholder, label, role matching plus context (38); article extraction, chrome and hidden excluded,
truncation (71); body fallback, scope and iframe markers (94); `describe` ElementInfo for submit, link, secret
and checkbox (110); disabled, aria-disabled and contenteditable state (155).

Robust: strict CSP and Trusted Types (19); isolated world and poisoned globals (31); closed details hidden and
big select summarised (51); labels not duplicated in filter all (70); fake refs defused and long names stable
(79); real OOPIF snapshot, find and click (154); hung OOPIF unreadable (173).

Security: newline, tab, textarea and contenteditable typing rules (#2); email, number and date fill (#2);
20k chars and speed (#11); FOCUS_MOVED stops mid-type (#11); TIMEOUT lands nothing after the deadline (#11);
overlay and banner OBSCURED, click after removal (#7); centre-free, shadow, below-fold and iframe clicks (#7);
iframe under a parent overlay OBSCURED (#7); main and child frame navigation make refs STALE (#8); hostile page
cannot forge lines or refs (#9); formSummary content, live typing and nulls (#10); formSummary redaction and
600 char cap (#10, #13); snapshot redaction of every secret field (#13); `describeFocused` null, closed shadow,
open shadow and custom element (#3); tall page clipped to 8000 (#14); wide page scaled to at most 8000 (#14).

Review 2: frameUrls order, no blanks and late frame (#2); secretHint across masked, label, OTP and card
fields (#10); snapshot redaction for every secretHint field (#10); password on focus DENIED (#13); focus
redirected into a password input inside contenteditable DENIED (#13); text-security on focus refused and
`clear` keeps the old value (#13); secret flips between chunks and stops at 2000 of 3000 (#13); select_option
errors keep labels in pageText (#8); OBSCURED cover named by role and ref (#8); invisible chars across
snapshot, readText, find and describe (#14); 30k rows within budget (#15); walkers stop at the deadline and
the page is free afterwards (#15).

Format: summaryLine pluralisation and hidden count; assembleSnapshot layout, line-boundary truncation and
empty hint; truncateText newline and word fallback; find ranking; parseKeyCombo aliases, combos, bad input and
mac edit commands; frame helpers hostLabel, payment patterns and blob frames; escaping cleanText, defuseRefs,
quote, renderNode and header; screenshot planning small, clip and wide; invisible characters; knownRole.

PNG: RGBA and RGB round trip, RGB choice, all filter types, area-average downscale for even and odd sizes,
scalePng dimensions, pass-through and bad input.

## Open code questions answered while auditing

The owner asked for short answers to the questions left open in the first report. These are answers from the
code, not from memory.

18. **Push-to-talk and the wake phrase.** Push-to-talk skips the wake check; a spoken "hey stephen" is still
    stripped. `src/voice/listener.ts:826` guards the check with `!ptt`. So holding F5 and saying "open
    YouTube" works, with or without the name.
19. **Start order.** Stephen Helper starts at login once it is added to Login Items. `stephen listen` starts
    when the user clicks Start in the menu or Ask box (`helper/main.swift:572`, `helper/StephenControl.swift`).
    The helper owns only the listener it started and does not auto-restart it; a crash is logged and the menu
    refreshes.
20. **Sockets.** There are three: `helper.sock` (keys and audio), `app.sock` (window, chat, confirmations) and
    `phone.sock` (phone bridge). `phone.sock` is off until a marker exists (`isPhoneOn`, `src/phone/setup.ts:120`).
21. **Typed chat trust.** Typed chat is `source: 'app'` (`src/app/server.ts:799`), trust `trusted`
    (`trustOf`, `src/voice/assistant.ts:32`), and it bypasses the wake check through `listener.submit`.
22. **Reply bubbles.** `chat.done` is the only path that adds a reply bubble (`helper/AppClient.swift:348`).
    `state` only drives the status indicator and clears waiting replies on idle.
23. **`announce` has no `gate.check`.** It performs no page action, so its controls are the 120 character and
    per-minute guards plus an audit entry (`src/voice/announce.ts`). This is not a gap, but a one-line note in
    DESIGN would stop the next reader asking.
24. **Private reads are not audited.** `src/safety/gate.ts:341-343` audits only non-read kinds. Reads arm the
    taint and are saved to session state, and `taintedHosts()` exposes them for status. This looks deliberate:
    the audit log records actions, not reads. The effect is that `audit.log` cannot show which private pages
    were read. Worth a DESIGN sentence, not a code change.
25. **`--assume-private-read` cannot weaken a resume.** It only adds taint, and a resume restores no approvals
    (`src/serve-args.ts`, `src/safety/session-state.ts`). Old turns are quoted data, so a trusted old turn
    cannot approve a new action.
27. **Job dialog for every source.** Yes, the start dialog appears for F5, typed text and the wake word alike,
    and the task text is quoted as untrusted (`src/jobs/router.ts` header, `quoteUntrusted`).
28. **"Remember X and play Y".** X is saved by the memory router and only "play Y" reaches Claude
    (`src/voice/memory-router.ts:15`). X returns on later runs inside `<user_memory>` as data, never as a
    command (`src/voice/claude.ts:159`).
29. **Phone trust.** The phone run gets no memory items (`memoryForTrust`, `src/voice/claude.ts:173`), and the
    phone link is off until a marker exists. Every memory change from the phone is refused.

## Recommendations

1. Delete `test/page/robust.int.test.ts:100` (`snapshots a large page quickly`). It is an exact weaker copy of
   `review2.int.test.ts:277`. This is the only full test deletion.
2. Delete the shape assertion at `test/page/robust.int.test.ts:46`. Keep the export: the test needs the real
   key at line 37 to poison it.
3. Delete the duplicated click block at `test/page/read.int.test.ts:60-65`. Keep the find assertions.
4. Delete the elapsed assertion at `test/page/actions.int.test.ts:197`. Keep the test.
5. Replace the self-referential bounds at `test/page/format.test.ts:249` and `:258` with the literals 8000 and
   25000000, so a changed default fails the test.
6. Drop the `chars` line at `test/page/format.test.ts:31`. Keep the `time` and `nodes` cases.
7. Drop the null assertion at `test/page/review2.int.test.ts:194`. Keep the button shape assertion.
8. Rewrite the two fixed sleeps in `test/page/security.int.test.ts:139` and `:250` as waits on a fixture flag.
   Keep both tests. Do the same for `actions.int.test.ts:256` and `robust.int.test.ts:173` when someone is in
   the file.
9. Keep `test/page/snapshot.int.test.ts:240`, or move the hint string to a `format` unit test. It is the only
   end-to-end check of the `emptyHint` branch.
10. Delete no security test. The security file is the most valuable part of this folder.

Net effect if all of the above lands: one test deleted, five assertions or lines removed, two bound assertions
tightened, two sleeps rewritten, and no source change.

## Checks

- `npm run build`: pass.
- `npm run typecheck`: pass.
- `npx vitest run test/page`: pass (8 files, 172 tests, 112 s).
- `npx vitest run`: pass (180 files, 3768 tests passed, 5 skipped, 288 s).

## Notes for the dev lane

- The updated `AGENTS.md` is now on `qa` (PR #271, commit `50502f4`). The build, commit and PR steps are the
  ones this report follows.
- `announce` and private-read auditing are answered above. Neither is a safety bug as written, but both would
  benefit from one sentence in `docs/DESIGN.md` so the next audit does not re-open them.
- This report is proposals only. The dev lane decides what to accept, and any change to a security test needs
  a dev-lane security review.
