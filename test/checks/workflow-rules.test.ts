/**
 * Workflow rules (docs/research/GH-AGENTIC-WORKFLOWS.md, section 6 item 1): every file in .github/workflows/ must
 *  1. pin each `uses:` to a full 40-character commit (local `./` actions are fine);
 *  2. never put `${{ github.event.* }}` or `${{ github.head_ref }}` text inside a `run:` script (pass it through env);
 *  3. have a top-level `permissions:` that is `{}`, `read-all`, or only `read` and `none` entries;
 *  4. give every checkout `persist-credentials: false`;
 *  5. use `pull_request_target`, `workflow_run` or `issue_comment` only when it is on ALLOWED_RISKY_TRIGGERS below, and
 *     never check out the PR's own code under `pull_request_target`.
 * Text checks, no YAML library (no new dependency). Each rule has a planted bad example below that must fail.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = resolve(__dirname, '../../.github/workflows');
/** file name -> the risky triggers it may use. Adding one needs a reviewed PR. */
const ALLOWED_RISKY_TRIGGERS: Record<string, string[]> = {};
const RISKY_TRIGGERS = ['pull_request_target', 'workflow_run', 'issue_comment'];

const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => line.trimStart().startsWith('#');

/** The lines of the block that starts under `lines[i]` (deeper indent than `indent`), comments and blanks included. */
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
    if (uses && !uses.startsWith('./') && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(uses)) out.push(`${n}: action not pinned to a full commit: ${uses}`);

    // 2. No event text inside a run: script.
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run) {
      const script = [run[2]!, ...(/^[|>]/.test(run[2]!) ? blockAfter(lines, i, indentOf(line)) : [])].join('\n');
      if (/\$\{\{\s*github\.(event\.|head_ref)/.test(script)) out.push(`${n}: github.event or github.head_ref text inside run: (pass it through env:)`);
    }

    // 4. Checkout keeps no credentials.
    if (uses?.startsWith('actions/checkout@')) {
      const step = blockAfter(lines, i, indentOf(line) - (line.trimStart().startsWith('-') ? 0 : 2)).join('\n');
      if (!/persist-credentials:\s*false/.test(step)) out.push(`${n}: checkout without persist-credentials: false`);
      if (/ref:\s*\$\{\{\s*github\.event\.pull_request\.head/.test(step) && /pull_request_target/.test(text)) out.push(`${n}: checks out the PR's own code under pull_request_target`);
    }
  });

  // 3. Top-level permissions, read only.
  const p = lines.findIndex((l) => /^permissions:/.test(l));
  if (p < 0) out.push(`${file}: no top-level permissions:`);
  else {
    const inline = lines[p]!.replace(/^permissions:\s*/, '').replace(/\s+#.*$/, '').trim();
    const entries = inline ? [inline] : blockAfter(lines, p, 0).filter((l) => l.trim() && !isComment(l)).map((l) => l.trim().replace(/\s+#.*$/, ''));
    const ok = inline ? inline === '{}' || inline === 'read-all' : entries.length > 0 && entries.every((e) => /^[\w-]+:\s*(read|none)$/.test(e));
    if (!ok) out.push(`${file}: top-level permissions must be {}, read-all, or read and none only (got ${entries.join(', ') || 'nothing'})`);
  }

  // 5. Risky triggers only when allowed.
  const on = lines.findIndex((l) => /^(on|'on'|"on"):/.test(l));
  const triggers = on < 0 ? '' : [lines[on]!, ...blockAfter(lines, on, 0)].join('\n');
  for (const t of RISKY_TRIGGERS) {
    if (new RegExp(`\\b${t}\\b`).test(triggers) && !(ALLOWED_RISKY_TRIGGERS[file] ?? []).includes(t)) out.push(`${file}: trigger ${t} is not on the allowed list`);
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

  it('every allowed risky trigger names a workflow that exists', () => {
    for (const f of Object.keys(ALLOWED_RISKY_TRIGGERS)) expect(files).toContain(f);
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

  it('the good example passes (event text through env: is fine)', () => {
    expect(check(good)).toEqual([]);
  });

  it('1. an action pinned to a tag or branch fails', () => {
    expect(check(good.replace(`@${'a'.repeat(40)}`, '@v7'))).toEqual(['w.yml:10: action not pinned to a full commit: actions/checkout@v7']);
  });

  it('2. event text inside run:, one line or a block, fails', () => {
    expect(check(good.replace('run: echo "$TITLE"', 'run: echo "${{ github.event.pull_request.title }}"'))[0]).toMatch(/^w\.yml:13: github\.event/);
    const block = good.replace('      - run: echo "$TITLE"', '      - run: |\n          echo hi\n          echo "${{ github.head_ref }}"');
    expect(check(block)[0]).toMatch(/^w\.yml:13: github\.event or github\.head_ref/);
  });

  it('3. missing or write permissions fail; {} and read-all pass', () => {
    expect(check(good.replace('permissions:\n  contents: read\n', ''))).toEqual(['w.yml: no top-level permissions:']);
    expect(check(good.replace('contents: read', 'contents: write'))[0]).toMatch(/^w\.yml: top-level permissions must be/);
    expect(check(good.replace('permissions:\n  contents: read', 'permissions: write-all'))[0]).toMatch(/^w\.yml: top-level permissions must be/);
    expect(check(good.replace('permissions:\n  contents: read', 'permissions: {}'))).toEqual([]);
    expect(check(good.replace('permissions:\n  contents: read', 'permissions: read-all'))).toEqual([]);
  });

  it('4. a checkout that keeps credentials fails', () => {
    expect(check(good.replace('persist-credentials: false', 'fetch-depth: 1'))).toEqual(['w.yml:10: checkout without persist-credentials: false']);
  });

  it('5. a risky trigger fails unless allowed, and PR code is never checked out under pull_request_target', () => {
    expect(check(good.replace('  pull_request:', '  pull_request_target:'))).toEqual(['w.yml: trigger pull_request_target is not on the allowed list']);
    expect(check(good.replace('  pull_request:', '  issue_comment:'))).toEqual(['w.yml: trigger issue_comment is not on the allowed list']);
    const prCode = good
      .replace('  pull_request:', '  pull_request_target:')
      .replace('persist-credentials: false', 'persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}');
    expect(check(prCode)).toContain("w.yml:10: checks out the PR's own code under pull_request_target");
  });
});
