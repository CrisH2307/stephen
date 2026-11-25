# GitHub settings only Cris can click

Free settings that protect the repo (decisions D9 and B1, 2026-11-25). Agents cannot change them. Each takes about
one minute. Checked against the repo on 2026-11-25.

| Setting | Today |
|---|---|
| Secret scanning | On |
| Push protection | **Off** |
| Dependabot alerts | **Off** |
| Private vulnerability reporting | **Off** |
| `main` ruleset ("production") | **Exists but disabled, and targets no branch** |

## 1. Security settings (D9)

Open https://github.com/CrisH2307/stephen/settings/security_analysis (Settings > Advanced Security, or "Code
security" on older pages). Turn on:

1. **Push protection** (under Secret Protection). It blocks a push that contains a key or token.
2. **Dependabot alerts**. It tells us when a package we use has a known security hole.
3. **Private vulnerability reporting**. Outsiders can then report a security problem privately, not in a public issue.

Leave **Dependabot security updates** off for now. Dependabot then opens fix PRs against `main`, and our PRs must go to `qa`.
The Dependabot config in `.github/dependabot.yml` sends its PRs to `qa` instead (D10).

## 2. Protect `main` (B1)

Open https://github.com/CrisH2307/stephen/settings/rules and click the ruleset **production**.

1. **Enforcement status:** Active.
2. **Target branches:** Add target > Include default branch (this is `main`).
3. **Rules**, turn on:
   - Restrict deletions (already on).
   - Block force pushes (already on).
   - Require a pull request before merging. Required approvals: **0** (you are the only reviewer; the PR itself is the
     check).
   - Require status checks to pass: add **linux** and **macos**.
4. **Bypass list:** leave it empty.
5. Click **Save changes**.

After this, nothing reaches `main` except a release PR from `qa` that passed CI, and only by your merge.

## How to check it worked

Tell any lane "check the settings". It runs these (read only) and reports:

```bash
gh api repos/CrisH2307/stephen --jq .security_and_analysis
```

```bash
gh api repos/CrisH2307/stephen/rulesets --jq '.[]|"\(.name) \(.enforcement)"'
```
