# Agent loop: who does what

Goal: a loop that runs on its own (Plan, Design, Code, Test, Review) and saves paid tokens. Free agents do the easy
work. Claude plans, writes the safety code and reviews every diff. Cris is asked only about goals and clicks.

## Roles

| Role | Does | Never does |
|---|---|---|
| Claude dev lead | Plans, design notes, all safety code, writes free-agent tasks, reviews every free-agent diff, decides `[DEV REVIEW]` PRs | Merges into `main` |
| Review lane (Claude) | Reviews and merges PRs into `qa`, prepares the release PR `qa` to `main` | Merges into `main`, merges its own safety code without a dev review |
| OpenCode intern (`opencode run`, inbox #273) | Docs, test audits, new tests, small non-safety code from a written plan | Safety code, design choices, merges, pushes to `qa` |
| freellm (free LLM API) | Text in, text out: first drafts, summaries, format changes | Tools, files, git, the web, secrets, private data |
| Cris (owner) | Goals, requirements, strategy, permission clicks, merges `qa` to `main`, Mac click checks | |

## The loop

1. **Plan:** Claude dev lead turns a goal into small tasks, each with the template below.
2. **Design:** Claude writes a short design note (in the PR or `docs/`) for anything bigger than one file.
3. **Code:** safety code by Claude. The rest by OpenCode from the plan, or by Claude when the plan would be as long
   as the code.
4. **Test:** whoever wrote the code runs the checks in `AGENTS.md`. One full suite per machine.
5. **Review:** Claude dev lead reviews every free-agent diff. The review lane reviews and merges into `qa`.
   `[DEV REVIEW]` PRs need "Dev-lane review: approve." first.

## Task template for a free agent

```text
Goal:            one sentence, what is true when done
Files allowed:   exact paths (new files named too)
Files forbidden: everything in "Always Claude-only", plus: ...
Plan:            numbered exact steps (for code: names, signatures, the test cases)
Acceptance test: the command that must pass, e.g. npx vitest run test/<folder>
Done check:      git diff --stat shows only allowed files; author and committer are Cris
Report:          "ready: #<n>" in #273, plus anything you were unsure about
```

freellm gets only the Goal and the text it needs, never repo secrets or private data. Its answer is a draft that
Claude checks and fixes before it lands anywhere.

## Always Claude-only

Every path in `SAFETY_PATHS` in `scripts/safety-paths.mjs`. That script is the one list: the `safety-paths` CI check
uses it, and a PR that touches one of those paths needs `[DEV REVIEW]` in its title. Do not copy the list here
(`test/checks/safety-paths.test.ts` fails if this section names a path).

## Reviewing a free agent's diff

1. `git diff --stat origin/qa...HEAD`: only allowed files. Anything else sends it back at once.
2. Read every line. Free agents invent APIs and skip edge cases: check each call exists.
3. Run the acceptance test and the tests of the touched folders.
4. `git log --format='%an <%ae> | %cn <%ce>' origin/qa..HEAD` shows only Cris.
5. No secrets, no em or en dashes, no new dependency.
6. Comment "approve", or "changes needed" with file:line.

## When to ask Cris

Only goals, requirements, strategy, permissions, and merges to `main`. Everything else the loop decides, and says
what it decided on #10.
