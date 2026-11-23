# Zen: why "play music" does not play, and can Stephen use the real Zen?

Date: 2026-11-17. Lane: review. Diagnosis only: no product code changed here.

## Short answer

1. **Cause.** Zen was open the normal way, without remote control. Stephen could not attach to it. So
   `play_media` found the video and opened it with `open -a Zen.app <watch url>`. That worked. But Stephen
   cannot press play in a browser it is not attached to, and Zen (Firefox) blocks videos with sound from
   starting by themselves. So the video sat paused. Stephen said so. Not a gate refusal, not a YouTube
   consent page, not a crash.
2. **"Zen for Stephen" already opens the real Zen.** Same profile, same tabs, same logins. It is not a
   separate browser. The only differences: Zen must be started through that app, and while it runs with
   remote control, websites can see `navigator.webdriver = true` (some sign-in pages then show a bot check).
3. **Recommendation.** Today, with no code change: allow autoplay for youtube.com once in Zen. Then "play X"
   should start in the normal Zen with no remote control. For pause and next, and for full control, use
   "Zen for Stephen" as the everyday Zen (put it in the Dock in place of Zen). Later (dev lane): fix the
   wording, and test Firefox's runtime "Remote control" mode, which may hide the bot flag.

## A. Why "open YouTube and play music" fails

### Evidence (read-only, Cris's Mac, 2026-11-17)

Stephen's home is the legacy folder `~/.browser-hub` (no `~/.stephen` yet; doctor says so).

| Source | What it shows |
| --- | --- |
| `history/2026-11-17.jsonl` | Last music request: 19:42 local (00:42Z). Tools: `announce`, then `play_media`, both `isError: false`. Spoken reply, in short: "I opened the video in Zen. Stephen isn't connected to Zen, so it couldn't press play. Click the video, or open Zen with Zen for Stephen." |
| `audit.log`, same time | `play_media` public search read ok (a video was found); gate `allow`, no rules fired; then `via: "open -a"`, `app: /Applications/Zen.app`, outcome `ok`. |
| `audit.log`, 2026-11-12 | Same tool works fully when attached: `via: "attached browser (reused tab)"`, then `media_control` ok. So the code path is fine when Zen has remote control. |
| `telemetry/latency-2026-11-17.jsonl` | That turn: route `model`, tier 2, outcome `ok`, 3 turns. No error code. |
| `voice/tool-log.jsonl` | Empty. |
| `state/zen.json` | Last "Zen for Stephen" launch: mode `real`, profile = the install default profile (the one Zen opens normally). That pid is gone now. |
| `ps` | The Zen running now was started at 22:20 with no arguments: no `--remote-debugging-port`. |
| `node dist/cli.js doctor` | `Zen mode: real, launch: never (attach-only)`. `Stephen-ready Zen running: no. Zen is open normally (without Stephen access)`. Launcher app installed. Chrome remote debugging on (port 9222). |
| Zen profile prefs | No autoplay override for youtube.com. Firefox default `media.autoplay.default = 1`: block audible autoplay. |

So the failure is **"Zen not attached"**, plus **Zen's autoplay block** on the fallback path. The gate
allowed everything. YouTube consent was not involved (the server-side search worked and the page opened).

### The code path

- Voice: the grammar classifier (`src/voice/grammar/classify.ts`) is in shadow mode. It only labels. Every
  request goes to the model (telemetry `route: model`). "play X" with no site names YouTube Music in the
  grammar (`sites.ts`), but the model picks `play_media` and its `service`.
- `play_media` (`src/desktop/play.ts`):
  1. Screen lock check, then a pure gate pre-check for opening the YouTube search.
  2. If allowed: a server-side GET of the YouTube results page finds the top video (no browser).
  3. `Desktop.openParsed` (`src/desktop/index.ts`): the gate, then `tryAttach(browser)`.
  4. `tryAttach('zen')`: only when `zen.mode` is `real` and `zen.launch` is `never`; it attaches to a Zen
     started by `zen-launch`, and never starts Zen. Chrome is never attached here (each Chrome connection asks
     the user to click Allow).
  5. Attached: open or reuse the tab, then `ensurePlaying` reads the Play/Pause button and presses `k`.
  6. Not attached: `open -a <Zen.app> <url>` in the normal window. No control after that.
