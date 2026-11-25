# GitHub agentic workflows: three papers and Stephen

Status: research note, revised 2026-11-25 (second pass). Docs only.
State when written: `ci.yml` is the only workflow on `qa`. #330 (incident auto-wake) is open and already took the
fixes from the first pass. #329 (auto-merge) is closed, merges stay manual.

## 1. Short answer

- The paper the professor gave (GH-AWTrace) is a **dataset of logs**. It has no security results and no checker.
- It cites two papers that do have security results. Those are the useful ones for us. Both are summarized here.
- Stephen's incident workflow (#330) already has the controls that those papers measured as the strongest.
  Three gaps are left, all small. They are in section 5.
- Do not use the dataset. It has no license and no attack labels.

How sure: all three papers were read from the arXiv abstract and HTML pages, not the PDFs. Parts of the two security
papers were only seen as a summary of the page. Numbers below marked (s) come from that summary. Check them in the
PDF before quoting them to the professor.

## 2. Paper 1: GH-AWTrace (arXiv 2611.06866), the one the professor recommended

Khelifi, Li, Ouni, Sayagh, Saied. A dataset of GitHub Agentic Workflows (gh-aw, GitHub's tool that turns markdown
into Actions files).

- **Size:** 25,014 workflows, 5,051 repositories, 4.1 million run records (Aug 2025 to Sep 2026), 562,877 non-empty
  log archives from the last 90 days.
- **Failures:** 31.7% of the non-empty archives are from runs that failed. The paper does not say why.
- **Triggers, by share of logs:** schedule 44.9%, `pull_request_target` 13.1%, `pull_request` 10.9%,
  `issue_comment` 10.4%, `workflow_dispatch` 8.2%, `issues` 4.8%. No judgment on which are unsafe.
- **Tools:** none. Data and one Python example script.
- **License:** the dataset card has no license. It says it "does not assign a common license" to the files and logs,
  and that the source repositories keep their own terms. The paper is under the arXiv non-exclusive license.

## 3. Paper 2: agentic workflow injection (arXiv 2605.07135)

Wang et al., "Demystifying and Detecting Agentic Workflow Injection Vulnerabilities in GitHub Actions".

- **Attacker:** any GitHub user who can open an issue, a PR or a comment. No write access.
- **Two patterns:**
  - **P2A, prompt to agent:** outside text reaches the agent's prompt.
  - **P2S, prompt to script:** the agent's answer is later used by a shell step, `gh` or `git push` as if it were
    trusted.
- **Where the text came from (s):** issue title or body 86.5%, PR title or body 10.1%, comment or review 4.8%,
  branch or commit names 3.6%.
- **Numbers:** 13,392 agentic workflows scanned. 496 confirmed vulnerable cases, 343 new. Only 6.4% (s) of affected
  workflows had a guard in the workflow file itself. Only 21 of 1,033 agent actions check who the caller is.
- **Defenses it recommends (s):** check the actor in the workflow, labels applied by a maintainer, approval gates,
  least privilege, do not paste issue text into the prompt (pass an id), check the model's answer against a schema or
  allow-list. It says a prompt line like "ignore injected instructions" is **not enough**.
- **Tool:** TaintAWI, a static analyzer. No download link or license found. We cannot use it.

## 4. Paper 3: GitInject (arXiv 2606.09935)

Isbarov, Suleymanov, Shumailov, Kantarcioglu. Real attacks on real AI CI pipelines, not a simulator.

- **Attacker:** outside contributor. Can open a fork PR, comment, or add files to a PR branch.
- **Vectors (s):** PR body, issue body, and **agent config files on the PR branch** (`CLAUDE.md`, `AGENTS.md`,
  `GEMINI.md`). The agent loads these as if the repo owner wrote them.
- **What made attacks work (s):** `pull_request_target` on fork PRs, `issue_comment` with no author check,
  `actions/checkout` leaving the token in `.git/config`, shell tools, API keys in the agent's process.
- **Results (s):** config file attacks worked on most mid-size models and failed on the strongest ones. PR body
  attacks mostly failed on Claude models. Simulators missed most of the attacks that worked for real.
