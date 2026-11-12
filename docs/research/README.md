# docs/research

`STEPHEN-DOSSIER.md` is one self-contained document of facts about Stephen: what it is, its architecture, every feature and its state, the safety model, history, reviews, UI, plans, open decisions, pain points and numbers. It ends with a neutral list of open questions.

**What it is for.** Hand it to a stronger model for a deep-research pass on better features, harder problems, trade-offs, code improvements, design and architecture. The reader should not need the repo to follow it; every claim cites a file or PR so the reader can check it.

**What it is not.** It is not a design doc, a review or a plan. It makes no recommendations and changes no code. When a doc and the code disagree, it says so instead of picking one.

**Snapshot.** Branch `qa` at `4d3aa0c` (2026-11-09): `main` plus open PRs #11 to #41. Facts go stale as PRs merge; regenerate rather than hand-edit when the gap grows.

**Rules kept.** No secrets, keys, tokens, emails or config values. No em dashes.

**Product plan and handoff (2026-11-10).** These two files make recommendations, unlike the dossier.
`PRODUCT-PLAN-2026-11.md`: status, product decisions and fixed constraints, assumed defaults for Cris to confirm, phased roadmap from 1.9, language verdict, market summary, success metrics, open technical questions.
`HANDOFF-PROMPT-CLAUDE-CODE.md`: ready-to-paste prompt that starts a Claude Code session from that plan (Fable owns technical design; RPI workflow; Cris commits and pushes).

**Review and handoff (2026-11-12).** Which doc wins: `PLAN-REVIEW-2026-11.md` section 4 governs the next two weeks. Where it disagrees with `PRODUCT-PLAN-2026-11.md`, the review wins; the plan keeps its stale facts corrected in place and marked.
`PLAN-REVIEW-2026-11.md`: independent review of the plan: fact check, ten findings, two-week plan (section 4), owner answers (5.1).
`IDEAS-RESEARCH-2026-11.md`: research behind the plan's ideas (revision 3); background, not a work order.
`HANDOFF-2026-11-12.md`: who does what (dev lane and review lane) and the two paste-ready prompts.
`FINDINGS-LEDGER.md`: one table of every open or recently closed finding, with owner lane and issue or branch; update it in the same PR as the fix.