- `open_url` uses the same `openParsed`. Not attached, it opens the page and that is fine.
- `media_control` (pause, next) needs an attached browser to see YouTube tabs; otherwise it only controls
  Spotify or Apple Music.

### Every way it can fail, and what Stephen says

The model speaks a short version of the tool text. Tool text below, shortened.

| # | When | Tool text |
| --- | --- | --- |
| 1 | Empty song name | "Nothing to play: the query is empty." |
| 2 | Mac locked, or lock state unknown | "Your Mac is locked; Stephen does not open apps or pages while the screen is locked. Nothing was done." |
| 3 | Gate denies (rate limit, blocked site) | "Not played, blocked by Stephen's safety policy: <reason>" |
| 4 | Gate wants approval (for example after a private read) | No server search. The approval prompt shows; if declined, the normal "declined" message. |
| 5 | YouTube search could not be read | Falls back to the search results page (then 6 or 8). |
| 6 | **Zen not attached (seen today)** | "Opened the YouTube video page in Zen. Stephen isn't connected to Zen, so it can't press play, and Zen may block the sound until the user clicks the video ... opening Zen with Zen for Stephen lets Stephen start videos hands-free." |
| 7 | Zen not installed / `open` fails | "Not opened: Zen is not installed ..." / "Could not open <url> in Zen: ..." |
| 8 | Attached, but no video link on results | "Opened the YouTube search ... but no video started ... You can find a result and click it." |
| 9 | Attached, play key failed | "Playing ... (it may be paused: pressing play didn't work: <why>)" |
| 10 | `media_control` with Zen not attached | "Nothing done: No YouTube Music tab found: Stephen isn't connected to Zen, so it can't see its tabs (opening Zen with Zen for Stephen fixes that), and Spotify and Music aren't running." |

Case 6 returns `ok`, not an error. To Cris it sounds like "could not play", because nothing plays.

## B. Can Stephen use Cris's real Zen?

### Facts

- Zen is Firefox (Gecko). Firefox removed CDP in 141. The only remote protocol is WebDriver BiDi.
- Its listener starts only when Zen is **started** with `--remote-debugging-port`. A Zen already running
  without it can never be attached to. No setting turns it on later (see option 5 for the one exception).
- The listener binds to loopback only and rejects requests with an `Origin` header, so web pages cannot
  connect. Any local program can, with no password. Gecko allows one session at a time.
- **"Zen for Stephen"** (`~/Applications/Zen for Stephen.app`, runs `stephen zen-launch`, code in
  `src/zen-launcher.ts`):
  - starts `/Applications/Zen.app` with `--profile <real profile> --new-instance --remote-debugging-port 0`
    (random free port, written to `state/zen.json`);
  - the profile is `zen.profilePath` if set, else the profiles.ini install default, else `Default=1`. On
    Cris's Mac that is the install default: **the same profile Zen opens normally**. Tabs, logins, extensions
    and history are all his;
  - writes one line to that profile's `user.js`: `remote.prefs.recommended = false`, so Safe Browsing,
    blocklists, updates and password saving stay on;
  - if Zen is already open normally, it asks "Quit and reopen it for Stephen?" and quits Zen like Cmd+Q
    (never kills it). Tabs come back if Zen restores the previous session.
- Config keys (`src/config.ts`): `zen.mode` = `real` (default) or `agent` (a separate profile in
  `~/.browser-hub/profiles/zen`); `zen.launch` = `never` (default for real: attach-only) or `auto` (default for
  agent: Stephen may start Zen); `zen.profilePath`; `zen.extraPrefs` (agent profile only). Cris has none set,
  so: real, never.
- Bot detection (`docs/PLAN-WORK-SPLIT.md` section 14, measured 2026-11-07): with the port on, pages see
  `navigator.webdriver = true`. Google, claude.ai and Cloudflare sign-in checks can treat that as a bot. Zen
  1.24 has no pref to hide it in that mode. Firefox also marks the window as remote-controlled (striped
  address bar, robot icon), which may be why it "feels" like a different browser.

### Options

