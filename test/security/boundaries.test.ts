/**
 * Named boundary rules (research item 4, Lauren Tan: a rule with a failing test beats a sentence). Two AGENTS.md
 * safety rules as pinned lists:
 *   A. The model never writes memory, timers or jobs: only the listed files load or build the write stores.
 *   B. Only src/safety/ decides Allow or Deny: only the listed files outside it build a confirmer, settle an answer
 *      or make an "allowed" gate result.
 * A new name on a list fails the test. Adding it is a [DEV REVIEW] change: show why the new file is owner-only.
 * The folder-level rules (nothing Claude reaches loads src/memory, src/timers, src/jobs) are in
 * test/memory/boundary.test.ts.
 * Limits: the scan reads imports and text. A new file that writes the store files directly by path (fs calls on
 * memory.json, timers.json or a job state file) is not caught here.
 */
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, listTsFiles, scanSrc, type ImportRef } from '../helpers/import-scan.js';

interface SrcFile {
  file: string;
  src: string;
}

const SRC: readonly SrcFile[] = listTsFiles().map((abs) => ({ file: relative(REPO_ROOT, abs).split(sep).join('/'), src: readFileSync(abs, 'utf8') }));

const folderOf = (f: string) => f.slice(0, f.lastIndexOf('/') + 1);

/** Files outside the target's own folder with a runtime (value) import of it. */
function valueImporters(target: string, refs: readonly ImportRef[]): string[] {
  const own = folderOf(target);
  return [...new Set(refs.filter((r) => r.resolved === target && !r.typeOnly && !r.from.startsWith(own)).map((r) => `${r.from}${r.dynamic ? ' (dynamic)' : ''}`))].sort();
}

/** Files outside `ownFolder` whose text matches `re`. */
function users(re: RegExp, files: readonly SrcFile[], ownFolder: string): string[] {
  return files.filter((f) => !f.file.startsWith(ownFolder) && re.test(f.src)).map((f) => f.file).sort();
}

// Rule A: the write stores and who may load or build them.
const WRITE_STORES: Record<string, string[]> = {
  'src/memory/store.ts': ['src/app/data-export.ts', 'src/app/server.ts', 'src/timers/router.ts', 'src/timers/store.ts', 'src/voice/claude.ts', 'src/voice/index.ts', 'src/voice/memory-router.ts'],
  'src/memory/proposals.ts': ['src/app/protocol.ts', 'src/voice/index.ts'],
  'src/timers/store.ts': ['src/app/data-export.ts', 'src/voice/index.ts'],
  'src/jobs/manager.ts': ['src/voice/index.ts'],
  'src/jobs/state.ts': ['src/cli.ts (dynamic)', 'src/voice/index.ts', 'src/voice/job-rows.ts'],
  // Writes job state when a job finishes.
  'src/jobs/finish.ts': ['src/voice/index.ts'],
  // The owner-only CLIs, loaded on demand by `stephen memory` and `stephen jobs`.
  'src/memory/cli.ts': ['src/cli.ts (dynamic)'],
  'src/jobs/cli.ts': ['src/cli.ts (dynamic)'],
};

