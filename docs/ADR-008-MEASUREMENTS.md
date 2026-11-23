# ADR-008: the four Mac measurements, as steps for the owner

Date: 2026-11-12. Goes with `docs/ADR-008-tier1-fast-path.md` ("What must be measured on the Mac"). The dev lane does
not start the fast path (`open_app`, `volume`) until these are in.

How to use: do the steps in order, in the repo folder, on `qa` after a build. Each part ends with **Paste back**:
copy what the command prints into the chat with the review agent (or into tracker #10). Nothing here changes
Stephen. No command prints what you said, a page, a URL or a host name: only counts, times and yes or no.

| # | Measurement | Who | Status |
|---|---|---|---|
| 1 | Second `serve`: start time and idle memory | Review agent, on the owner's Mac | **Done 2026-11-12** (below) |
| 2 | Two programs using the browser at once | Owner (2 minutes) with the review agent | Open |
| 3 | Does play or pause on YouTube mark the conversation as "read private data"? | Owner (3 minutes) | Open |
| 4 | F5 "open Safari", 20 times | Owner (5 minutes) | Open |

## 1. Second serve: start time and idle memory (done)

Measured on the owner's Mac on 2026-11-12, `qa` @ `541e9e9`, with one command each (kept here so anyone can repeat):

```bash
node -e "const {spawn}=require('child_process');const t=Date.now();const c=spawn(process.execPath,['dist/cli.js','serve'],{stdio:['pipe','pipe','ignore']});c.stdout.once('data',()=>{console.log('serve cold start:',Date.now()-t,'ms');c.kill()});c.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'m',version:'0'}}})+'\n')"
```

```bash
ps -axo rss=,command= | grep "[c]li.js serve" | awk '{printf "serve: %d MB\n",$1/1024}'
```

| What | Result | Meaning for ADR-008 |
|---|---|---|
| Start until the first answer, 3 runs | 210 ms, 140 ms, 141 ms | Small, but still worth keeping the fast serve warm: a cold one would use about a tenth of the 1.5 s budget |
| Idle memory of one running serve (2 seen) | 52 MB each | One extra serve is far below the 1 GB footprint trigger (plan 5.4) |

Limits: the start time is until the server answers `initialize`. It does not include attaching to the browser,
which only the browser verbs need (second PR). The memory is of a serve that has been idle; one that has a browser
attached may hold more.

## 2. Two programs using the browser at once (owner and review agent)

Why: for play, pause and next the fast serve must talk to the browser while Claude's own serve is attached too.

1. **Do:** start Stephen as usual. Open "Zen for Stephen".
2. **Do:** say "Hey Stephen, play lofi on YouTube" (or hold F5 and say it). **See:** the video plays.
3. **Do:** while it plays, write "ready" to the review agent. It lists the tabs through a second connection (it has
   Stephen's tools too) and reports what it saw.
4. **Do:** say "Hey Stephen, pause". **See:** the video pauses.

**Paste back:** "played: yes or no", "paused: yes or no", and anything odd (a prompt, an error, Zen asking to
connect again).

## 3. Does play or pause on YouTube mark the conversation as private? (owner)

Why: a Google account frame inside a YouTube page may count as a private read (this is also item A3). If it does,
a fast "pause" would start asking for confirmations afterwards.

1. **Do:** restart Stephen (so the conversation is new). Say "Hey Stephen, play lofi on YouTube".
2. **Do:** right after the reply, run this in the repo folder and keep the line it prints:

```bash
node -e "import('./dist/config.js').then(({loadConfig})=>{const fs=require('fs');const p=loadConfig().home+'/voice/conversation-state.json';if(!fs.existsSync(p))return console.log('state file: none');const s=JSON.parse(fs.readFileSync(p,'utf8'));console.log('private reads:',s.privateReads.length,'| google account frame:',JSON.stringify(s.privateReads).includes('accounts.google.com'),'| approved hosts:',s.trustedHosts.length)})"
```

3. **Do:** within one minute say "Hey Stephen, pause", then run the same command again.
4. **Do:** the same two steps once more on YouTube Music ("play lofi on YouTube Music", then "pause").

**Paste back:** the four lines (after play, after pause, for YouTube and for YouTube Music). `state file: none` is a
valid answer: it means nothing private was noted.

## 4. F5 "open Safari", 20 times (owner)

Why: this is the baseline the fast path must beat (target: action done p50 1.5 s, p95 2.5 s from key release).
Today the command goes through the model, so expect it to be slower. The numbers also show how much of the time is
hearing (which the fast path cannot remove).

1. **Do:** first run `node dist/cli.js mac-checks` and check the line "the key listener is on" says PASS (needs the
   key listener check, PR in review). If it says FAIL, do what the line says, then go on.
2. **Do:** 20 times: hold F5, say "open Safari", let go, wait for Safari to come to the front, then close the
   Safari window (Cmd+W). Do not hurry; one try every 10 seconds is fine.
3. **Do:** run:

```bash
node dist/cli.js latency --days 1
```

**Paste back:** the whole block that starts with `ptt / model` (the lines `endpoint`, `asr`, `handoff`, `reply`,
`speech → reply`, `speech → audio`, `model`, `tools`, `first token`), and how many of the 20 opened Safari.

## What happens with the results

| Result | Effect |
|---|---|
| 2 fails (second connection breaks the first, or Zen asks again) | Browser verbs stay on the model path; only `open_app` and `volume` go fast (ADR-008 option F becomes the whole plan). Needs an owner decision |
| 3 shows a private read after play or pause | The A3 rule (YouTube account frame) must land before the browser verbs go fast |
| 4: `endpoint` + `asr` + `handoff` already above 1.5 s at p50 | The Tier 1 target for F5 cannot be met by skipping the model alone; E4a and the ASR choice (E2) move first |
