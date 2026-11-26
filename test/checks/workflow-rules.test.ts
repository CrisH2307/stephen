/**
 * Workflow rules (docs/research/GH-AGENTIC-WORKFLOWS.md, section 6 item 1): every file in .github/workflows/ must
 *  1. pin each `uses:` to a full 40-character commit (local `./` actions are fine, `docker://` needs a sha256 digest);
 *  2. never put `${{ ... }}` text that reads github.event or github.head_ref inside a `run:` script (pass it through env);
 *  3. have a top-level `permissions:` that is `{}`, `read-all`, or only `read` and `none` entries;
 *  4. give every checkout `persist-credentials: false`;
 *  5. never use `pull_request_target`, `workflow_run` or `issue_comment`, and never check out the PR's own code under
 *     `pull_request_target`. An exception needs a reviewed PR that changes this file.
 * Text checks, no YAML library (no new dependency). Each rule has a planted bad example below that must fail.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = resolve(__dirname, '../../.github/workflows');
const RISKY_TRIGGERS = ['pull_request_target', 'workflow_run', 'issue_comment'];

/** A `${{ ... }}` that reads event text. Stops at the closing }} only, since format('{0}', ...) has braces. */
const EVENT_TEXT = /\$\{\{(?:(?!\}\})[^\n])*?github\.(?:event\b|head_ref\b)/;
/** A `${{ ... }}` that names the PR head: the branch name or anything under github.event.pull_request.head. */
const PR_HEAD = /\$\{\{(?:(?!\}\})[^\n])*?(?:github\.head_ref\b|github\.event\.pull_request\.head\.)/;
const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const PINNED_DOCKER = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => line.trimStart().startsWith('#');
/** A value with its trailing comment removed (` # ...` after a space or at the start). */
const stripComment = (s: string) => s.replace(/(^|\s)#.*$/, '').trim();

/** The lines under `lines[i]` that are indented deeper than `indent`, comments and blanks included. */
function blockAfter(lines: string[], i: number, indent: number): string[] {
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.trim() && !isComment(l) && indentOf(l) <= indent) break;
    out.push(l);
  }
  return out;
}

/** Every problem in one workflow file. Empty means the file follows the rules. */
function workflowProblems(file: string, text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const n = `${file}:${i + 1}`;

    // 1. Pinned actions.
    const uses = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)/.exec(line)?.[1];
    if (uses && !uses.startsWith('./') && !PINNED_ACTION.test(uses) && !PINNED_DOCKER.test(uses)) out.push(`${n}: action not pinned to a full commit: ${uses}`);

    // 2. No event text inside a run: script. The script ends at the run key's own indent, so the step's env: keys are not in it.
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run) {
      const script = [run[2]!, ...(/^[|>]/.test(run[2]!) ? blockAfter(lines, i, line.indexOf('run:')) : [])].join('\n');
      if (EVENT_TEXT.test(script)) out.push(`${n}: github.event or github.head_ref text inside run: (pass it through env:)`);
    }

    // 4. Checkout keeps no credentials, and never checks out the PR's own code under pull_request_target.
    if (uses?.startsWith('actions/checkout@')) {
      // A step's keys (with:, env:) sit at the uses key's indent, so the step ends at the next dash at the step's indent.
      const step = blockAfter(lines, i, indentOf(line) - (line.trimStart().startsWith('-') ? 0 : 2)).join('\n');
      if (!/persist-credentials:\s*false/.test(step)) out.push(`${n}: checkout without persist-credentials: false`);
      const prCheckout = step.split('\n').some((l) => /^\s*(?:-\s+)?(?:ref|repository):/.test(l) && PR_HEAD.test(l));
      if (prCheckout && /pull_request_target/.test(text)) out.push(`${n}: checks out the PR's own code under pull_request_target`);
    }
  });

  // 3. Top-level permissions, read only.
  const p = lines.findIndex((l) => /^permissions:/.test(l));
  if (p < 0) out.push(`${file}: no top-level permissions:`);
  else {
    const inline = stripComment(lines[p]!.replace(/^permissions:/, ''));
    const entries = inline ? [inline] : blockAfter(lines, p, 0).filter((l) => l.trim() && !isComment(l)).map((l) => stripComment(l.trim()));
    const ok = inline ? inline === '{}' || inline === 'read-all' : entries.length > 0 && entries.every((e) => /^[\w-]+:\s*(read|none)$/.test(e));
    if (!ok) out.push(`${file}: top-level permissions must be {}, read-all, or read and none only (got ${entries.join(', ') || 'nothing'})`);
  }

  // 5. No risky trigger.
  const on = lines.findIndex((l) => /^(on|'on'|"on"):/.test(l));
  const triggers = on < 0 ? '' : [lines[on]!, ...blockAfter(lines, on, 0)].join('\n');
  for (const t of RISKY_TRIGGERS) {
    if (new RegExp(`\\b${t}\\b`).test(triggers)) out.push(`${file}: risky trigger ${t} is not allowed`);
  }
  return out;
}

const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