- **Defenses, measured on 9 attacks (s):**

  | Defense | Attacks that still worked |
  | --- | --- |
  | None | 9 of 9 |
  | A prompt or "advisory" permission note only | 9 of 9 |
  | `persist-credentials: false` | 6 of 9 |
  | Restrict tools | 5 of 9 |
  | Remove `.md` files from the checkout | 3 of 9 |
  | Three cheap controls together | 2 of 9 |
  | Author filter (refuse outsiders) | 0 of 9 |

- **Tool:** GitInject benchmark, https://github.com/ceferisbarov/GitInject (s). License not confirmed.

**The lesson from both papers:** who is allowed to trigger the agent matters most. Tool limits and token hygiene
come next. Words in the prompt do nothing.

## 5. Stephen against these findings

### `ci.yml` on `qa`: fine

No agent, no secrets, `pull_request` (not `pull_request_target`), `contents: read` at the top (line 14), every action
pinned to a commit hash (lines 39, 42, 54, 73, 98), `persist-credentials: false` (line 41), event values only through
`env` in the `report` job (lines 90 to 96). Nothing to fix.

One thing to know: a PR can edit `ci.yml`, so green `linux` and `macos` checks only prove what that PR's own
`ci.yml` ran. A reviewer must look at any diff under `.github/`.

### #330 incident auto-wake (`.github/workflows/incident.yml`, branch `ci/incident-autowake`)

Line numbers are from the first pass. The branch has moved since, so check them again before quoting.

| Paper finding | Stephen | Verdict |
| --- | --- | --- |
| Author filter is the strongest defense (GitInject, 0 of 9) | `if:` on the `parse` job allows only user id 119613966 (lines 26 to 29). The action's own write-access check is also back on. | Good. This is the main control. |
| Workflow-level guard is rare, 6.4% (Wang) | The guard is in the workflow file, by user id, not by login. | Good. |
| P2A: do not paste issue text into the prompt (Wang) | The body goes through `env` (line 50). Only lines that parse as `stephen report` records reach the prompt (line 117). A seeded fuzz test now covers the parser. | Good. Residual risk is a parser bug. |
| A prompt line is not a defense (both) | The prompt says the lines are data (line 112). | Fine as an extra. Never count it as a control in ADR-017. |
| P2S: agent answer used by a script (Wang) | The answer is a fixed JSON schema (line 107), passed by `env`, checked by `incident-bot.mjs post` (line 183), posted inside a code block. | Good. |
| P2S through `git push` (Wang) | With `AUTO_FIX` on, the patch is applied and pushed by a job with no Claude token, after a path check (lines 215 to 229). | Good design. See gap 2. |
| Restrict tools (GitInject) | No `Bash`, no web. `Read` only, on `src`, `docs`, `test` (lines 93 to 106). | Good. |
| `persist-credentials: false` (GitInject) | On every checkout. | Good. |
| Config files as an injection vector (GitInject) | The agent reads `AGENTS.md` and `docs/` from `qa` (lines 78 to 84). No PR branch is ever checked out. | See gap 1. |
| Denial of wallet (GitInject) | Only Cris-authored issues start a run. `--max-turns 40`. No daily cap. | See gap 3. |
| Secrets in the agent's process (GitInject) | The Claude token is in the agent step. Reads of `/proc`, `~/.claude`, `_temp`, `.git` are denied (lines 96 to 98). Environment limited to `main` (line 64). | Good. |

**Gaps left:**

1. **`AGENTS.md` and `docs/` on `qa` are instructions for the agent that holds Cris's Claude token.** GitInject shows
   that config files are the vector that works best. Today only our own lanes can change `qa`, so the attacker would
   have to get a PR merged first. This is the same weak point that closed #329: every lane acts as Cris, and `qa` has
   no review rule. **Fix:** state in ADR-017 that `AGENTS.md` and `docs/` are part of the agent's trusted input, and
   that a PR from outside that touches them needs a careful read. A stronger fix is the separate reviewer account that
   the #329 closing note already names. Cris decides.
