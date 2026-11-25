#!/bin/bash
# Merge one ordinary PR into qa. Agent sessions may run only this script, never plain `gh pr merge`.
# Usage: scripts/merge-to-qa.sh <pr-number>
# Every agent acts on GitHub as CrisH2307, so no comment or label can prove that a human read the code.
# This script therefore merges only ordinary PRs. It refuses any PR that touches a protected path or carries the
# [DEV REVIEW] tag. Cris merges those by hand.
# Refuses unless: the PR is open, not from a fork, has the label merge-ready, its base is qa, it has at most 99
# changed files, touches no protected path, and the linux and macos checks of workflow "ci" are green on the latest run.
# The merge pins the head commit, so a push after these checks makes the merge fail instead of merging untested code.
# Known limit: the base is read once, from the same JSON as the checks, so it is only loosely tied to the head commit.
set -eu

PR=${1:-}
case "$PR" in
  ''|*[!0-9]*) echo "Usage: $0 <pr-number>" >&2; exit 2 ;;
esac

JSON=$(gh pr view "$PR" --json baseRefName,state,title,headRefOid,statusCheckRollup,labels,isCrossRepository,changedFiles,files)

# Prints the head commit on success; prints the reason and exits 1 otherwise.
HEAD_SHA=$(printf '%s' "$JSON" | node -e '
  const pr = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const fail = (why) => { console.error("Refused: " + why); process.exit(1); };

  // Protected paths. An agent never merges these. Cris merges them by hand.
  // The first group is copied from docs/AGENT-LOOP.md, "Always Claude-only". The last group is from the merge brief.
  // Keep both in step with that doc. A trailing slash is a folder prefix. A * matches within one path segment.
  // Any other entry matches one exact path.
  const PROTECTED = [
    // docs/AGENT-LOOP.md "Always Claude-only"
    "src/safety/",
    "helper/AppConfirm.swift",
    "src/memory/",
    "src/timers/",
    "src/jobs/",
    "src/replay/recorder.ts",
    "src/app/protocol.ts",
    "src/app/server.ts",
    ".github/",
    "package.json",
    "package-lock.json",
    "docs/RELEASE-CHECKLIST.md",
    // Added for the merge rule
    "scripts/merge-to-qa.sh",
    "test/global-setup.ts",
    "vitest.config.*",
  ];
  const toRegex = (p) => new RegExp("^" +
    p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") +
    (p.endsWith("/") ? "" : "$"));
  const PROTECTED_RE = PROTECTED.map(toRegex);

  if (pr.state !== "OPEN") fail("the PR is not open (" + pr.state + ").");
  if (pr.isCrossRepository) fail("the PR comes from a fork. Cris merges it by hand.");
  if (pr.baseRefName !== "qa") fail("the base is " + pr.baseRefName + ", not qa.");
  if (!(pr.labels || []).some((l) => l.name === "merge-ready")) fail("the PR has no merge-ready label.");
  if (pr.title.includes("[DEV REVIEW]")) fail("this PR is tagged [DEV REVIEW]. Cris merges it by hand.");
  if (pr.changedFiles > 99) fail("this PR changes " + pr.changedFiles + " files. The limit is 99.");
  const files = pr.files || [];
  if (files.length !== pr.changedFiles) fail("could not read every changed file of this PR.");
  for (const f of files) {
    if (PROTECTED_RE.some((re) => re.test(f.path))) fail("this PR touches " + f.path + ". Cris merges it by hand.");
  }
  for (const name of ["linux", "macos"]) {
    const runs = (pr.statusCheckRollup || []).filter((c) => c.workflowName === "ci" && c.name === name);
    const at = (c) => Date.parse(c.completedAt || c.startedAt || "") || 0;
    runs.sort((a, b) => at(a) - at(b));
    const latest = runs[runs.length - 1];
    if (!latest || latest.conclusion !== "SUCCESS") fail("the " + name + " check of workflow ci is not green on its latest run.");
  }
  if (!/^[0-9a-f]{40}$/.test(pr.headRefOid)) fail("no head commit.");
  console.log(pr.headRefOid);
')

gh pr merge "$PR" --merge --match-head-commit "$HEAD_SHA"
