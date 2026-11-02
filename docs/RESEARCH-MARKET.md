# Market research: what Stephen signals to employers (as of Nov 2026)

Method: standard WebSearch, 6 queries. Sources are mostly individual job postings, career blogs and vendor
content, not aggregate hiring data. Treat patterns as indicative. Claims I could not verify are marked so.
Facts about Stephen come only from README.md and docs/SYSTEM-DESIGN-STEPHEN.md.

## 1. What employers ask for around LLM agents

Recurring patterns in postings:

- MCP servers and governed tool layers. A General Catalyst contract role wants people who build MCP servers and
  tool layers giving agents governed access to company data
  ([posting](https://jobs.generalcatalyst.com/companies/remote/jobs/96837333-senior-ai-engineer-remote-contract)).
  An Upwork agentic role asks for MCP servers that securely expose tools, APIs and documents
  ([posting](https://www.upwork.com/freelance-jobs/apply/Agentic-Engineer-MCP-A2A-RAG-Production-LLM-Systems_~022082036539400908402/)).
  One hiring guide calls "never shipped an MCP server" a yellow flag in 2026
  ([callmissed](https://www.callmissed.com/en/blog/hiring-ai-engineers-2026)); single blog, low weight.
- Evals. A senior role requires LLM evaluation systems with datasets, regression testing and benchmarking
  ([Lever](https://jobs.lever.co/jobgether/85f64172-e513-47c2-bdfe-51e2a2827335)). The Upwork post asks for golden
  datasets, adversarial cases and red-team tests. A 2026 roadmap says posts began naming evals explicitly
  ([youngju.dev](https://www.youngju.dev/blog/culture/2026-07-02-how-to-become-ai-engineer-2026-llm-rag-agents-evals-career-roadmap-deep-dive.en)).
- Telemetry: per-agent tokens, cost, latency, accuracy, prompt and model versioning (General Catalyst post above).
- Prompt injection and data leakage prevention appear in agentic postings (Upwork post) and in security roles:
  Canada-remote adversarial ML red-team role covering prompt injection, guardrail bypass and agent/tool-chain misuse
  ([aijobs.net](https://aijobs.net/job/adversarial-machine-learning-engineer-red-teaming-canada-remote-262568/));
  Senior Security Engineer, Platforms and AI, focused on prompt injection, unsafe actions and data leakage
  ([whynotremote](https://www.whynotremote.com/jobs/senior-security-engineer-platforms-ai-c392f6ef)). Security
  postings commonly want web/appsec background and OWASP LLM Top 10 familiarity. Many are contract or senior.
- Toronto: the visible LLM-agent roles skew experienced, e.g. Tempo, 3+ years
  ([Work at a Startup](https://www.workatastartup.com/jobs/68264)); Mindlance LLM Engineer contract
  ([careerbeacon](https://www.careerbeacon.com/fr/emplois-12/1959927/mindlance-canada/llm-engineer)). A secondary
  blog gives CAD 80k to 110k for junior AI engineers
  ([jobrise](https://jobrise.io/pt/blog/vagas-ai-engineer-toronto-2026-guia/)); unverified. I found no new-grad
  Toronto posting naming TypeScript; TypeScript-heavy AI roles were mostly US/UK. Search new-grad boards directly.
- On-device speech and Swift: Heard, remote Founding Engineer (Swift/macOS/Voice AI), on-device STT, TTS,
  interruptions, "latency you can feel"
  ([Peerlist](https://peerlist.io/company/heardv/careers/founding-engineer-swift--macos--voice-ai/jobhgnqg7r6d9679kf8jrk8koer6e7));
  superwhisper hiring Mac/iOS and ML engineers ([careers](https://superwhisper.com/careers/mac-ios-engineer));
  Apple Siri Speech roles, senior ([Apple](https://jobs.apple.com/en-ng/details/200539894/aiml-software-engineer-siri-speech)).
  Tooling to know: [WhisperKit](https://formulae.brew.sh/formula/whisperkit-cli). Niche, but Stephen matches it.
- Frameworks: OWASP Top 10 for LLM Applications 2025 (emphasis on excessive agency) and an OWASP Agentic Top 10
  (ASI01 to ASI10, reportedly published Dec 2025). Sources are secondary
  ([gravitee](https://www.gravitee.io/blog/owasp-top-10-for-llm-applications-2025-a-practical-guide),
  [blckalpaca](https://blckalpaca.at/de/wissen/ki-agenten/ai-agent-sicherheit-owasp/owasp-llm-top-10-2025-erklaert.md)).
  Verify exact IDs on genai.owasp.org before citing them in a resume or write-up.

## 2. What makes an agent project stand out, and red flags

Sources are practitioner opinion
([Gauntlet](https://gauntletai.com/night-school/what-hiring-managers-actually-look-for-in-ai-engineers),
[techinterview](https://www.techinterview.org/post/3233475399/ai-portfolio-built-with-ai-2026-interviews/),
[underdog](https://underdog.io/blog/agentic-ai-development-on-your-resume),
[gigin](https://www.gigin.ai/blog/without-evals-agentic-hiring-is-just-confidence-theater/)).

Stands out:
- Working, shipped systems rather than concept fluency.
- Evaluation rigor, with adversarial and edge cases next to happy paths.
- A short failure-modes section: what broke, how it was mitigated. Often the most persuasive part.
- Visible judgment and trade-offs, and low reviewer friction (fast demo, clear README).

Red flags:
- Generic chat wrapper or tutorial-level clone (Streamlit chatbot).
- No way to check results; no tests or safeguards.
- Unclear personal contribution; over-polished, AI-looking write-ups with no reasoning behind them.
- Needless complexity.

Unverified, ignore: a widely repeated "85% of portfolios are basic API integrations, top 15% get 4 to 5x callbacks".
Honest-claims note for Stephen: much of the code is likely AI-assisted. Be ready to explain every design choice
and say plainly which parts the reviews and evals verify.

## 3. Feature signal for Stephen

Already strong (shipped, in docs): taint-based egress gate, deterministic memory router, import-boundary tests,
real-model eval harness with injection cases (46/46 on full runs), 6 independent reviews, hostile-input bounds,
pinned-origin client, on-device speech (sherpa-onnx), Swift/TypeScript contract fixtures. This maps directly to the
"governed tool layer", "evals" and "prompt injection" asks above. It is rarer than any single planned feature.

Planned features, ranked by hiring signal:
1. Phone channel with a written threat model: new untrusted input channel and identity problem; security roles value it.
2. Low-latency long-lived session: matches the Heard-style "latency you can feel" ask, and is measurable.
3. Sandboxed background jobs: isolation and least privilege; the strongest "excessive agency" story.
4. Gmail read with OAuth PKCE (plus Notion): shows real-world integration and token handling; moderate signal,
   since OAuth is common, but it extends the taint model to the most injection-rich data source (email).
5. Morning briefing: good demo, low signal alone. Value is as the showcase for multi-source taint handling.

Missing but valued:
- Published latency numbers (p50/p95, per stage).
- Eval results page: pass rate by category, injection attack success rate, run-to-run variance, regression history.
- OWASP LLM Top 10 / Agentic Top 10 mapping table linking each risk to a control and a test.
- 2 to 3 minute demo video, including a blocked injection.
- Public write-up and a cleaned public repo with a one-command `stephen doctor` / `selftest` path.
- Cost and token telemetry per command (postings name it).

## 4. Recommendations (ranked)

1. Publish an eval report. Report pass rate per category, injection cases separately (attack success rate with and
   without the gate), repeat runs for variance, and one failure story (the Round 1 Canvas over-browsing finding).
   Why: evals are the most-named differentiator and the thing most candidates skip.
2. Write the OWASP mapping (LLM Top 10 2025 and Agentic Top 10) after checking IDs on the official site. One row per
   risk: control, test name, residual risk. Cheap, and speaks the vocabulary security postings use.
3. Measure and publish latency: wake-to-transcript, transcript-to-first-tool-call, end-to-end, p50/p95, before and
   after the long-lived session. Show the number you improved, no number you did not measure.
4. Record a short demo video: voice command, tool use, then an injected Canvas announcement or page being refused
   and the native confirmation dialog. Embed at the top of the README.
5. Publish a public write-up ("Taint tracking for a voice agent"): threat model table, the design choice of marking
   taint on return, the deterministic memory router, and what the six reviews found. Link from resume.
6. Ship the phone channel only with its threat model first, plus injection cases in the eval harness for it.
7. Sandboxed jobs: define the policy (no network by default, scoped files, time and call budgets) and test escapes;
   document as least-privilege design.
8. Add per-command token/cost/latency telemetry to the audit log and show it in the report. Postings name it.

Also: keep the README honest about limits (same-user malware out of scope, Zen port trade-off). Calibrated claims
read as maturity.

## 5. Resume bullet drafts (facts from the docs only)

- Built Stephen, a macOS voice assistant (TypeScript/Node, Swift) where Claude controls browsers, apps and media
  through a custom MCP server, with all actions routed through a safety gate and native confirmation dialogs.
- Designed information-flow (taint) egress control for an LLM agent: private reads mark scopes, and later outbound
  URLs, typing and first contact with new hosts require human confirmation; taint persists fail-closed.
- Built a real-model evaluation harness (`claude -p` against a recording dry-run server) with categories including
  prompt-injection cases; a full run reached 46/46, and early runs exposed over-browsing that led to persona and
  scoring changes.
- Enforced architectural security with import-boundary tests (the model-facing process cannot load memory, app or
  history modules) and a deterministic memory router with no model in the write path; ~2,500 automated tests and
  independent security reviews, each finding fixed with a named regression test.
- Implemented on-device speech (sherpa-onnx: Silero VAD + Whisper), a pinned-origin read-only API client for
  Canvas, and an RFC 5545 recurrence parser with DST-correct expansion, with no calendar library.

Note: docs say ~2,500 in one place, ~2,568 in the brief, and "five" vs "six" reviews; confirm current counts
before use.
