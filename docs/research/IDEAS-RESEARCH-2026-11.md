# Stephen ideas research (2026-11)

Research, planning and trade-offs only. No code, no architecture spec. Companion to `PRODUCT-PLAN-2026-11.md`; nothing here displaces its P0s (A2 latency monitor, A6 accuracy baseline, A1 Mac test pass). Sources fetched 2026-11-11. X and LinkedIn pages were login-walled or robots-blocked, so social claims are cited only through reachable articles, and marked when unverified. Legal notes are research, not legal advice.

**Revision 3 (2026-11-11):** the owner answered the open questions (section 8) and set a platform direction: Mac first, then Windows, for regular users (section 9). His two links were studied: the `jarvis-ai` GitHub topic (2.7) and `terminal-mac` (section 3).

---

## 1. Summary

- **"Jarvis" in 2026 is a feeling, not a product:** an always-on agent that works while you are away and reports back by voice. The praise attaches to OpenClaw-style agents and, since September 2026, to Meta Muse, Instinct Concierge and Google's "Call for Me". Stephen already has the two pieces behind it (jobs while away, phone channel). It lacks the proactive report back and scheduling.
- **Calls to businesses are real but early.** Google's is US-only, Pixel 11, paid; Meta's is in limited testing; AI-only calls reportedly succeed far less often than human-placed ones. US and Canadian rules treat synthetic voices as robocall technology; one-off personal calls look workable but are not settled.
- **A call is a send.** It speaks for the owner and can bind him, so it conflicts with U5. It belongs in Phase 4 behind its own ADR. The safe cousin: Stephen notifying or calling the owner himself.
- **The virtual Mac solves a problem Stephen chose not to have.** The "terminal Mac" the owner saw is `govijr/terminal-mac`: a real macOS virtual machine whose screen is drawn inside a terminal, built for computer-use agents (section 3). VMs contain risky desktop control, which is out of scope (U8). A VM does not fix the Zen bot-check loop, and on a 16 GB Mac a guest takes about half the memory. One narrow use (a clean Mac test rig) merits a later spike, and terminal-mac is now the first candidate for it.
- **The open-source "Jarvis" field is wide and shallow (2.7).** 225 repositories carry the topic; most are Python scripts with a fixed command list and no safety model. Stephen is ahead on the gate, taint tracking and measured injection testing, and behind on installation, onboarding and Windows.
- **Platform direction (owner, 2026-11-11): Mac first, then Windows, for regular users.** This strengthens the "keep the TypeScript core" verdict and makes thin platform code a rule (section 9). It also turns distribution, signing, authentication and cost per user from non-goals into dated decisions.
- **Multi-agent mostly buys coverage by spending tokens** (reported: about 4x chat for one agent, about 15x for multi-agent). Useful for Stephen only inside a sandboxed job, and on the owner's Claude Pro plan (the smallest paid pool) it is a rare, opt-in mode (4.3).
- **"One app, many LLMs" is hype for Stephen's core:** each vendor needs an API key (against U6) and receives private data. The useful part is routing inside one vendor: no model for Tier 1, a smaller Claude model for light Tier 2, a stronger one for jobs.
- **Watch item, not a reopen of U6:** Anthropic changed subscription rules for programmatic use three times in 2026. Today `claude -p` on a plan login still draws from plan limits. Stephen should detect a change.
- **Most promising near-term idea: "Away mode"** (scheduled read-only briefing plus job reports pushed to the phone). It delivers the Jarvis feeling inside every fixed decision. The owner confirmed that messaging him is allowed, and that scheduled runs are an opt-in setting.

---

## 2. Jarvis

### 2.1 What "Jarvis" refers to

