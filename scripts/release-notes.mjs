// F14: the release notes for one version, as plain text for friends, from CHANGELOG.md.
//   node scripts/release-notes.mjs <version> [path/to/CHANGELOG.md]
//   node scripts/release-notes.mjs --sheet   (release checklist steps 4 and 9 as one block, see below)
// The changelog format (see CHANGELOG.md): "## <version> (<date>)", then "### Added", "### Changed" or "### Fixed",
// then "- " bullets. The output drops Markdown (links keep their words, no backticks or bold), so it reads the same
// in an update window, a DMG note or a chat message. The appcast part waits for F6 and F7.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEADINGS = { added: 'New', changed: 'Changed', fixed: 'Fixed', removed: 'Removed', security: 'Safety' };

/** Markdown inline marks → plain words. Pure. */
export function plain(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links keep their words
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g, '$1$2') // *italics*
    .replace(/(^|[^\w])_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, '$1$2') // _italics_, never snake_case
    .replace(/\s+/g, ' ')
    .trim();
}

/** The plain notes for `version`, or null when the changelog has no such section. Pure. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n');
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((l) => new RegExp(`^## \\[?${esc}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  const date = /\((\d{4}-\d{2}-\d{2})\)/.exec(lines[start])?.[1];
  const head = `Stephen ${version}${date ? ` (${date})` : ''}`;
  // Sections in order; a heading with no bullets is left out, so no label stands alone.
  const sections = [{ label: null, bullets: [] }];
  let bullet = null;
  const flush = () => {
    if (bullet !== null) sections.at(-1).bullets.push(`- ${plain(bullet)}`);
    bullet = null;
  };
  for (const l of lines.slice(start + 1)) {
    if (/^## /.test(l)) break;
    const h = /^### +(.+)$/.exec(l);
    if (h) {
      flush();
      const key = h[1].trim().toLowerCase();
      sections.push({ label: `${HEADINGS[key] ?? plain(h[1])}:`, bullets: [] });
    } else if (/^\s*[-*] +/.test(l)) {
      flush();
      bullet = l.replace(/^\s*[-*] +/, '');
    } else if (bullet !== null && l.trim()) bullet += ` ${l.trim()}`; // a wrapped bullet
  }
  flush();
  const out = [head];
  for (const sec of sections.filter((x) => x.bullets.length)) out.push(...(sec.label ? ['', sec.label] : []), ...sec.bullets);
  return out.length > 1 ? out.join('\n') : null;
}

// Secret shapes for step 9. A hit prints only file and line, never the text.
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[sr]k_live_[A-Za-z0-9]{16,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
];

/** Step 9: added lines of a `git diff -U0` that look like a secret, and any .env file. Pure. */
export function secretHits(diff) {
  const hits = [];
  let file = null;
  let line = 0;
  let inHunk = false; // a "+++ b/" line is a file header only before the first @@ of a file
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) inHunk = false;
    // git adds a tab after a path with a space; a path git still quotes keeps its quotes off here
    const f = inHunk ? null : /^\+\+\+ "?b\/(.+?)"?\t?$/.exec(l);
    if (f) {
      file = f[1];
      if (/(^|\/)\.env(\.|$)/.test(file) && !/\.example$/.test(file)) hits.push(`${file} (env file)`);
      continue;
    }
    const h = /^@@ -\S+ \+(\d+)/.exec(l);
    if (h) {
      line = Number(h[1]);
      inHunk = true;
    } else if (inHunk && l.startsWith('+')) {
      if (SECRET.some((re) => re.test(l))) hits.push(`${file}:${line}`);
      line++;
    }
  }
  return hits;
}

/** Vitest's "Tests  4566 passed | 6 skipped | 3 todo (4575)" line as numbers. Pure. */
export function testTotals(out) {
  const row = out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').findLast((l) => /^\s*Tests\s/.test(l)) ?? '';
  const n = (w) => Number(new RegExp(`(\\d+) ${w}`).exec(row)?.[1] ?? 0);
  return { found: row !== '', passed: n('passed'), failed: n('failed'), skipped: n('skipped') };
}

/**
 * Release checklist steps 4 and 9 as one plain block. `run(cmd, args)` returns { code, out }; the real one runs
 * the command with no shell. It writes no files of its own (the build writes dist/) and never pushes. Mac steps stay manual.
 */
export function sheet(run) {
  const step = (cmd, args) => run(cmd, args).code === 0;
  const fetched = step('git', ['fetch', 'origin', 'main', 'qa']); // so origin/qa and origin/main are not stale
  const head = run('git', ['rev-parse', 'HEAD']).out.trim();
  const qa = run('git', ['rev-parse', 'origin/qa']).out.trim();
  const build = step('npm', ['run', 'build']);
  const typecheck = step('npm', ['run', 'typecheck']);
  const tests = run('npx', ['vitest', 'run']);
  const t = testTotals(tests.out);
  // A failed git diff prints its error into out, which would read as "no files, no secrets": it must fail instead.
  const names = run('git', ['diff', '--name-only', 'origin/main..origin/qa']);
  const diff = run('git', ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-renames', 'origin/main..origin/qa']);
  const diffed = names.code === 0 && diff.code === 0;
  const files = names.out.split('\n').filter(Boolean).length;
  const secrets = secretHits(diff.out);
  const ok = fetched && diffed && head === qa && build && typecheck && tests.code === 0 && t.found && t.failed === 0 && !secrets.length;
  const lines = [
    `Release number sheet (checklist steps 4 and 9)`,
    `Fetch origin main and qa: ${fetched ? 'pass' : 'FAIL'}`,
    `Commit: ${head}${head === qa ? ' (same as origin/qa)' : ` (NOT origin/qa ${qa})`}`,
    `Build: ${build ? 'pass' : 'FAIL'}`,
    `Typecheck: ${typecheck ? 'pass' : 'FAIL'}`,
    t.found
      ? `Tests: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped${tests.code === 0 ? '' : ' (suite exit not 0)'}`
      : 'Tests: FAIL (no totals line)',
    names.code === 0 ? `Files changed origin/main..origin/qa: ${files}` : 'Files changed: FAIL (git diff did not run)',
    diff.code !== 0 ? 'Secrets scan: FAIL (git diff did not run)' : secrets.length ? `Secrets scan: FAIL, check ${secrets.join(', ')}` : 'Secrets scan: clean',
    `Result: ${ok ? 'ready for the Mac steps' : 'NOT ready'}`,
  ];
  return { ok, text: lines.join('\n') };
}

const realRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === '--sheet') {
  const { ok, text } = sheet(realRun);
  console.log(text);
  process.exit(ok ? 0 : 1);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
  if (!version) {
    console.error('Usage: node scripts/release-notes.mjs <version> [CHANGELOG.md]');
    process.exit(2);
  }
  const notes = releaseNotes(readFileSync(file, 'utf8'), version);
  if (!notes) {
    console.error(`${file} has no notes for ${version}. Add a "## ${version} (YYYY-MM-DD)" section with bullets.`);
    process.exit(1);
  }
  console.log(notes);
}