**1. Use "Zen for Stephen" as the everyday Zen.** Already possible, no config change.
- How: remove Zen from the Dock, put "Zen for Stephen" there; optional login item. Set Zen to restore the
  previous session.
- Pros: full control: play, pause, next, tabs, reading, all through the gate. Proven on 2026-11-12.
- Cons: `navigator.webdriver = true` all day, so some sign-ins show bot checks (workaround: sign in once in a
  normal Zen, quit, reopen with the launcher; cookies stay). Remote-control look in the window. If Zen is
  opened any other way (a link from another app when Zen is closed, an update restart), it comes up without
  the port again.
- Security: an open, unauthenticated BiDi port on 127.0.0.1 for the whole day, on the profile with all his
  logins. Any process running as Cris (or any local user) can find the port and drive his signed-in browser,
  outside Stephen's gate. Web pages cannot. This risk exists today whenever the launcher is used; option 1
  makes it all day.

**2. Use Chrome for media.** `defaultBrowser` or the model's `browser: "chrome"`.
- Chrome is never attached on the voice path (each connection needs a click on Allow), so `play_media` also
  ends in `open -a` with no play control.
- But Chrome's autoplay policy lets sites the user plays media on often (YouTube) start with sound, so the video
  likely starts by itself. Not tested here.
- Cons: Cris wants Zen. Pause and next still do not work.

**3. Open in the default browser with `open`, no control.** This is what happens today when Zen is not
attached (`open -a Zen.app`). It already works for "open YouTube". For "play", it only plays if the browser
allows autoplay (option 4).

**4. Allow autoplay for youtube.com in the normal Zen (one-time, by Cris).** New, smallest step.
- How: on youtube.com in Zen, open the site info (lock icon), Autoplay: "Allow Audio and Video". Or Settings,
  Privacy and Security, Permissions, Autoplay, add youtube.com (and music.youtube.com).
- Then path 6 opens the watch page in his normal Zen and YouTube should start it. No port, no bot flag.
- Cons: pause and next by voice still do not work in Zen (only Spotify / Apple Music). The spoken text still
  says "couldn't press play" (wording fix needed). Not yet tested on his Mac: Cris should try once.
- Security: none new. A site permission he sets himself, for one site.

**5. Firefox runtime "Remote control" (research).** Zen 1.24 has `remote.experimental.dynamicstart.enabled`
(off by default): remote control can be turned on in a running browser, with an "Allow remote control?"
prompt per connection. It may not set `navigator.webdriver`. Unverified. Needs: a test profile, measure the
flag, find the port, and accept that the Allow prompt only works when Cris is at the Mac (not from the
phone). See `docs/PLAN-WORK-SPLIT.md` section 14.

**6. Agent profile (`zen.mode: "agent"`).** A separate Zen profile Stephen may start itself. This is the
"separate window" Cris does not want, and it has no logins. Listed for completeness only.

### Recommendation

- **Today (Cris, no code):** option 4. Allow autoplay for youtube.com and music.youtube.com in Zen, then say
  "play <song>" with Zen open normally. Tell us if it starts.
- **When he wants hands-free pause, next and tabs:** option 1. "Zen for Stephen" is his real Zen already;
  only the way it starts differs. Accept the bot-check cost on some sign-ins, or keep using the normal Zen.
- **Dev lane, separate reviewed PRs:**
  1. Wording in `play.ts` case 6: say "it may start by itself if Zen allows autoplay for YouTube; if not,
     click it", and mention the autoplay setting once. (Issue #89 covers the "Zen for Stephen" words.)
  2. Optional: `media_control` falls back to the macOS media keys (Now Playing) when no browser is attached,
     so pause and next work in the normal Zen. Needs a design and a gate review.
  3. Research option 5 on a test profile.
- **Not recommended:** making Stephen launch or relaunch the real Zen by itself (`zen.launch: auto` on the
  real profile), or keeping the port open without the owner choosing it. Profile and trust stay the owner's
  choice.

## Follow-ups found in passing

- Stephen still uses `~/.browser-hub`. Doctor shows the `mv` command; owner's call.
- Unrelated: this Mac runs several `firefox-devtools-mcp` processes with `--firefox-path /path/to/Zen` (a
  placeholder path). That is a Claude Code MCP setting, not Stephen.
