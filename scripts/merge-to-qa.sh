#!/bin/bash
# Merge one PR into qa, only when it is safe. Agent sessions may run only this script, never plain `gh pr merge`.
# Usage: scripts/merge-to-qa.sh <pr-number>
# Refuses unless: the PR is open, has the label merge-ready, its base is qa, the linux and macos checks passed on the
# head commit, and,
# for a [DEV REVIEW] PR, CrisH2307 posted a comment that starts with "**Independent review: approve.**" and names the
# head commit (its first 7 characters), so an approve for an older commit does not count after new pushes.
# The merge pins the head commit, so a push after these checks makes the merge fail instead of merging untested code.
set -eu

PR=${1:-}
case "$PR" in
  ''|*[!0-9]*) echo "Usage: $0 <pr-number>" >&2; exit 2 ;;
esac

JSON=$(gh pr view "$PR" --json baseRefName,state,title,headRefOid,statusCheckRollup,comments,labels)

# Prints the head commit on success; prints the reason and exits 1 otherwise.
HEAD_SHA=$(printf '%s' "$JSON" | node -e '
  const pr = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const fail = (why) => { console.error("Refused: " + why); process.exit(1); };
  if (pr.state !== "OPEN") fail("the PR is not open (" + pr.state + ").");
  if (pr.baseRefName !== "qa") fail("the base is " + pr.baseRefName + ", not qa.");
  if (!(pr.labels || []).some((l) => l.name === "merge-ready")) fail("the PR has no merge-ready label.");
  for (const name of ["linux", "macos"]) {
    const runs = (pr.statusCheckRollup || []).filter((c) => c.name === name);
    if (runs.length === 0 || !runs.every((c) => c.conclusion === "SUCCESS")) fail("the " + name + " check is not green.");
  }
  if (!/^[0-9a-f]{40}$/.test(pr.headRefOid)) fail("no head commit.");
  if (pr.title.includes("[DEV REVIEW]")) {
    const short = pr.headRefOid.slice(0, 7);
    const ok = (pr.comments || []).some((c) => c.author && c.author.login === "CrisH2307" &&
      c.body.startsWith("**Independent review: approve.**") && c.body.includes(short));
    if (!ok) fail("a [DEV REVIEW] PR needs an \"**Independent review: approve.**\" comment that names commit " + short + ".");
  }
  console.log(pr.headRefOid);
')

gh pr merge "$PR" --merge --match-head-commit "$HEAD_SHA"
