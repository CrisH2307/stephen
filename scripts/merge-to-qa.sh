#!/bin/bash
# Merge one docs-only PR into qa. Agent sessions may run only this script, never plain `gh pr merge`.
# Usage: scripts/merge-to-qa.sh <pr-number>
# Every agent acts on GitHub as CrisH2307, so no comment or label can prove that a human read the code.
# This script merges only PRs whose every changed file is a docs or site text file (an allow-list). A deny-list
# cannot be complete (renames, imports, tests, config, case), so any other file refuses the PR. Cris merges those by hand.
# Refuses unless: the PR is open, not from a fork, has the label merge-ready, its base is qa, has no [DEV REVIEW] tag,
# every changed file (and every rename source) is a docs file, and the linux and macos checks of workflow "ci" are green
# on the latest run. The merge pins the head commit, so a push after these checks makes the merge fail.
# Known limit: the base is read once, from the same JSON as the checks, so it is only loosely tied to the head commit.
set -eu

PR=${1:-}
case "$PR" in
  ''|*[!0-9]*) echo "Usage: $0 <pr-number>" >&2; exit 2 ;;
esac

PR_JSON=$(gh pr view "$PR" --json baseRefName,state,title,headRefOid,statusCheckRollup,labels,isCrossRepository)
# One JSON object per changed file, one per line. gh api pages through the list.
FILES_JSONL=$(gh api "repos/{owner}/{repo}/pulls/$PR/files" --paginate --jq '.[] | tojson')

# Prints the head commit on success; prints the reason and exits 1 otherwise.
HEAD_SHA=$(PR_JSON="$PR_JSON" FILES_JSONL="$FILES_JSONL" node -e '
  const pr = JSON.parse(process.env.PR_JSON);
  const files = process.env.FILES_JSONL.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const fail = (why) => { console.error("Refused: " + why); process.exit(1); };

  // Allow-list. Compared in lower case. Anything else is refused, and Cris merges it by hand.
  const NEVER = ["agents.md", "claude.md", "docs/agent-loop.md", "docs/release-checklist.md", "site/appcast.xml"];
  const NEVER_PREFIX = [".github/", ".claude/"];
  const isDocPath = (original) => {
    const path = original.toLowerCase();
    if (path.split("/").includes("..")) return false;
    if (NEVER.includes(path) || NEVER_PREFIX.some((p) => path.startsWith(p))) return false;
    if (path.startsWith("docs/") || path.startsWith("site/")) return true;
    return !path.includes("/") && path.endsWith(".md");
  };

  if (pr.state !== "OPEN") fail("the PR is not open (" + pr.state + ").");
  if (pr.isCrossRepository) fail("the PR comes from a fork. Cris merges it by hand.");
  if (pr.baseRefName !== "qa") fail("the base is " + pr.baseRefName + ", not qa.");
  if (!(pr.labels || []).some((l) => l.name === "merge-ready")) fail("the PR has no merge-ready label.");
  if (pr.title.includes("[DEV REVIEW]")) fail("this PR is tagged [DEV REVIEW]. Cris merges it by hand.");
  if (files.length === 0) fail("the PR has no changed files.");
  if (files.length >= 3000) fail("this PR changes " + files.length + " files. The limit is below 3000.");
  for (const f of files) {
    for (const path of [f.filename, f.previous_filename].filter(Boolean)) {
      if (!isDocPath(path)) fail(path + " is not a docs file. Cris merges it by hand.");
    }
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
