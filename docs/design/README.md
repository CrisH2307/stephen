# Stephen: technical design

These pages explain how Stephen works, in the order you would answer a system design interview: requirements,
high-level design, data, deep dives, trade-offs, algorithms, then the codebase itself. Each page is short and links
to the longer docs and the code. Every number comes from the code, a measurement or a stated target, with its source.

Describes `qa` at commit `5fae967` (2026-11-25).

Stephen is a voice assistant for the Mac. You talk to it, and it uses your browser, your apps and your accounts to
help you. It runs on your own Mac with your own Claude plan. There is no Stephen server.

## Reading order

| # | Page | What it answers |
|---|---|---|
| 1 | [REQUIREMENTS.md](REQUIREMENTS.md) | What must it do, and how fast, safe and cheap? |
| 2 | [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md) | What are the parts, and how does one command flow through them? |
| 3 | [DATA-MODEL.md](DATA-MODEL.md) | What does it store, for how long, and who writes it? |
| 4 | [DEEP-DIVES.md](DEEP-DIVES.md) | How do the voice path, the safety gate, the browsers, jobs, the helper app and setup work inside? |
| 5 | [TRADE-OFFS.md](TRADE-OFFS.md) | Why this design and not another? |
| 6 | [ALGORITHMS.md](ALGORITHMS.md) | The key algorithms, in plain words and then precisely. |
| 7 | [CODEBASE.md](CODEBASE.md) | Module map, sizes, tests, how the code grew, and its known weak spots. |

Pages that are not in this folder yet are coming in the next pull requests. Each page says which `qa` commit it
describes. The code moves fast, so open safety items live in [INJECTION-COVERAGE.md](../INJECTION-COVERAGE.md), not
here.

## The two minute answer

1. **Requirement that shapes everything:** a model that can act on your computer must never take orders from what
   it reads. A web page or an email is data, never instructions.
2. **Two trust zones.** The **listener** (`stephen listen`) holds what the owner trusts: memory, timers, history,
   settings, the window. The **tool server** (`stephen serve`) is the only thing the model can call. A test scans
   the import graph and fails if tool server code could reach the memory, history, app, timer or job code.
3. **One gate.** Every browser and desktop action and every private read in the tool server goes through the
   **safety gate**. (One exception, `announce`, only speaks a line and checks taint and the rate limit itself.) It runs
   one policy pass over all its rules, such as taint (has the model read something private?), egress (could this
   action leak it?) and the rate limit. Deny beats ask. "Ask" means the owner must click Allow or Deny.
4. **Local first.** Wake word, speech to text and the simple commands run on the Mac. Only the command, the memory
   block and what the tools read go to Claude, under the person's own account.
5. **Cheap paths first.** Memory, timers, job status and "stop" never call the model. That saves time and money.
6. **No server.** Each person brings their own Claude plan, so there is nothing for us to run, pay for or protect.

## Words used on these pages

| Term | Meaning |
|---|---|
| Listener | The `stephen listen` process. It hears you and keeps your memory, timers and history. |
| Tool server, `serve` | The `stephen serve` process. The model calls its tools over MCP. It holds the safety gate. |
| Helper | The small Swift Mac app: menu bar, Ask box, Allow and Deny buttons, the F5 key. |
| MCP | Model Context Protocol. The standard way a model calls tools. |
| Safety gate | The one function every action and private read must pass. |
| Taint | A mark that says "the model has read something private in this conversation". |
| Egress | Data leaving the Mac, for example inside a web address the model wants to open. |
| Untrusted text | Anything the model reads that the owner did not write: pages, emails, tab titles. |
| Push to talk | Hold a key while you speak. Stephen's key is F5 (or Fn+Option). |
| Wake word | The phrase that starts listening without a key: "Hey Stephen". |
| Router | Local rules that handle a command without the model. |
| Job | A longer task Claude runs in the background, in a sandbox. |
| p50, p95 | Median, and the time 95 of 100 commands beat. |

These are short versions. The one glossary for the project is `docs/guide/GLOSSARY.md`, being written by the user
docs.

## Older and longer docs

These pages build on, and do not replace, the docs below.

- [SYSTEM-DESIGN-STEPHEN.md](../SYSTEM-DESIGN-STEPHEN.md): the long design and research write-up.
- [ARCHITECTURE-PLAN.md](../ARCHITECTURE-PLAN.md): the path from today to a public release.
- [NFR-STEPHEN.md](../NFR-STEPHEN.md): the non-functional targets and measurements.
- [DATA-STORES.md](../DATA-STORES.md): every store on the Mac, and everything that leaves it.
- [INJECTION-COVERAGE.md](../INJECTION-COVERAGE.md): prompt injection coverage per untrusted source.
- [PRODUCTION-READINESS.md](../PRODUCTION-READINESS.md): what is left before the friends beta and the public.
- The ADRs (`docs/ADR-*.md`): one decision each, with its reasons.