const WRITE_BUILDERS: { name: string; re: RegExp; own: string; files: string[] }[] = [
  { name: 'new MemoryStore', re: /\bnew MemoryStore\(/, own: 'src/memory/', files: ['src/voice/index.ts'] },
  { name: 'new ProposalStore', re: /\bnew ProposalStore\(/, own: 'src/memory/', files: ['src/voice/index.ts'] },
  { name: 'new TimerStore', re: /\bnew TimerStore\(/, own: 'src/timers/', files: ['src/voice/index.ts'] },
  { name: 'new JobManager', re: /\bnew JobManager\(/, own: 'src/jobs/', files: ['src/voice/index.ts'] },
  { name: 'writeJobState', re: /\bwriteJobState\(/, own: 'src/jobs/', files: [] },
  { name: 'new FinishWatcher', re: /\bnew FinishWatcher\(/, own: 'src/jobs/', files: ['src/voice/index.ts'] },
  // The routers write through the stores; `own` is the defining file, so its folder neighbours still count.
  { name: 'new TimerRouter', re: /\bnew TimerRouter\(/, own: 'src/timers/router.ts', files: ['src/voice/index.ts'] },
  { name: 'new JobRouter', re: /\bnew JobRouter\(/, own: 'src/jobs/router.ts', files: ['src/voice/index.ts'] },
  { name: 'new MemoryRouter', re: /\bnew MemoryRouter\(/, own: 'src/voice/memory-router.ts', files: ['src/voice/index.ts'] },
];

/** 'approved' not right after === or !==. */
const APPROVED_VALUE = /(?<![!=]==\s?)'approved'/;

// Rule B: who outside src/safety/ may build a confirmer, settle an answer or make an allowed gate result.
const DECIDERS: { name: string; re: RegExp; files: string[] }[] = [
  // The MCP hub builds the gate's confirmer from config.
  { name: 'buildConfirmer', re: /\bbuildConfirmer\(/, files: ['src/server/hub.ts'] },
  // The owner-only memory, timer and job dialogs in the listener.
  { name: 'new *Confirmer', re: /\bnew \w*Confirmer\(/, files: ['src/voice/index.ts'] },
  { name: 'implements Confirmer or ISafetyGate', re: /\bimplements\s+(?:Confirmer|ISafetyGate)\b/, files: [] },
  // The window's Allow or Deny click (confirm.answer on app.sock).
  { name: 'settle an answer', re: /\.settle\([^)]*'approved'/, files: ['src/app/server.ts'] },
  // 'approved' made as a value, not compared (a type, an object-literal confirmer's answer, an audit row).
  { name: "'approved' as a value", re: APPROVED_VALUE, files: ['src/app/protocol.ts', 'src/app/server.ts', 'src/jobs/manager.ts', 'src/jobs/router.ts', 'src/types.ts'] },
  // Dismissing a page dialog is always the safe direction (handle_dialog with accept false).
  { name: 'allowed: true', re: /\ballowed:\s*true\b/, files: ['src/server/tools.ts'] },
];

describe('rule A: the model never writes memory, timers or jobs', () => {
  const refs = scanSrc();

  for (const [target, pinned] of Object.entries(WRITE_STORES)) {
    it(`only the listed files load ${target}`, () => {
      expect(valueImporters(target, refs), `a new file loads ${target}; it must be owner-only ([DEV REVIEW])`).toEqual(pinned);
    });
  }

  for (const b of WRITE_BUILDERS) {
    it(`only the listed files call ${b.name}`, () => {
      expect(users(b.re, SRC, b.own), `a new file calls ${b.name}; it must be owner-only ([DEV REVIEW])`).toEqual(b.files);
    });
  }

  it('the rules fire on a new importer and a new builder', () => {
    const fake: ImportRef = { from: 'src/server/new-tool.ts', spec: '../memory/store.js', resolved: 'src/memory/store.ts', typeOnly: false };
    expect(valueImporters('src/memory/store.ts', [...refs, fake])).toContain('src/server/new-tool.ts');
    // A type-only import is not a write path.
    expect(valueImporters('src/memory/store.ts', [{ ...fake, typeOnly: true }])).toEqual([]);
    const files = [...SRC, { file: 'src/server/new-tool.ts', src: 'const s = new MemoryStore({ home });' }];
    expect(users(WRITE_BUILDERS[0]!.re, files, 'src/memory/')).toContain('src/server/new-tool.ts');
  });
});

describe('rule B: only src/safety/ decides Allow or Deny', () => {
  for (const d of DECIDERS) {
    it(`outside src/safety/, only the listed files match "${d.name}"`, () => {
      expect(users(d.re, SRC, 'src/safety/'), `a new file can decide Allow or Deny (${d.name}); [DEV REVIEW]`).toEqual(d.files);
    });
  }

  it('the rules fire on a fake allow-all confirmer and a fake allowed result', () => {
    const files = [
      ...SRC,
      { file: 'src/page/yes.ts', src: "class Yes implements Confirmer { async confirm() { return 'approved'; } }" },
      { file: 'src/page/skip.ts', src: 'const g = { allowed: true, message: "" };' },
      { file: 'src/page/lit.ts', src: "const c = { kind: 'x', confirm: async () => 'approved' as const };" },
      { file: 'src/page/check.ts', src: "if (answer !== 'approved') return;" },
    ];
    const approved = users(APPROVED_VALUE, files, 'src/safety/');
    expect(approved).toContain('src/page/lit.ts');
    expect(approved).not.toContain('src/page/check.ts');
    expect(users(DECIDERS[2]!.re, files, 'src/safety/')).toEqual(['src/page/yes.ts']);
    expect(users(DECIDERS.find((d) => d.name === 'allowed: true')!.re, files, 'src/safety/')).toContain('src/page/skip.ts');
    // Code inside src/safety/ is the decider and is not on the list.
    expect(users(DECIDERS[0]!.re, SRC, 'none/')).toContain('src/safety/index.ts');
  });
});