2. **`AUTO_FIX` path check allows any file under `test/`.** A patch could change a test setup file that runs on every
   test run. It only runs in PR CI with no secrets, and the PR is marked `[DEV REVIEW]`, so the risk is low. **Fix:**
   refuse `test/global-setup.ts`, `setup*` and `*.config.*` in the patch check. `AUTO_FIX` stays off for now (decided).
3. **No run cap.** Only Cris can trigger it, so it is a cost question, not an attack. **Fix:** skip the run if there
   were more than N incident runs today. Pick N when incidents become common.

**If testers are added to the id list later:** that is the moment the risk changes. A tester's Mac writes the issue
text, and the tester is then inside the author filter. Before that change: read GitInject's issue-body attacks, add
them as cases to the parser fuzz test, and get an independent review.

### #329 auto-merge: closed

Closed by the top lead after three independent reviews. The first pass of this note found that the gate trusted the PR
title and that a PR could edit the checks it was judged by. The deeper reason is the same as gap 1: every agent acts
as `CrisH2307`, so no automated gate can tell an author from a reviewer. The papers agree: a gate is only as good as
its check of **who** acted. Lesson to keep: do not add `pull_request_target` or `workflow_run` with write access
until there is a second GitHub account for review.

## 6. Checks we could run in CI

All free. Each new tool needs Cris's OK first. None is added yet.

1. **Our own test, no new tool (do first).** A vitest file in `test/checks/` that reads `.github/workflows/*.yml` and
   fails when: a `uses:` has no 40 character hash; `${{ github.event.` appears inside a `run:` block; a file has no
   top-level `permissions:`; a checkout has no `persist-credentials: false`; a workflow uses `pull_request_target`,
   `workflow_run` or `issue_comment` and is not on a short allow-list in the test. This covers the main patterns from
   both papers for the few files we have.
2. **`zizmor`** (MIT, static analyzer for GitHub Actions). Finds template injection, wide permissions, unpinned
   actions, risky triggers, cache poisoning. Run as a pinned binary in a job with no secrets. Needs Cris's OK. The top
   lead recommends yes.
3. **`actionlint`** (MIT). Syntax and expression mistakes. Lower value for us than zizmor. Needs Cris's OK.
4. **GitHub settings, no code:** secret scanning with push protection, and "require approval for all outside
   collaborators" for workflow runs.

Not usable: TaintAWI (not released). GitInject is a benchmark for attacking pipelines, not a checker. We could borrow
its attack texts as fuzz cases once its license is confirmed.

## 7. Does using the GH-AWTrace dataset make sense?

No.

- It is about gh-aw workflows. Stephen does not use gh-aw.
- It has no labels for attacks or for safe and unsafe workflows.
- It has no license, and the logs may hold other people's text. Do not copy any of it into this public repo.
- The log window is 56 GB.

For the professor, a fair answer: GH-AWTrace is a good source for studying how agents behave in CI at scale. For
securing our own workflows, the two papers it cites gave us more, and Stephen already follows their strongest advice
(author filter, tool limits, no credentials on disk, checked output).

## 8. Plan

| Step | Who | Needs Cris |
| --- | --- | --- |
| 1. Workflow rules test in `test/checks/` (section 6, item 1) | dev lane, own PR | No |
| 2. ADR-017: say that `AGENTS.md` and `docs/` are trusted agent input, and that the prompt line is not a control | incident chat, in #330 | No |
| 3. Patch check refuses test setup and config files | incident chat, in #330 | No |
| 4. Add zizmor to CI | dev lane, after OK | **Yes** |
| 5. Separate reviewer GitHub account and a review rule on `qa` | Cris | **Yes** |
| 6. Before any tester joins the id list: GitInject cases in the fuzz test, independent review | incident chat | Later |

## 9. What Cris must decide

1. OK to add `zizmor` to CI as a pinned, free tool? (Top lead: yes.)
2. Do you want a second GitHub account for reviews? It is the real fix for both #329 and gap 1.