| Referent | What it is | Status (Nov 2026) | Phone calls? | Relevance to Stephen |
|---|---|---|---|---|
| J.A.R.V.I.S. (Iron Man) | Fictional butler AI: always present, proactive, speaks, acts unattended, reports back | Cultural benchmark | Yes, in fiction | The bar users judge against: presence, initiative, trust |
| Google "Project Jarvis" | Codename for a Chrome browsing agent, later named Project Mariner | Mariner announced Dec 2024, shut down 2026-05-04; ideas folded into Gemini Agent and AI Mode [[TechSpot]](https://www.techspot.com/news/112334-project-mariner-dead-but-google-browser-controlling-ai.html) | No | Screenshot-and-click browsing was slow, costly, error-prone; supports Stephen's DOM-snapshot approach and narrow scope |
| Microsoft JARVIS (HuggingGPT) | Research system: an LLM plans, picks Hugging Face expert models, runs them, summarizes | 25.2k stars; last dated release 2024-01-15; text only, no voice [[GitHub]](https://github.com/microsoft/JARVIS) | No | Historical. Its idea (a controller routing to specialist models) is the ancestor of today's "many models" trend |
| OpenClaw, the "Jarvis moment" | Open-source always-on agent layer over frontier or local models; reaches the user by SMS, WhatsApp, voice calls, email; connects to inbox, calendar, files | First commit 2025-11-24; headline story is the agent phoning its creator to say tasks were done [[Stickevers]](https://williamstickevers.substack.com/p/openclaw-ai-personhood-and-the-jarvis) | Calls the user via ElevenLabs agents plus Twilio [[tutorial]](https://www.codingbutvibes.com/blog/tutorials/openclaw-outbound-calls-setup) | The closest real "Jarvis". Same category as Stephen, opposite safety posture |
| Open-source "Jarvis" Mac builds | Many GitHub projects. One example: Electron plus Swift, wake phrase, Apple on-device speech, Kokoro voice, Claude Code as the brain, memory tab, briefing, Telegram [[GitHub]](https://github.com/dhananjay-nautiyal/J.A.R.V.I.S) | Small projects (the example shows 0 stars); not verified as viral | No | Nearly Stephen's architecture. Differences: it uses spoken confirmation and runs Claude Code without permission prompts |
| Meta Muse, Instinct Concierge, Gemini "Call for Me" | Mainstream agents that now place calls to businesses | Sept 2026 launches (2.4) | Yes | The "makes phone calls for me" example the owner likes most likely traces here or to OpenClaw demos |

Not verified: which specific X or LinkedIn posts the owner saw. A widely repeated story of an agent phoning a restaurant after online booking failed could not be confirmed from a reachable primary source, so it is not relied on.

### 2.2 How they were built, and why

| System | Product-level build | Autonomy model | Why |
|---|---|---|---|
| OpenClaw | Always-on gateway, frontier model in an agent loop, plugin "skills", chat apps as the UI, cron; voice via ElevenLabs agents plus a Twilio number | Headless, no human in the loop by default | Maximum reach, zero friction |
| Open-source Mac Jarvis (example above) | Wake phrase, on-device speech; a fast voice model answers at once while a stronger model works in the background with spoken progress | Spoken read-back before send, pay, delete; background agents run without permission prompts | Feels instant; trusts the model to honour rules |
| Project Mariner | Vision model clicking through Chrome from screenshots | Supervised | Any site without integrations; lost on cost, speed, errors |
| Meta Muse | Cloud agent in a dedicated cloud VM; approval before sensitive actions; audit trail [[Fox News]](https://www.foxnews.com/tech/ai-agents-make-phone-calls) | Approval for sends and purchases | Keeps the agent away from the user's device and passwords |
| Gemini Call for Me | In Google's Phone app; dials from the user's own number; live transcript; takeover [[TechCrunch]](https://techcrunch.com/2026/09/24/google-tests-letting-gemini-make-phone-calls-initially-for-us-pixel-owners/) | User approves what may be shared | Real caller ID, supervised |

The fast-voice-model plus background-work-model split is Stephen's two-tier policy, reached independently.

### 2.3 What users praise and complain about

From a Hacker News thread on OpenClaw [[HN]](https://news.ycombinator.com/item?id=47219250) (first 100k characters read) and the essay above:

| Praise | Complaint |
|---|---|
| Morning briefing from calendar, weather, notes | "Unreliable and buggy"; briefings fail "from time to time"; automations stop after hours |
| It sets up its own integrations ("truly feels like living in the future") | Many ask for one use case Zapier or Automator could not do; "problem hunting" |
| Small automations by voice or chat: to-dos, page monitors | Token spend; some doubt the star count |
| The agent reaching out first (the phone call moment); users name it and thank it | Email plus internet access invites data exfiltration by injected mail; a reported inbox deletion; prompt injection |

Reading: users love initiative and presence, hate flakiness, and fear the access. Stephen's gate answers the fear and its reliability metrics answer the flakiness. It has almost no initiative yet.

### 2.4 Phone-calling landscape

**Consumer products**

| Product | Availability | How it works | Disclosure | Known limits |
|---|---|---|---|---|
| Google "Ask for Me" (Search) | US, since Jan 2025 Labs test | Google calls local shops about price or availability; answer by text or email | Press reports say calls open by identifying an automated Google system [[Layer3 Labs]](https://www.layer3labs.io/comparisons/ai-assistants-that-make-phone-calls) | Never asks for payment details or passwords |
| Gemini "Call for Me" | US, Pixel 11, paid Gemini plan, beta Phone app | Dials from the user's number; handles phone menus and hold; live transcript; takeover | "Introduces itself"; whether it says it is an AI is not stated in sources read | Google: "real-world conversations are nuanced", small scale |
| Meta Muse calling | Muse is in the US and Canada; calling is limited testing to US businesses | Goal in, transcript and summary out | Not published. Reuters (via Layer3 Labs) reported human contractors placed some test calls, which Meta called "a miss" | Human-placed calls succeeded 95 to 98% in internal tests; AI-only "much worse", no figure |
| Instinct Concierge | Early access | Reservations where no online booking exists, cancellation lists, bill disputes | Not published | Terms say agreements made by the assistant can bind the user and actions may not be reversible |

No consumer product in the sources read offers AI-placed calls to businesses in Canada.

**Developer platforms** (vendor-claimed figures, July 2026 [[Morph]](https://www.morphllm.com/comparisons/vapi-vs-retell-vs-bland-vs-synthflow))

| Platform | Cost per minute | Claimed latency | Bring your own model |
|---|---|---|---|
| Vapi | from $0.05 platform fee, plus speech and model | about 500 to 800 ms | Yes |
| Retell | $0.07 to $0.31 all-in | about 600 ms | Yes |
| Bland | $0.11 to $0.14 plus telephony | about 400 ms | No |
| Synthflow | about $0.11 to $0.16 | not published | Partial |
| ElevenLabs Agents | $0.08 beyond plan minutes, model billed separately | TTS only | Yes |

The OpenClaw tutorial quotes about $0.064 per minute for ElevenLabs plus Twilio. Morph's rule of thumb: under about 500 ms per turn feels natural, past about 1,000 ms feels broken. Cost is trivial for personal use; quality is the constraint.

**Legal and consent** (verify with a lawyer before any build)

| Topic | United States | Canada / Ontario |
|---|---|---|
| Is an AI voice a "robocall"? | Yes. FCC Declaratory Ruling 24-17 (Feb 2024): TCPA limits on "artificial or prerecorded voice" cover AI-generated voices; such calls need prior express consent of the called party, with exemptions. Penalty $500 per call, up to treble [[summary]](https://silvertonpublishing.com/blog/ai-voice-agents-tcpa-robocall-rules-2026). Revocation rule changes take effect 2026-11-25 | CRTC rules restrict ADADs (automatic dialing-announcing devices) for solicitation without express consent [[CRTC]](https://crtc.gc.ca/eng/phone/telemarketing/tobligations/rules-regles.htm). A secondary source says the ADAD definition includes synthesized voice and that non-solicitation calls still need opening identification, permitted hours, and prompt disconnect [[Treadstone]](https://www.treadstoneassociates.ca/academy/artificial-intelligence/ai-voice-calls-and-canadian-rules/) |
| One personal call to a business line | Sources read did not address calls to business numbers. Open point | A reservation or stock question is not solicitation. Whether a live conversational agent is an ADAD is untested in sources read. Open point |
| AI disclosure | California requires telling the called person when a prerecorded message uses an artificial voice (Public Utilities Code 2874 as amended) | No federal AI-disclosure rule found in sources read. Identify who the call is for regardless |
| Recording | Varies by state; some need all-party consent (general knowledge, not fetched) | Criminal Code Part VI: a participant may record (one-party consent). Privacy laws do not apply to purely personal use; commercial recording needs notice and purpose [[Fraser]](https://blog.privacylawyer.ca/2025/09/recording-conversations-using-ai.html), [[OPC]](https://priv.gc.ca/en/privacy-topics/surveillance/02_05_d_14) |

Consequences: as a personal tool in Ontario, recording its own calls sits on the lawful side of one-party consent; as a product (U7), the organization rules (notice, purpose, retention) apply. Whether an agent counts as a "participant" when the owner is not on the line is unclear, so announce both the AI and the transcription at the start. That is also the honest design.

**Failure modes:** phone menus and holds; accents and noisy lines; turn latency above a second; staff hanging up on a bot; over-shared personal details; agreeing to something unwanted (binding); voicemail; scam suspicion; silent failure with no proof of outcome. An open OpenClaw issue titled "Voice-call plugin: Multiple critical issues preventing voice calling" [[issue 11554]](https://github.com/openclaw/openclaw/issues/11554) (title only, not read) suggests the do-it-yourself path is brittle.

### 2.5 Mapping to ADR-004 and ADR-005

| Jarvis behaviour | Stephen today | Gap |
|---|---|---|
| "Does work without me" | ADR-004 jobs: sandboxed, no network writes, dialog per start | On request only; no schedule |
| "Tells me when done" | Mac notification, spoken summary | Nothing reaches the owner away from the Mac |
| "Reachable anywhere" | ADR-005: phone via Remote Control, low trust | Inbound only. ADR-005 is a remote control for Stephen, not telephony; calls would be a new channel |
| "Calls people for me" | Nothing; ADR-006 parked by U5 | Harder than email: real time, no final text to hash |

### 2.6 Take, skip, do better

**Take**
- Proactive report back: when a job ends or a scheduled briefing is ready, push it to the phone. This is the cheapest source of the "Jarvis moment".
- Scheduled briefing ("Routines" is already a planned sidebar row): the single most-cited useful OpenClaw habit.
- Fast acknowledgement plus background work with spoken progress (already Tier 2 policy).
- Live transcript and takeover as the standard for any future acting feature (Google's pattern).

**Skip**
- Always-on, no-human-in-the-loop autonomy; self-installing skills; model-written schedules (fixed: model never writes memory, timers or jobs).
- Spoken confirmation (Stephen's rule: a spoken "yes" never approves).
- Screenshot-driven general browsing (the Mariner lesson).
- Human-sounding fillers or hiding that the caller is an AI.

**Do better (when U5 is revisited)**: a "brief-bound call".
1. The owner approves a written call brief in the Ask box: who to call, the goal, the exact facts that may be shared (name, party size, time window), what may be agreed, a time cap. Same idea as ADR-006's click bound to a hash, applied to a brief.
2. The agent on the call gets only the brief. No tools, no memory, no account access. The taint problem is solved by construction: private data that is not in the brief cannot be spoken.
3. It opens by saying it is an AI assistant calling for the owner, and that the call is transcribed.
4. Live transcript in the Stephen window; one key to take over or hang up; it never gives payment details and never accepts terms outside the brief (it says the owner will call back).
5. Outcome recorded as a structured result plus transcript, audited by command id.

No product reviewed publishes this level of constraint. It is the same pitch as the rest of Stephen: prove what it will not do.

### 2.7 Survey: the `jarvis-ai` GitHub topic (owner link)

Source: [github.com/topics/jarvis-ai](https://github.com/topics/jarvis-ai), fetched 2026-11-11. The topic lists **225 public repositories**; the page shows the top 20. Limits of this survey, stated plainly: the GitHub API and most repository pages were blocked from this session, so only four repository pages were read directly (marked D). The others come from the topic listing plus a third-party index page (marked S, treat as claims) or the topic listing only (marked T). Issue trackers could not be read, except terminal-mac's. Star counts are "as fetched"; where two pages disagreed, both are shown.

| Repo | Stars (2026-11-11) | Stack | Voice stack (wake, ASR, TTS) | LLM(s) | Platforms | Standout features | Autonomy and safety model | Src |
|---|---|---|---|---|---|---|---|---|
| [GauravSingh9356/J.A.R.V.I.S](https://github.com/GauravSingh9356/J.A.R.V.I.S) | 1.4k | Python | Keyword "Jarvis" in the transcript; `speech_recognition`; `pyttsx3` | None | Windows, Ubuntu | Face-recognition login, email, news, to-do, OCR, YouTube download; 91 commits, 17 open issues, MIT | None described. Face login gates the app, not actions | D |
| [kishanrajput23/Jarvis-Desktop-Voice-Assistant](https://github.com/kishanrajput23/Jarvis-Desktop-Voice-Assistant) | 1k (topic), 879 (repo page) | Python | None named; tags suggest `speech-recognition`, `pyttsx3` | None ("follows predefined logic") | Windows, macOS, Linux | Open apps and sites, Wikipedia, notes, screenshots; 41 commits, MIT | None | D |
| [akshayaggarwal99/jarvis-ai-assistant](https://github.com/akshayaggarwal99/jarvis-ai-assistant) | 668 (topic), 622 (repo page) | TypeScript with a native Whisper addon; iOS folder | No wake word: hold Fn, double-tap for hands-free; local Whisper or NVIDIA Parakeet through sherpa-onnx, or Deepgram cloud; no TTS | Ollama (local), Gemini, AWS Bedrock | macOS (Apple Silicon and Intel DMG), iOS TestFlight; Windows on the roadmap | Dictation that types at the cursor, filler-word cleanup, small commands; fully offline mode; signed and notarized (author's claim); 114 commits, MIT | None described; it mostly types text | D |
| gia-guar/JARVIS-ChatGPT | 462 | Python, PyTorch (CUDA), LangChain | "Jarvis" wake (Porcupine optional); Whisper medium; cloned voice, ElevenLabs, IBM Watson, `pyttsx3` fallback | GPT-3.5; Vicuna local | Windows, Linux; needs a CUDA GPU | Research mode (Semantic Scholar), chats saved with AI titles | None; a cost disclaimer only. Last update 2023 | S ([README](https://raw.githubusercontent.com/gia-guar/JARVIS-ChatGPT/main/README.md)) |
| blogminhquy/javis-os | 415 (topic), 741 (index) | Python 3.12, Docker | "Hands-free voice control" in a web dashboard; engines not named | 14 providers; subscription CLIs (`claude`, `codex`, `agy`, `grok`) as "brains"; Ollama | Linux, macOS, Windows installers | Role-based "coworkers", shared MCP hub, task queue and reminders, Telegram, Slack, WhatsApp, Zalo; memory as Markdown plus SQLite, each learning pass a git commit | No permission or sandbox model described. Index scan flags install commands piped to a shell | S ([index](https://skillsllm.com/skill/javis-os)) |
| BolisettySujith/J.A.R.V.I.S | 388 | Python, PyQt5 | `speech-recognition`, `pyttsx3` (tags) | None seen | Windows (py2exe tag) | WhatsApp, email, screen recorder, downloads. Last update 2023 | None seen | T |
| [IRISX-AI/IRIS-AI](https://github.com/IRISX-AI/IRIS-AI) | 222 (topic), 185 (org page) | TypeScript, Electron | Voice listed; engines not named | Not named | Desktop; sibling Android app (Kotlin) | Voice, automation, memory, vision, web search, workflows | Not described in pages read | S ([org](https://github.com/IRISX-AI)) |
| boardshogunfluctuate/Capri-AI | 196 (topic), 519 (index) | Not stated; native Windows app, YAML config | None (voice is an unchecked roadmap item) | Claude Code, Codex or Antigravity through account sign-in or API key | Windows 10 and later; macOS, Linux planned | Themed desktop agent for files, shell, web | **Permission mode in config: "ask", "auto" or "read-only", plus allowed folders.** Installer triggers a SmartScreen warning (unsigned) | S ([index](https://skillsllm.com/skill/boardshogunfluctuate-capri-ai)) |
| codewithbro95/J.A.R.V.I.S | 187 | Python back end; Electron and React UI in progress; Ollama | No wake word; Whisper planned, not integrated; LuxTTS offline (moved from Kokoro) | Llama-2-7b fine-tune through Ollama; LLaVA for vision | Not stated | Fully local; webcam description | "Everything runs locally" is the whole model | S ([index](https://skillsllm.com/skill/j-a-r-v-i-s)) |
| Likhithsai2580/JARVIS | 149 | Python | "wakeword" tag; engines not named | Gemini key, g4f, local LLM | Not stated | OCR, image and slide generation. README calls itself outdated and points to MARK5 | None | S ([index](https://awesome.ecosyste.ms/projects/github.com%2Flikhithsai2580%2Fjarvis)) |
| AbuZar-Ansarii/Ultron | 143 | Python, OpenCV, SQLite | Hand-gesture wake; ASR not named; offline neural TTS | Gemini (API key) | Windows, macOS, Linux (claimed) | Writes, tests and loads new actions at runtime; mouse and keyboard takeover; 51 tools; Home Assistant | None described. Self-written code plus input takeover is the riskiest design in the list | S ([index](https://aiindigo.com/tool/ultron)) |
| Avinashb722/jarvis-ai-assistant | 138 | Python | "Voice recognition" | Not seen | Not seen | Face authentication, phone integration | Not seen | T |
| Aryan-0001/Jarvis-AI | 131 | Dart and Flutter (Android); Python (Windows) | `speech_to_text` and `flutter_tts`; `SpeechRecognition` and `pyttsx3` on Windows | Google Generative AI | Android, Windows | Two separate apps under one name; sends WhatsApp messages | None | S ([index](https://awesome.ecosyste.ms/projects/github.com%2Faryan-0001%2Fjarvis-ai), stale) |
| KKshitiz/J.A.R.V.I.S | 121 | Python, Tkinter, NLTK | Speech tags only | None | Not seen | Face recognition, home automation. Last update 2020 | None seen | T |
| LTripleP/heoster-jarvis-ai-assistant | 117 | HTML, Python; LangChain, Transformers | Not seen | Not seen | Not seen | Updated 2026-10-31 | Not seen | T |
| aerele/jarvis | 108 | Python on Frappe | None (not a voice assistant) | Not seen | Server (ERPNext) | "AI teammate inside ERPNext". Updated 2026-10-30 | Not seen | T |
| Adjacent, found by search, topic membership not confirmed: [vierisid/jarvis](https://github.com/vierisid/jarvis) | 673 | Bun and TypeScript "brain", React dashboard, **Go desktop sidecar** | Voice and wake word in the desktop app; engines not named | Anthropic, OpenAI, Gemini, OpenRouter, Ollama | Brain on Linux, macOS, WSL2, Docker; desktop app on Windows, macOS, Linux | Scheduled and event workflows, memory vault, browser and desktop control; 836 commits, 21 open issues; source-available licence, telemetry on by default | **"Authority" rules: allow, require approval, or block; approval requests; audit trail; Emergency Pause and Kill; an approved action interrupted by a restart is never rerun** | D |

Recently active in the top 20 (updated October 2026): javis-os, IRIS-AI, Capri-AI, Ultron, Aryan-0001, heoster, aerele, kishanrajput23. Five of the top 20 were last updated in 2023 or earlier.

**What most share**
- Python with `SpeechRecognition` and `pyttsx3`: the "wake word" is the word "Jarvis" found in a cloud transcript, not an on-device wake engine.
- A fixed if-else command list (open app, Wikipedia, time, jokes, music), with no LLM or one LLM behind an API key.
- A long feature list as the selling point (email, WhatsApp, downloads, face login), with no tests, no audit and no stated safety model.
- Windows first. Mac support is rare; a signed Mac build appears once.
- The 2026-active projects look different: TypeScript or Electron desktop apps, several LLM providers, MCP, memory files, schedules, chat channels, and (twice) a subscription CLI used as the brain. That last one is Stephen's ADR-003 choice, reached independently.

**What the best do that Stephen lacks**

| Idea | Seen in | Stephen today |
|---|---|---|
| A signed, notarized one-file install, with a fully offline speech mode | akshayaggarwal99 | No installer; distribution was a non-goal (U7) |
| One visible permission mode (ask, auto, read-only) plus allowed folders | Capri-AI | The gate is stronger but invisible: no single switch a regular user can read |
| Emergency Pause and Kill for everything; "interrupted approved action is never rerun" | vierisid | Esc cancels the current command; replayed-turn trust is an open item (Q9) |
| Memory as files with a change history that can be undone | javis-os | Memory is visible and editable; no history or undo |
| One codebase with a thin native sidecar on Windows, macOS and Linux | vierisid | Mac only; the helper is Swift |
| Local-model option for private or offline use | akshayaggarwal99, codewithbro95, javis-os | Claude only (U6) |
| Hold-a-key push-to-talk with a double-tap hands-free lock | akshayaggarwal99 | F5 hold exists; no hands-free lock |

**Common failure modes.** Issue trackers were not readable, so this list comes from what the projects disclose about themselves, and is weaker evidence than issues would be:
- Abandonment and rewrite churn: five of 20 untouched since 2023; one README calls itself outdated and points to a successor.
- Install pain on Windows: a PyAudio wheel is bundled in one repo and a Windows-only guide linked in another; one project needs a CUDA GPU.
- Unsigned installers: Capri-AI tells users to click through SmartScreen.
- Cost and limits: one README disclaims unwanted OpenAI charges; one reports long chats overflowing the context window.
- Announced but missing parts: speech-to-text "to do" in a voice assistant; a scheduler shown in examples but unchecked on the roadmap.
- Broad power with no control: mouse and keyboard takeover, self-written actions, shell access and "auto" modes with no described permission model. Install commands piped to a shell.
- Star counts that differ by a factor of two or more between pages fetched the same day (javis-os, Capri-AI). Do not use stars as a quality signal here.

**Where Stephen is ahead (stated without modesty or inflation).** No surveyed project describes a deterministic gate outside the model, taint tracking of private data, a rule that a spoken "yes" never approves, or a measured injection test. Stephen has all four, plus 3,148 tests and an audit record per command. The closest is vierisid's Authority rules, which are policy and approval, not data-flow tracking. Stephen is behind on everything a stranger meets first: install, onboarding, Windows, an offline option, and a community.

**Worth borrowing (all proposed, none displaces a P0)**
1. A visible safety mode and a global pause: show the gate's state as one setting a regular user can read, and one control that stops everything. Presentation of what exists, not a new mechanism.
2. A signed one-file install with guided first run, when U7 opens (section 9).
3. Memory history with undo: each "remember" and "forget" as a dated, reversible entry. Fits the owner-only memory rule.
4. The thin native sidecar pattern as the reference for Windows (section 9).
5. Hands-free lock on the push-to-talk key: small, after E4.

Not worth borrowing: self-written actions, input takeover, face login as a safety story, feature-count marketing, a local fine-tuned model as the brain.

---

## 3. Virtual Mac sandbox

### 3.1 What the owner saw: `govijr/terminal-mac`

**Correction to revision 2.** The earlier text guessed Lume and Cua. The owner's link is [govijr/terminal-mac](https://github.com/govijr/terminal-mac) (README read 2026-11-11). The category was right (a macOS virtual machine for agents); the project was wrong. It is not a text UI for the real Mac and not a terminal emulator: it is a real macOS guest whose screen is shown inside a terminal window.

| Aspect | What the README says |
|---|---|
| What it is | An "early release candidate" for Apple Silicon: runs a separate macOS virtual machine and shows its screen in a terminal, aimed at computer-use agents that see and control that virtual Mac |
| How it works | Apple's Virtualization framework runs the guest. A helper app inside the guest captures the screen and posts input events. A terminal viewer streams frames with the Kitty or iTerm2 graphics protocol (Ghostty, Kitty, iTerm2), only when the screen changes, up to 30 fps; other terminals get a native VM window |
| Agent interface | CLI with JSON output (screenshot, click, type, key, scroll) and MCP tools (screenshot, click, drag, scroll, type, key, status); a skill file and setup notes for Claude Code |
| Host and guest contract | Two shared folders: a read/write control folder (requests, screenshots) and a read-only tools folder. Requests travel as files in a mailbox with validation, size limits and expiry. No network listener. The helper refuses to run outside a virtual Mac. Agent input never moves the host pointer or clipboard |
| Isolation, in its own words | Not a hardened sandbox for hostile code. Guest networking is NAT, so the guest can reach the internet and possibly host or LAN services; `--offline` removes the network |
| Requirements | Apple Silicon, macOS 14 or later; Xcode 16 and Swift 6 only to build; first run downloads a macOS restore image; VM disk 64 GiB logical by default (grows on use). Memory need is not stated in the README |
| Guest setup | Manual: finish macOS setup in the guest, create a user, open the helper, grant Screen Recording and Accessibility inside the guest. The host needs neither permission. Unattended setup is listed as future work |
| Maturity | 2.1k stars, 130 forks, **10 commits**, 0 open issues and 2 open pull requests at fetch, MIT licence, Swift package with tests. Releases are self-signed, not notarized; the README says live testing on a clean Mac is still pending. Commit dates and the source tree could not be read from this session |
| Named future work | VM cloning, checkpoints, accessibility-tree snapshots, unattended guest setup, tmux transport |

Reading: a clean, honest, very young project (10 commits against 2.1k stars means attention ran ahead of history). It competes with Lume and Cua (31.7k stars, [GitHub](https://github.com/trycua/cua)), which remain the mature option in the same category. Related signals from revision 2 still hold: Claude Cowork runs its agent in a Linux VM on the Mac (4 cores, 4 GB RAM, 10 GB image) while its computer use runs on the real desktop [[Pluto Security]](https://pluto.security/blog/inside-claude-cowork-how-anthropics-autonomous-agent-actually-works/); Meta Muse runs in a cloud VM.

**Ideas Stephen could take from it**

| Idea | Value for Stephen | When |
|---|---|---|
| Use it as the Mac test rig (I12): a clean macOS guest driven through its MCP tools or JSON CLI | Repeatable fresh-install, TCC-prompt and `doctor` checks. Better fit than Lume for this because input goes through a guest helper and the host needs no permissions | One-day spike after Phase 3. Blockers to check: manual guest setup, microphone and key tap in a guest, memory on a 16 GB Mac |
| Demo surface: record Stephen working inside a guest shown in a terminal | A demo or injection-test recording with no private data on screen (F3) | With F3, only if the spike passes |
| Design pattern: file mailbox with validation, size limits and expiry; no listener; helper refuses to run in the wrong place | Matches Stephen's own posture (local socket, no inbound port). Useful wording and checks for C6 (authenticate helper.sock) | Reference only |
| "Agent input never touches the host pointer or clipboard" | The right containment rule if U8 ever flips | Only if U8 flips |
| README that states what it is not ("not a hardened sandbox") | The same honesty Stephen's published injection result aims for | F3 |

Not a reason to adopt it: a terminal or text UI for Stephen. Stephen's window is fixed as a native app (constraint 1), and terminal-mac's terminal is a viewer for a VM, not an interface style.

### 3.2 Options

| Option | What it is | Cost on the owner's Mac | Notes |
|---|---|---|---|
| terminal-mac | macOS guest VM shown in a terminal; MCP and CLI control through a guest helper | 64 GiB logical disk (grows); restore-image download; memory not stated | MIT; release candidate, 10 commits, self-signed, manual guest setup (3.1) |
| Lume / Cua macOS sandbox (Tart and UTM use the same framework) | macOS guest VM, unattended setup, agent drives it | Needs about 40 GB free disk and 8 GB free memory; first image pull 23 GB, about 8 min; later clones about 25 s [[Cua docs]](https://cua.ai/docs/lume/guide/getting-started/quickstart) | MIT for Lume. Apple's licence and kernel allow at most two macOS VMs at once |
| Linux VM or container (Cowork style) | Linux guest for code and files | About 4 GB RAM | No Mac apps. Stephen's jobs already get similar isolation from Seatbelt at near-zero cost |
| Cloud sandbox (Cua Spaces, Claude Code cloud session) | VM off the Mac | Subscription or usage | Work leaves the Mac; against "local data" positioning |
| Disposable browser profile | A separate, empty browser profile for untrusted sites | Near zero | Not a VM, but removes the main risk (cookies and sessions) for risky browsing |

Known guest limits (2023 source, may have changed): Apple ID and iCloud unsupported in guests, so most App Store apps do not run; disk writes are the main slowdown [[Eclectic Light]](https://eclecticlight.co/2023/09/14/current-limitations-on-macos-virtual-machines-running-on-apple-silicon-macs/).

### 3.3 Evaluation for Stephen

| Question | Answer |
|---|---|
| Does it make risky computer use safe? | Yes for the host: clicks, installs and file damage stay in the guest. But Stephen has no cursor or Accessibility control (U8, out of scope), so there is nothing risky of that kind to contain today |
| Does it fix the Zen bot-check and sign-in loop? | No. The cause (plan 8.4) is the automation protocol setting `navigator.webdriver`; that travels into the VM. A fresh guest is also a new device with no sessions, which tends to trigger more checks, not fewer. Logging the owner's Google account into a disposable guest is worse for security, not better |
| Does it protect private data? | Only if the guest has none. A useful agent needs the accounts; then the guest holds the same secrets, and the taint gate, not the VM, is what stops them leaving |
| Resource cost | About 8 GB RAM while running (Lume's figure; terminal-mac states none), on top of speech models and warm Claude processes; plan trigger 5.4 already caps idle footprint near 1 GB. **Re-checked against the owner's Mac:** a MacBook Pro 14-inch with the base M5 ships with 16 GB (24 or 32 GB configurable) [[Apple]](https://support.apple.com/125405); M5 Pro or Max tiers ship with more (not fetched). He should confirm under Apple menu > About This Mac (the "Memory" line). On 16 GB an 8 GB guest takes half the machine while macOS, Zen, Chrome and Stephen share the rest: expect memory pressure and swap, which also hurts the latency targets. So on 16 GB: no always-on guest; a test-rig guest only for short sessions with browsers closed. On 24 GB or more the cost is tolerable but the other rows still decide |
| Latency | About 25 s to clone; screenshot-style control inside a guest is the slow pattern Google abandoned |

### 3.4 Verdict (updated 2026-11-11)

**Not now, and not as a fix for Zen.** Reading the real link did not change the verdict; it sharpened it. terminal-mac is a macOS VM for computer-use agents, which is the capability U8 keeps out of scope. Stephen's safety comes from a narrow tool set and a deterministic gate, which is cheaper and stronger than putting a broad agent in a box, and terminal-mac itself says it is not a hardened sandbox.

Worth it when one of these holds:
1. U8 flips (cursor or Accessibility control of apps): then a guest is the right place to develop and test it, and terminal-mac's "input never touches the host" rule is the model.
2. Jobs need to run untrusted installers or GUI apps that Seatbelt cannot confine.
3. As a **test rig** (I12): a clean macOS guest to run parts of the Mac test plan repeatably (fresh install, TCC prompts, `doctor`). terminal-mac is the first candidate because it already speaks MCP and needs no host permissions; Lume is the fallback because it has unattended setup. Caveats: key taps, audio capture and Keychain behaviour in guests are unverified; guest setup is manual; the project has 10 commits; a 16 GB Mac limits it to short sessions. This needs a one-day spike before any promise.

Cheaper step first: a disposable browser profile for "open this unknown link" tasks (I7).

---

## 4. Multi-agent and multi-LLM

### 4.1 What the trend is

- **Model councils:** Perplexity's Model Council (2026-02-05, Max tier) runs one query on three models and has a synthesizer report agreement and disagreement [[Perplexity]](https://www.perplexity.ai/hub/blog/introducing-model-council). Several aggregator apps copy this.
- **Parallel coding agents:** Google Antigravity 2.0 (May 2026) runs parallel agents and sub-agents; Google reports a practical limit of 4 to 5 before quality drops; per the guide read it defaults to Gemini and is not a multi-vendor router [[o-mega guide]](https://o-mega.ai/articles/google-antigravity-2-0-the-complete-2026-guide).
- **"Reasoning networks":** no specific product or paper by this name was found; treated as a label for the two items above. Unverified.

### 4.2 Evidence: useful vs hype

Figures as reported by one October 2026 review of the literature [[Yage]](https://yage.ai/share/multi-agent-what-it-buys-en-20261021.html); original papers not re-read.

| Claim | Evidence | Verdict |
|---|---|---|
| Multi-agent is smarter | Anthropic: token usage explained about 80% of score variance on a browsing benchmark; multi-agent works mainly because it spends enough tokens. About 4x chat tokens for a single agent, about 15x for multi-agent | Hype as stated. It buys coverage, not intelligence. New failure classes too (MAST: step repetition 15.7% of failures) |
| Parallel agents are faster | Reported: four parallel agents about halve time at about double price, only for truly parallel work | Useful for wide research; useless for a voice command |
| Teams beat solo agents | Vals AI: about +15 points on hard tasks, about +1 on easy; cost 1.8x to 5.1x; one of four comparisons significant | Useful only for hard, broad tasks |
| A fresh reviewer catches more | Cognition (April 2026): a review agent with clean context often catches bugs the author missed | Useful, cheap: one extra pass |
| Many vendors in one app is better | Council shows disagreement, which is informative for research questions | Useful for opinion and research; irrelevant for acting on accounts |

### 4.3 Implications for Stephen

- **Latency:** Tier 1 is already zero model turns; no router beats that. For Tier 2 the only lever is a smaller model: on API benchmarks Claude 4.5 Haiku shows 0.98 s to first token and 100 tokens per second against 1.49 s and 55 for Sonnet 4.5 [[Artificial Analysis]](https://artificialanalysis.ai/models/comparisons/claude-4-5-haiku-vs-claude-4-5-sonnet). API numbers for one model generation; Stephen's CLI path must be measured by A2.
- **Safety gate:** the gate does not trust the model, so a model swap does not weaken the guarantee. Stephen can try cheaper models with less risk than gate-less agents. Task success can still drop, so the eval (D3) decides.
- **Warm process:** one warm `claude -p` per conversation with a fixed model. Routing happens at conversation start, or costs a second warm process (about 270 MB).
- **Multi-agent and taint:** taint is tracked per serve instance. Sub-agents that read accounts would need shared taint and more complex rate limits and audit. Inside a job the problem does not exist: jobs have no MCP and no network writes.
- **Multi-vendor and U6:** Grok, Gemini or GPT need API keys (against U6), and each vendor becomes a new recipient of prompt contents. The repo's `jev/` OpenRouter router should stay off the private-data path.
- **Subscription stability (a flag, not a reopen):** in 2026 Anthropic blocked plan logins in third-party harnesses (April 4), announced a separate credit pool (May), then paused it (June 15) [[secondary]](https://www.betterclaw.io/blog/openclaw-anthropic-subscription-ban). The help centre (updated 2026-10-07) says the Agent SDK and `claude -p` "still draw from your subscription limits" on a plan login [[Anthropic help]](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Multi-agent on a subscription burns the pool the voice loop needs.
- **Re-evaluation against the owner's plan (Claude Pro, answered 2026-11-11).** What Anthropic's help pages say (read 2026-11-11; neither shows an exact date): Pro has "a five-hour session limit and a weekly limit"; the limits "are shared across Claude and Claude Code"; usage depends on conversation length, features, the model chosen and the effort level, and "tools and connectors are token-intensive"; at the limit the choices are to wait for the reset or enable usage credits (paid) [[Claude Code with a plan]](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan), [[usage limits]](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work). Unverified, because the pages give no numbers: how many voice turns or jobs fit in a Pro session, which models Pro allows in Claude Code, and how much less a smaller model draws. Consequences:
  1. Stephen shares one Pro pool with the owner's own Claude chat and Claude Code use (coursework, thesis). A limit hit silences the voice loop until the reset. `doctor` and the window must show "plan limit reached, resets at ..." as its own state, not as a failure (fold into A8 and I16).
  2. Research mode with sub-agents (I9) at about 15x chat tokens can plausibly use up a five-hour session in one job. On Pro it drops to low priority: off by default, one job at a time, a visible budget, and a recommendation not to run it before a period when voice is needed.
  3. Model routing (I8) gains a second reason beyond speed: lighter turns should draw less from the pool. The size of the saving is unmeasured; A2 should record tokens per turn so the monitor can show it.
  4. The smallest tool profile (E3) and prompt size (42 KB per turn today) now matter for limits as well as latency.
  5. Jobs default to the everyday model; a stronger model or higher effort is an explicit owner choice per job, shown with a warning on Pro.
  6. For a public product this does not scale as is: every user would need a Claude plan and their own limits (section 9.4).

### 4.4 Routing proposal per tier

| Request class | Model | Why | Condition to adopt |
|---|---|---|---|
| Tier 1 commands | None (deterministic fast path, E1) | Only route under 3 s | Already planned |
| Tier 2 "light": one read-only question, briefing readout, chat titles | Smaller Claude model (Haiku class), low effort | Faster first token; cheaper on plan limits | A2 shows at least 300 ms saved per turn and D3 eval rate holds (no category under 90%) |
| Tier 2 "work": multi-step browser or account tasks | Sonnet (today's default) | Proven by current eval | Keep |
| Jobs (ADR-004) | Owner's picker; default the everyday model; stronger model or higher effort is an explicit choice (warned on Pro) | No latency pressure, but plan limits apply | After A5 (`fix/model-everywhere`) |
| Research mode inside a job | One lead plus 2 to 3 sub-agents, plus one clean-context reviewer pass | Where the evidence shows gains | Opt-in per job, shown in the start dialog with a budget; never in the voice loop; low priority while the owner is on Pro (4.3) |
| Second opinion from another vendor | Not in core | U6, privacy | Only as a future bet, for untainted questions, with explicit owner opt-in |

### 4.5 Verdict

Routing within one vendor: **useful, cheap, measure first.** Multi-agent: **useful only as an opt-in job mode, and rarely on a Pro plan.** Many vendors in one app: **skip for the core; it trades Stephen's two differentiators (no extra subscription, private data stays put) for a feature general chat apps already do better.**

---

## 5. Persona map

Idea IDs refer to section 6.

| Persona | Top 3 jobs-to-be-done | Ideas that serve them | Fit with fixed decisions |
|---|---|---|---|
| Student | 1. Know what is due and what changed, without opening five sites. 2. Get a head start on assignments and readings while away. 3. Stay focused: hands-free music, timers, quick lookups | I1 scheduled briefing, I2 assignment tracker, I3 away report, I9 research job mode, Tier 1 commands (existing) | All read-only; fits |
| Worker | 1. Walk into each meeting prepared. 2. Triage inbox and calendar by voice; draft, not send. 3. Offload errands that need a phone call | I4 meeting prep, I1, I3, I5 call me, I6 business calls (later), ADR-006 drafts (parked) | 1 and 2 fit; 3 conflicts with U5 |
| Regular user | 1. Fast, reliable everyday commands. 2. "Call and ask" errands: reservations, stock checks, appointments. 3. Trust: know it will not leak or act on its own | Tier 1 fast path (E1), I6, I7 disposable browsing, published injection result (F3) | 1 and 3 are the current plan; 2 is Phase 4 |

Reading: the student persona is fully served by read-only features, and the owner is that user today. The worker persona needs ADR-006. The regular user needs the Tier 1 work first; calls are their headline feature but arrive last.

**Owner decision (2026-11-11):** the target is regular users on Mac, then Windows; students are a small segment. So the regular-user row sets priorities from here: fast reliable commands (E1, E6), visible trust (F3, a readable safety mode), and an install a stranger can finish. Canvas features (I2) stay valuable for the owner and as a student add-on, not as the headline. Business calls stay the regular user's eventual headline, but the owner rates them low for himself, so they remain a distant bet (I6).

---

## 6. Idea scorecard

Value per persona: S student, W worker, R regular user (H, M, L). Effort: S under 1 day, M 1 to 3 days, L a week or more. Priority is within the new-ideas lane, never above existing P0s.

| ID | Idea | Value S/W/R | Differentiation | Effort | Risk | Conflict with fixed decisions | Phase | Pri |
|---|---|---|---|---|---|---|---|---|
| I1 | Scheduled daily briefing, owner-set time; scheduling is an opt-in setting, off by default (owner, 2026-11-11) | H/H/M | Same feature as rivals, but read-only under taint and measured | M | Low | None (extends D2) | 2a | High |
| I2 | Assignment tracker from Canvas (due, changed, new) | H/L/L | No reviewed product covers Canvas | M | Low | None | 2a | High |
| I3 | Away report: job and briefing results pushed to the phone. **Allowed: the owner ruled that messaging him is OK** | H/H/M | The "Jarvis moment" without autonomy | M | Medium: private data in a push | None (owner decision 1); builds on ADR-004, ADR-005 | 3 | High |
| I4 | Meeting prep: next event plus related mail and Notion | M/H/L | Cross-source under one gate | M | Medium: mixes private sources | None | 3 | Medium |
| I5 | "Call me": alerts and very urgent items only, to the owner's one verified number (owner decision 1: allowed, future, not near-term) | M/M/M | OpenClaw's trick, limited to one verified number | M | Medium: voice vendor hears the message; needs a definition of "urgent" the model cannot widen | New channel (freeze) | Future bet | Low to Medium |
| I6 | Brief-bound calls to businesses (2.6). **Demoted:** low value for the owner; kept as a distant bet for regular users, after reply drafts (ADR-006) | L/H/H | Strongest: disclosed AI, brief-only facts, transcript, takeover | L | High: TCPA and ADAD, recording, binding agreements | Conflicts with U5 | Distant future bet, after ADR-006 | Low |
| I7 | Disposable browser profile for untrusted links | L/M/M | Simple, honest containment | S to M | Low | None | 3 | Medium |
| I8 | Model router: smaller model for light Tier 2 | M/M/M | Invisible; supports the speed pitch | S to M | Low for safety; task success may drop | None (stays on `claude -p`) | 2b | Medium |
| I9 | Research job mode: sub-agents plus reviewer in the job sandbox | H/M/L | Sandbox and budget dialog | M | High on a Pro plan: can use up a five-hour session (4.3) | None if opt-in per job | Future bet | Low while on Pro |
| I10 | Reviewer pass on job results: done, unverified, failed | M/M/L | Honest status | S | Low | None | 3 | Medium |
| I11 | Routines: owner-written scheduled jobs; a user opt-in setting, off by default (owner decision 6) | M/H/M | Approved once, listed in the window, capped | M to L | Medium: unattended runs | Must be owner-written (model-written jobs are a non-goal) | Future bet | Medium |
| I12 | macOS VM as a Mac test rig; try terminal-mac first, Lume as fallback (3.4) | developer value | None | spike S | Low; short sessions only on 16 GB | None | Future bet | Low |
| I13 | macOS VM sandbox for computer use | L/L/L | Me-too | L | Medium; 8 GB RAM | U8 | Not planned | Low |
| I14 | Multi-vendor council | M/M/L | None; chat apps do it better | M | High: privacy, API keys | U6 | Future bet, untainted only | Low |
| I16 | Plan-rule watch in `doctor`, including a clear "plan limit reached" state (4.3) | reliability | None | S | Low | Supports U6 | 1.9a (in A8) | High |
| I17 | Portability seam: every macOS-only call behind one platform layer; a rule plus a lint, not a rewrite (9.3) | product reach | Enables Windows at low cost | S to M | Low | None | 3 | Medium |
| I18 | Windows feasibility spike: core, voice stack and one browser task on a Windows PC (9.2) | product reach | None | M | Low (throwaway) | None | Late, after 3 | Low |
| I19 | Visible safety mode and global pause (2.7) | L/M/H | Shows the gate to regular users | S to M | Low | None (presentation of existing rules) | 3 | Medium |
| I20 | Memory history with undo (2.7) | M/M/M | Reversible, owner-only memory | S | Low | None | 3 | Low |

---

## 7. Trade-offs and decisions

**T1. How to deliver the "Jarvis" feeling**

| Option | Pros | Cons |
|---|---|---|
| A. Away mode: scheduled briefing plus job reports to the phone (I1, I3, I10) | Read-only; built on shipped ADRs; daily value; testable | Less dramatic than a phone call |
| B. Business calls now (I6) | Headline demo | Breaks U5; legal open points; AI-only success reported well below human; new vendor |
| C. Nothing new until Phase 4 | Maximum focus | No answer to the market signal the owner is seeing |

Recommendation: **A**, scheduled after the 1.9 exit and 2b. Owner decisions 1 and 6 clear it: messaging the owner is allowed, and scheduling is an opt-in setting. B is demoted (owner decision 2): when U5 is revisited, reply drafts (ADR-006) come first; the ADR for business calls is written only after that, as a distant bet for regular users.

**T2. If calls are ever built: buy or build the voice stack.** A hosted platform (Vapi, Retell, ElevenLabs Agents) takes days, claims sub-second turns and costs cents per minute, but audio goes to a vendor. An own stack keeps the data path, but Stephen's model turn (about 1.8 s) is far past the 1 s "feels broken" line. Recommendation: hosted, with the brief-only rule keeping vendor exposure small. Choose the vendor inside the ADR.

**T3. "Call me" (I5) vs push for reports.** Push through the existing phone channel has no new vendor, cost or legal surface. A call is more "Jarvis" but adds all three. Recommendation: push first. Owner decision 1 confirms both are allowed, with "call me" reserved for alerts and very urgent items, in the future. Conditions for that later build: "urgent" is an owner-written rule (for example a named sender, a deadline inside N hours), never a model judgment; one verified number; non-private wording.

**T4. VM sandbox**

| Option | Pros | Cons |
|---|---|---|
| macOS VM for agent tasks | Strong host isolation | 8 GB RAM, 40 GB disk; does not fix bot checks; nothing to contain while U8 stands |
| Disposable browser profile (I7) | Near-zero cost; isolates sessions | Not a full sandbox |
| VM as test rig only (I12) | Repeatable Mac checks | Mac-only paths may not work in a guest; needs a spike |

Recommendation: I7 in Phase 3; a one-day I12 spike as a future bet; no agent VM.

**T5. Model routing**

| Option | Pros | Cons |
|---|---|---|
| One model everywhere (today) | Simple; one eval | Light turns pay Sonnet latency |
| Per-class routing inside Claude (I8) | Possible 0.3 to 0.5 s per turn on light requests (API benchmark, unmeasured here); fewer plan-limit hits | Second warm process or routing only at conversation start; second eval column |
| Multi-vendor routing | Access to any model | U6, privacy, key management, several evals |

Recommendation: **I8 as an experiment after E1**, adopted only on A2 and D3 numbers. No multi-vendor.

**T6. Multi-agent**

Recommendation: never in the voice loop; opt-in research mode in jobs (I9) with a visible budget; adopt the single reviewer pass (I10) first, since it is the cheapest piece with evidence behind it.

**T7. Subscription path (U6)**

Stay on `claude -p` as decided. Add I16 to A8 so a billing or policy change shows up in `doctor` rather than as a silent failure, and keep the design from blocking a later API-key path (already the plan's 5.4 note). The stated reason for flagging: three policy changes in seven months.

---

## 8. Owner decisions (2026-11-11) and open technical questions

**Owner decisions** (source: `OWNER-ANSWERS-2.md`, authoritative)

| # | Question | Decision | Effect |
|---|---|---|---|
| 1 | May Stephen message or phone the owner with results? | Yes to both. "Call me" only for alerts or very urgent items, and in the future, not near-term | I3 away report allowed (Phase 3). I5 stays a future bet, alerts only |
| 2 | When U5 is revisited, drafts or calls first? | Reply drafts (ADR-006) first. He is a student and has little use for business calls | I6 demoted to a distant bet for regular users |
| 3 | Who is the product for? | Both Mac and Windows users. Mac first, then Windows. Regular users; students are a small segment | New section 9. Tier 1 reliability, visible trust and install lead; Canvas is an add-on |
| 4 | Hardware and plan | MacBook Pro 14-inch, M5-family chip, RAM not found. Claude Pro | VM conclusion re-checked against 16 GB (3.3); multi-agent and routing re-checked against Pro limits (4.3). To confirm RAM: Apple menu > About This Mac |
| 5 | Which posts? | [github.com/topics/jarvis-ai](https://github.com/topics/jarvis-ai) and [govijr/terminal-mac](https://github.com/govijr/terminal-mac) | Studied in 2.7 and section 3 |
| 6 | Scheduled runs | The user's choice: an opt-in setting | I1, I11: scheduling off by default, enabled in Settings, each routine listed in the window |

Still open for the owner (small): the exact chip tier and RAM; whether an away report may contain private content or only a "ready, open Stephen" notice.

**For Claude Code**

1. Can the Remote Control phone session receive a Stephen-initiated message or push, or only request and reply? Alternatives with no inbound port?
2. Can a schedule start a job without weakening "dialog per start" (a one-time approval bound to the exact task text and budget)?
3. Latency and RSS of two warm processes (light and work model), and the effect on conversation continuity?
4. Time to first token and turn time for the Haiku-class model through `claude -p` on the owner's Mac, on the A6 replay set?
5. Do the eval pass rate and injection attack success rate change with the smaller model?
6. Can `doctor` tell which billing pool a `claude -p` run used without reading Claude Code internals?
7. In a macOS guest, which Mac-only paths work: key tap, microphone, Seatbelt, Keychain, TCC prompts?
8. For a brief-bound call, what is the smallest design where the call agent provably has no tools, memory or accounts, and the outcome is audited by command id? (Now low priority.)
9. How many files outside one platform layer call macOS-only commands today, and can a lint keep that number from growing (9.3)?
10. Does Claude Code's OS sandbox for jobs exist on Windows, and does `claude -p` on a plan login behave the same there?
11. What do tokens per voice turn and per job look like against a Pro five-hour session (4.3)?

---

## 9. Mac then Windows: implications

Owner decision 3: support Mac and Windows, Mac first, for regular users. This section gives criteria and options, not a design. Repository facts come from a scan of the `qa` copy on 2026-11-11 (about 39,700 lines of TypeScript in `src/`, about 6,300 lines of Swift in `helper/`). Windows facts marked "unverified" are general knowledge not fetched in this session.

### 9.1 What is portable and what is Mac-only

| Component | Today | Portable? | Note |
|---|---|---|---|
| Orchestrator, command routing, tiers, conversation, timers logic, memory store, audit, config | TypeScript on Node | Yes | Paths under one data root already (U7 rule); the root itself moves from `~/Library/...` to a per-platform location |
| Safety gate, taint, policy | TypeScript inside serve | Yes, unchanged | The strongest reason to keep the core: nine reviews of evidence carry over to Windows for free |
| MCP tools and server (`@modelcontextprotocol/sdk`, `zod`) | TypeScript | Yes | |
| Browser control for Chrome (`puppeteer-core`, CDP) | TypeScript | Yes | Profile and executable discovery is per platform (`src/drivers/macos.ts` holds the Mac paths: the seam already exists here) |
| Zen with WebDriver BiDi | TypeScript plus `zen-launcher` | Partly | Zen ships for Windows (unverified here); launcher and profile paths are Mac-specific. Regular users mostly use Chrome or Edge, so Chrome-family first on Windows |
| YouTube Music | Browser tab control plus Mac app and volume calls | Partly | The tab control is portable; open, focus, volume and mute go through `osascript` and `open` |
| Audio capture (`@picovoice/pvrecorder-node`) | Native Node addon | Likely | The package publishes Windows builds (unverified here) |
| Wake word, VAD, ASR, Kokoro TTS (`sherpa-onnx-node`) | Native Node addon | Likely, speed unknown | Windows builds exist (unverified here). Accuracy and speed were chosen on Apple Silicon; typical Windows laptops must be measured |
| Cloud TTS (ElevenLabs) | HTTPS | Yes | |
| Claude through `claude -p` | CLI | Likely | Claude Code runs on Windows (unverified here); warm-process behaviour and plan login need a check |
| Stephen window, Ask box, settings, pages | Swift helper app | **No** | The whole UI |
| F5 key tap, Esc cancel | Swift helper | **No** | Global hotkey API differs |
| App and system verbs (open app, volume, mute, notifications) | `osascript`, `open` (8 files reference `osascript`) | **No** | |
| Confirmation dialogs outside the window | `osascript` in `safety/confirm.ts` | **No** | Trust-critical: the replacement must be as hard to spoof |
| Secrets | macOS Keychain through the `security` command | **No** | |
| Audio playback and system voice | `afplay`, `say` | **No** | |
| Jobs sandbox (ADR-004) | OS sandbox around Bash (Seatbelt on Mac); the runner fails closed when no sandbox exists | **No**, unknown on Windows | Jobs may be unavailable on Windows at first; failing closed is the right default |
| Helper link | Unix socket (`helper.sock`) | Small change | Named pipes on Windows |
| Permissions and `doctor` checks (TCC: microphone, input monitoring) | Mac-specific | **No** | Windows has a different, looser model |
| Apple SpeechAnalyzer (a 5.4 trigger candidate) | Not adopted | **No** | Adopting it would fork the voice stack per platform |

### 9.2 What a Windows port needs (options and criteria, no choice made)

| Need | Options | Criteria to choose |
|---|---|---|
| Native shell (window, tray, Ask box) | (a) One cross-platform UI for both systems (Electron or Tauri class). (b) Keep Swift on Mac and add a separate Windows app (WinUI or .NET class). (c) A thin native helper per platform plus a shared web-rendered window | Constraint 1 says "native Stephen window": does a cross-platform UI still count? Cost of two UIs to maintain for one developer; idle memory against the 1 GB trigger; whether approval dialogs stay unspoofable; accessibility and system-voice-over support. Evidence from 2.7: vierisid ships one brain with a thin Go sidecar on three systems; akshayaggarwal99 is TypeScript with native addons and still Mac-only after 114 commits |
| Audio capture | Keep `pvrecorder-node`; or native capture in the Windows shell | Works with Bluetooth headsets and device changes; echo cancellation available or not |
| Wake word and ASR | Keep sherpa-onnx on CPU; add GPU or NPU acceleration; cloud ASR as an option | Tier 1 targets on a mid-range Windows laptop (not the owner's M5); accuracy on the replay set; model download size |
| TTS | ElevenLabs; Kokoro; Windows system voices | First-audio latency, cost per user, licence (F5) |
| Global hotkey and cancel | System hotkey registration; keyboard hook in the shell | F5 is often a browser refresh key on Windows: the default key may need to change; must not need administrator rights |
| Credential storage | Windows Credential Manager or DPAPI through a small native call | Same guarantees as Keychain use today: no secret in files, no secret in model context |
| App and system verbs | PowerShell or Win32 calls behind the same verb list | Same closed verb set; no general shell |
| Jobs sandbox | Whatever Claude Code offers on Windows; WSL; or no jobs on Windows v1 | Never run a job without an OS sandbox |
| Install and update | Signed installer; store listing | See 9.4 |

A late, throwaway **Windows feasibility spike** (I18) answers the unknowns cheaply: does the core start, do the two native addons load, what are ASR time and Tier 1 latency on a plain Windows laptop, does `claude -p` stay warm, does one Chrome task pass the gate. One week at most, no UI.

### 9.3 Effect on the language verdict

- **It strengthens "keep the TypeScript core".** The parts that carry Stephen's value (gate, taint, tools, routing, audit, evals) are already in a language that runs on both systems. A Swift or Rust rewrite of the core would have to be done twice or would lock the product to one platform.
- **It weakens the "audio front end to Swift" trigger.** Moving capture, wake and ASR into Swift (plan 5.4) would now create a second voice stack to build and tune for Windows. The trigger stays, but it gains a fifth criterion: the gain must be worth a platform fork, or the same capability must exist on Windows.
- **It argues for thin platform code as a rule.** Criteria for the seam (I17): (1) every macOS-only call (`osascript`, `open`, `security`, `afplay`, `say`, TCC checks, Mac paths) lives behind one platform layer with a small, named interface; (2) nothing above that layer imports it directly; a lint or test fails the build if a new call appears elsewhere; (3) the Swift helper holds only what must be native (window, hotkey, dialogs) and no product logic, so a second shell is small; (4) the helper protocol stays the single contract between core and shell; (5) no behaviour change and no Windows code now. This is cheap while the code is being touched anyway (C5 splits the Swift file; B3 moves owner data) and expensive later.
- **It does not justify cross-platform work before the Mac product is right.** The freeze and the phase order stand.

### 9.4 Regular users: decisions to flag for later

"Regular users" turns several non-goals (plan 2.3, U7) into decisions with an order. None is designed here.

| # | Decision | Why it is real | Options to weigh | When |
|---|---|---|---|---|
| 1 | Platform seam rule (I17) | Free now, costly later | Adopt the 9.3 criteria as a coding rule | Phase 3 (proposed) |
| 2 | How each user reaches Claude, and who pays | Today every user needs a paid Claude plan, Claude Code installed and signed in, and shares that plan's five-hour and weekly limits with their other Claude use (4.3). That is a heavy first step for a regular user. Also a policy risk: Anthropic blocked plan logins in third-party harnesses in April 2026 (4.3, secondary source); whether a distributed Stephen counts as one is **unverified and must be checked with Anthropic's terms before any public release** | (a) Bring your own Claude plan (today, U6). (b) Bring your own API key. (c) Stephen-provided access billed by Stephen (needs accounts, billing, a server; changes the privacy story). Mixed: (a) for early users, (c) later | Before the first external user; it shapes everything after |
| 3 | Mac distribution: signing, notarization, installer, updates | A regular user cannot run an unsigned app without warnings; 2.7 shows the cost of skipping this (SmartScreen click-through, self-signed releases) | Developer ID and notarized DMG; update channel; whether Node, models and the helper ship as one bundle | Before the first external Mac user |
| 4 | Onboarding | Today's setup needs a terminal, model downloads, browser connection and several permissions | Guided first run: microphone and key permissions, speech model download, Claude sign-in, browser connect, a test command; `doctor` as the engine behind it | With 3 |
| 5 | Authentication and authorization (U7) | Multi-user and any Stephen-side account | Local-only single user per OS account first; accounts only if decision 2 picks (c) | After 2 |
| 6 | Privacy and legal for a product | Section 2.4: organization rules apply once it is a product (notice, purpose, retention); telemetry choice | Opt-in telemetry only; published data-flow statement | Before public release |
| 7 | Windows feasibility spike (I18), then the shell choice (9.2) | Unknown hardware performance and CLI behaviour | See 9.2 | Late: after Phase 3 and after Mac has external users |
| 8 | Windows signing and distribution | Same reason as 3 | Code-signing certificate, installer, store | Only if 7 says go |

Recommended order: 1, 2, 3 with 4, 5, 6, 7, 8. The reasoning: 1 costs almost nothing and protects every later step; 2 decides whether the product is viable for regular users at all, and what auth must protect; 3 and 4 are what the first stranger meets; Windows comes last because every item above it is shared by both platforms.

---

## 10. Proposed additions to the task table

Every row is **proposed, owner to approve.** None starts before the 1.9 exit; the freeze on new tools, channels and integrations stands. IDs continue the plan's letters; G is a new "future bets" lane.

| ID | Task | Impact | Effort | Depends on | Pri | Phase |
|---|---|---|---|---|---|---|
| A10 | Plan-rule watch in `doctor`: report billing pool, warn on change (I16; fold into A8) | M | S | A8 | P1 | 1.9a |
| D5 | Scheduled briefing: owner-set time, read-only, waiting in the window (I1); opt-in setting, off by default | H | M | D2 | P1 | 2a |
| D6 | Assignment tracker view from Canvas (I2) | H (student) | M | D3 | P2 | 2a |
| E9 | Model routing experiment for light Tier 2, decided on A2 and D3 numbers (I8) | M | S to M | A2, E1, D3 | P2 | 2b |
| F6 | Away report: job and briefing results to the phone, wake-trust content rules (I3); allowed by owner decision 1 | H | M | C1, D5 | P1 | 3 |
| F7 | Reviewer pass and honest job status (I10) | M | S | A5 | P2 | 3 |
| F8 | Disposable browser profile for untrusted links (I7) | M | S to M | D4 | P2 | 3 |
| F9 | Meeting prep flow, read-only (I4) | M (worker) | M | D3 | P2 | 3 |
| F10 | Portability seam: macOS-only calls behind one platform layer, with a lint; no behaviour change (I17, 9.3) | M | S to M | C5, B3 | P2 | 3 |
| F11 | Visible safety mode and global pause in the window (I19) | M | S to M | C2 | P2 | 3 |
| F12 | Memory history with undo (I20) | L | S | B2 | P2 | 3 |
| G1 | ADR-007 draft: brief-bound business calls, threat model, legal checklist (I6); paper only; after ADR-006 reply drafts (owner decision 2) | M (later) | M | ADR-006 decided | distant bet | not scheduled |
| G2 | "Call me" for alerts and very urgent items only, one verified number, owner-written urgency rule (I5) | M | M | F6 | future bet | 4 gate |
| G3 | Routines: owner-written scheduled jobs, opt-in setting, approved once, capped (I11) | M | M to L | F6 | future bet | 4 gate |
| G4 | Research job mode with sub-agents and a budget in the start dialog (I9); low priority on a Pro plan | L | M | F7 | future bet | after 3 |
| G5 | Spike: macOS guest as a Mac test rig, terminal-mac first (I12) | L | S | A1 | future bet | after 3 |
| G7 | Windows feasibility spike: core, voice addons, `claude -p`, one gated Chrome task; throwaway, no UI (I18, 9.2) | M (reach) | M | F10, Phase 3 exit | future bet | late, after 3 |
| G8 | Decision paper: how users reach Claude and who pays; check Anthropic terms for distributed use (9.4 item 2) | H (product) | S | none (paper) | future bet | before any external user |
| G6 | Second-opinion council, untainted questions only (I14) | L | M | U6 revisit | future bet | not scheduled |

Not proposed: agent VM (I13). Considered and dropped: hold-for-me on the owner's own calls and missed-call summaries (both need telephony access Stephen lacks).

---

## 11. Sources

All external sources are linked inline where used. Reliability notes:

- Primary or official: Microsoft JARVIS repo, Cua repo and docs, CRTC rules page, Office of the Privacy Commissioner, Perplexity blog, Anthropic help centre (three articles), Apple tech specs, Artificial Analysis, the GitHub topic page, and the four repository pages marked D in 2.7 plus terminal-mac's README and issue list.
- Reputable press: TechCrunch, TechSpot, Fox News.
- Secondary or vendor (treat figures as claims): Morph (platform prices and latency), Layer3 Labs (relays Reuters on Meta's test calls), Silverton (TCPA summary), Treadstone (Canadian ADAD reading), Yage (relays Anthropic, Cognition, MAST, Vals AI), BetterClaw (policy timeline), o-mega (Antigravity guide), the OpenClaw call tutorial (affiliate links).
- Legal commentary: David Fraser, Canadian Privacy Law Blog.
- Listed but not fetched: FCC 24-17 text (https://docs.fcc.gov/public/attachments/FCC-24-17A1.pdf); the X post and the OpenClaw issue (titles only).
- Third-party indexes used for 2.7 rows marked S (SkillsLLM, ecosyste.ms, AI Indigo): automated listings, sometimes stale, one sells placements. Treat as claims.
- Not reachable: X and LinkedIn posts (no claim rests on one); the GitHub API; most repository pages, issue trackers, commit history and source trees for 2.7 and terminal-mac.
- Internal: `OWNER-ANSWERS-2.md`, a scan of the `qa` repo copy, `PRODUCT-PLAN-2026-11.md`, `INVENTORY.md`, `docs/ADR-004-jobs-while-away.md`, `docs/ADR-005-phone-channel.md`, `docs/ADR-006-reply-by-voice.md`.