describe('workflow rules', () => {
  it('there is at least one workflow to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s follows the rules', (f) => {
    expect(workflowProblems(f, readFileSync(join(DIR, f), 'utf8'))).toEqual([]);
  });
});

describe('workflow rules: planted bad examples fail', () => {
  const good = `name: x
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${'a'.repeat(40)} # v7
        with:
          persist-credentials: false
      - run: echo "$TITLE"
        env:
          TITLE: \${{ github.event.pull_request.title }}
`;
  const check = (text: string) => workflowProblems('w.yml', text);
  const checkout = `actions/checkout@${'a'.repeat(40)} # v7`;

  it('the good example passes (event text through env: is fine)', () => {
    expect(check(good)).toEqual([]);
  });

  it('1. an action pinned to a tag or a short sha fails; a local ./ action and a docker digest pass', () => {
    expect(check(good.replace(`@${'a'.repeat(40)}`, '@v7'))).toEqual(['w.yml:10: action not pinned to a full commit: actions/checkout@v7']);
    expect(check(good.replace(`@${'a'.repeat(40)}`, `@${'a'.repeat(7)}`))).toEqual([`w.yml:10: action not pinned to a full commit: actions/checkout@${'a'.repeat(7)}`]);
    expect(check(good.replace(checkout, './.github/actions/local'))).toEqual([]);
    expect(check(good.replace(checkout, `docker://alpine@sha256:${'b'.repeat(64)}`))).toEqual([]);
  });

  it('1b. a docker image pinned to a tag, not a digest, fails', () => {
    expect(check(good.replace(checkout, 'docker://alpine:3.19'))).toEqual(['w.yml:10: action not pinned to a full commit: docker://alpine:3.19']);
  });

  it('2. event text inside run:, one line or a block, fails', () => {
    expect(check(good.replace('run: echo "$TITLE"', 'run: echo "${{ github.event.pull_request.title }}"'))[0]).toMatch(/^w\.yml:13: github\.event/);
    const block = good.replace('      - run: echo "$TITLE"', '      - run: |\n          echo hi\n          echo "${{ github.head_ref }}"');
    expect(check(block)[0]).toMatch(/^w\.yml:13: github\.event or github\.head_ref/);
  });

  it.each([
    "${{ toJSON(github.event) }}",
    "${{ github.event['issue']['title'] }}",
    "${{ format('{0}', github.event.issue.title) }}",
    '${{ github.head_ref }}',
  ])('2b. %s inside run: fails', (expr) => {
    expect(check(good.replace('run: echo "$TITLE"', `run: echo "${expr}"`))[0]).toMatch(/^w\.yml:13: github\.event or github\.head_ref/);
  });

  it('2c. a run: block passes when its own env: keys carry event text', () => {
    expect(check(good.replace('      - run: echo "$TITLE"', '      - run: |\n          echo "$TITLE"'))).toEqual([]);
  });

  it('3. missing or write permissions fail; {}, read-all, and a comment after the key pass', () => {
    expect(check(good.replace('permissions:\n  contents: read\n', ''))).toEqual(['w.yml: no top-level permissions:']);
    expect(check(good.replace('contents: read', 'contents: write'))[0]).toMatch(/^w\.yml: top-level permissions must be/);
    expect(check(good.replace('permissions:\n  contents: read', 'permissions: write-all'))[0]).toMatch(/^w\.yml: top-level permissions must be/);
    expect(check(good.replace('permissions:\n  contents: read', 'permissions: {}'))).toEqual([]);
    expect(check(good.replace('permissions:\n  contents: read', 'permissions: read-all'))).toEqual([]);
    expect(check(good.replace('permissions:\n  contents: read', 'permissions: {} # no token scopes'))).toEqual([]);
    expect(check(good.replace('permissions:\n  contents: read', 'permissions: # read only\n  contents: read'))).toEqual([]);
  });

  it('4. a checkout that keeps credentials fails', () => {
    expect(check(good.replace('persist-credentials: false', 'fetch-depth: 1'))).toEqual(['w.yml:10: checkout without persist-credentials: false']);
  });

  it('5. a risky trigger fails, and PR code under pull_request_target fails (head sha, head_ref, head repo)', () => {
    expect(check(good.replace('  pull_request:', '  pull_request_target:'))).toEqual(['w.yml: risky trigger pull_request_target is not allowed']);
    expect(check(good.replace('  pull_request:', '  issue_comment:'))).toEqual(['w.yml: risky trigger issue_comment is not allowed']);

    const prCheckout = (extra: string, trigger = 'pull_request_target') =>
      good.replace('  pull_request:', `  ${trigger}:`).replace('persist-credentials: false', `persist-credentials: false\n          ${extra}`);
    const refused = "w.yml:10: checks out the PR's own code under pull_request_target";
    for (const extra of [
      'ref: ${{ github.event.pull_request.head.sha }}',
      'ref: ${{ github.head_ref }}',
      'repository: ${{ github.event.pull_request.head.repo.full_name }}',
    ]) {
      expect(check(prCheckout(extra))).toContain(refused);
    }
    expect(check(prCheckout('ref: ${{ github.event.pull_request.head.sha }}', 'pull_request'))).toEqual([]);
  });
});
