/**
 * `stephen mac-checks [--json]` (issue #91, docs/MAC-TEST-PLAN.md section 13): one pass or fail per technical check of
 * the latency monitor and the command id, so the owner only has to do things and see things.
 *
 * Read-only. It lists folders, reads modes with lstat, and reads the small log files to count and compare ids.
 * It never prints file contents: output is check titles, ids, counts, modes and paths under Stephen's home.
 * The steps of section 13 that need hands or eyes (tap F5, press Esc, "does it feel slow") are not here.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { helperLogPath } from '../helper/paths.js';
import { COMMAND_ID_RE } from '../lib/command-id.js';
import { LATENCY_OUTCOMES, LATENCY_RETENTION_DAYS, LATENCY_ROUTES, LATENCY_STAGES, LATENCY_TRIGGERS, latencyDir } from '../telemetry/latency.js';

export type CheckStatus = 'pass' | 'fail' | 'skip';
export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}
export interface CheckEnv {
  home: string;
  auditLog: string;
  now: Date;
  platform: string;
}

export const MAC_CHECKS_HELP = `stephen mac-checks: pass or fail for the technical checks of the Mac test plan, section 13

  stephen mac-checks [--json]

Read only. Shows ids, counts, modes and paths. Never shows what you said.
Exit 0 = nothing failed, 1 = something failed, 2 = bad arguments.`;

const MAX_READ = 32 * 1024 * 1024;
const DAY_MS = 86_400_000;
const FILE_RE = /^latency-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const KEYS = new Set(['v', 'id', 'ts', 'trigger', 'route', 'tier', 'outcome', 'followUp', 'turns', 'stages', 'loopP99Ms', 'modelMs', 'toolMs', 'firstTokenMs']);
const pass = (id: string, title: string, detail = ''): CheckResult => ({ id, title, status: 'pass', detail });
const fail = (id: string, title: string, detail: string): CheckResult => ({ id, title, status: 'fail', detail });
const skip = (id: string, title: string, detail: string): CheckResult => ({ id, title, status: 'skip', detail });

const octal = (m: number) => (m & 0o777).toString(8).padStart(4, '0');
const day = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const statOf = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const names = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
/** The file's text, or null when it is missing, not a plain file (a symlink counts as not plain), or too big. */
function text(p: string): string | null {
  const st = statOf(p);
  if (!st?.isFile() || st.size > MAX_READ) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
const lines = (t: string) => t.split('\n').filter((l) => l.trim());
const rel = (e: CheckEnv, p: string) => (p.startsWith(e.home) ? `~${p.slice(e.home.length)}` : p);

function latencyFiles(e: CheckEnv): string[] {
  return names(latencyDir(e.home)).filter((n) => FILE_RE.test(n)).sort();
}
/** Parsed latency lines of every day file (objects only; a line that is not JSON is returned as null). */
function latencyLines(e: CheckEnv): { file: string; row: Record<string, unknown> | null }[] {
  return latencyFiles(e).flatMap((file) =>
    lines(text(join(latencyDir(e.home), file)) ?? '').map((l) => {
      try {
        const v: unknown = JSON.parse(l);
        return { file, row: v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null };
      } catch {
        return { file, row: null };
      }
    }),
  );
}
function toolLogIds(e: CheckEnv): string[] | null {
  const t = text(join(e.home, 'voice', 'tool-log.jsonl'));
  if (t === null) return null;
  const ids = new Set<string>();
  for (const l of lines(t)) {
    try {
      const c = (JSON.parse(l) as { cmd?: unknown }).cmd;
      if (typeof c === 'string') ids.add(c);
    } catch {
      /* a bad line has no id */
    }
  }
  return [...ids];
}
/** Mode check shared by the folder and file checks: real (not a link), and exactly `mode`. */
function modeProblem(p: string, want: 'dir' | 'file', mode: number): string | null {
  const st = statOf(p);
  if (!st) return null;
  if (st.isSymbolicLink()) return `${p} is a link`;
  if (want === 'dir' ? !st.isDirectory() : !st.isFile()) return `${p} is not a ${want === 'dir' ? 'folder' : 'plain file'}`;
  return (st.mode & 0o777) === mode ? null : `${p} has mode ${octal(st.mode)}, expected ${octal(mode)}`;
}

/**
 * helper.log lines (helper/main.swift) that say the key listener is on or off. Matched at the start of the message,
 * after the ISO timestamp the helper writes. Anything else in the log is ignored and never shown.
 */
const TAP_START = 'Stephen Helper ';
const TAP_ON = ['event tap installed', 'Input Monitoring available; listening'];
const TAP_OFF = ['event tap could not be created', 'event tap found disabled', 'Input Monitoring not granted'];
const KEYS_FIX = 'open System Settings, Privacy & Security, Input Monitoring: remove Stephen Helper, add it again, then quit and reopen it';
/** Newest tap line since the helper's last start: its fixed phrase, timestamp and whether the tap is on. */
function lastTapLine(log: string): { started: boolean; tap: { on: boolean; phrase: string; at: string } | null } {
  let started = false;
  let tap: { on: boolean; phrase: string; at: string } | null = null;
  for (const l of lines(log)) {
    const m = /^(\S+) (.*)$/.exec(l);
    if (!m || !ISO_RE.test(m[1]!)) continue;
    const msg = m[2]!;
    if (msg.startsWith(TAP_START) && msg.includes(' starting, pid ')) (started = true), (tap = null);
    const on = TAP_ON.find((p) => msg.startsWith(p));
    const off = TAP_OFF.find((p) => msg.startsWith(p));
    if (on || off) tap = { on: !!on, phrase: (on ?? off)!, at: m[1]! };
  }
  return { started, tap };
}

type Check = (e: CheckEnv) => CheckResult;

const ID = {
  keys: '0.k1',
  dir: '13.1a',
  files: '13.1b',
  shape: '13.1c',
  words: '13.1d',
  keep: '13.1e',
  tool: '13.3a',
  inLatency: '13.3b',
  inHistory: '13.3c',
  inAudit: '13.3d',
  cmdFile: '13.3e',
  cmdSame: '13.3f',
};

export const CHECKS: Check[] = [
  (e) => {
    const t = 'the key listener is on (Input Monitoring granted, F5 and Esc reach Stephen)';
    if (e.platform !== 'darwin') return skip(ID.keys, t, 'the key listener only exists on macOS');
    const log = text(helperLogPath(e.home));
    if (log === null) return skip(ID.keys, t, 'no helper log yet: open Stephen Helper first');
    const { started, tap } = lastTapLine(log);
    if (!started) return skip(ID.keys, t, 'the helper log has no start line: reopen Stephen Helper');
    if (!tap) return skip(ID.keys, t, 'the helper started but has not reported the key listener yet (it may have been rebuilt): reopen Stephen Helper and check again');
    const said = `"${tap.phrase}" at ${tap.at}`;
    return tap.on ? pass(ID.keys, t, said) : fail(ID.keys, t, `${said}; ${KEYS_FIX}`);
  },
  (e) => {
    const t = 'the latency folder is private (0700)';
    if (e.platform === 'win32') return skip(ID.dir, t, 'file modes are not checked on Windows');
    const dir = latencyDir(e.home);
    if (!statOf(dir)) return skip(ID.dir, t, 'no latency folder yet: give a command first');
    const bad = modeProblem(dir, 'dir', 0o700);
    return bad ? fail(ID.dir, t, rel(e, bad)) : pass(ID.dir, t, rel(e, dir));
  },
  (e) => {
    const t = 'latency files are private (0600, plain files)';
    if (e.platform === 'win32') return skip(ID.files, t, 'file modes are not checked on Windows');
    const files = latencyFiles(e);
    if (!files.length) return skip(ID.files, t, 'no latency file yet: give a command first');
    const bad = files.map((f) => modeProblem(join(latencyDir(e.home), f), 'file', 0o600)).filter(Boolean);
    return bad.length ? fail(ID.files, t, bad.map((b) => rel(e, b!)).join('; ')) : pass(ID.files, t, `${files.length} file(s)`);
  },
  (e) => {
    const t = 'every latency line has a command id and known words';
    const rows = latencyLines(e);
    if (!rows.length) return skip(ID.shape, t, 'no latency lines yet: give a command first');
    let bad = 0;
    for (const { row } of rows) {
      const ok =
        row &&
        row.v === 1 &&
        typeof row.id === 'string' &&
        COMMAND_ID_RE.test(row.id) &&
        typeof row.ts === 'string' &&
        ISO_RE.test(row.ts) &&
        (LATENCY_TRIGGERS as readonly unknown[]).includes(row.trigger) &&
        (LATENCY_OUTCOMES as readonly unknown[]).includes(row.outcome) &&
        (row.route === null || (LATENCY_ROUTES as readonly unknown[]).includes(row.route));
      if (!ok) bad++;
    }
    return bad ? fail(ID.shape, t, `${bad} of ${rows.length} line(s) are not in the expected shape`) : pass(ID.shape, t, `${rows.length} line(s)`);
  },
  (e) => {
    const t = 'latency lines hold only numbers and fixed words (nothing you said)';
    const rows = latencyLines(e);
    if (!rows.length) return skip(ID.words, t, 'no latency lines yet: give a command first');
    let bad = 0;
    for (const { row } of rows) {
      const stages = row?.stages;
      const stageOk =
        stages === undefined ||
        (!!stages && typeof stages === 'object' && Object.entries(stages).every(([k, v]) => (LATENCY_STAGES as readonly string[]).includes(k) && typeof v === 'number'));
      const word = (k: string) => ['id', 'ts', 'trigger', 'route', 'outcome'].includes(k);
      const keysOk = !!row && Object.entries(row).every(([k, v]) => KEYS.has(k) && (k === 'stages' ? typeof v === 'object' : typeof v === 'string' ? word(k) : v === null || typeof v === 'number' || typeof v === 'boolean'));
      if (!keysOk || !stageOk) bad++;
    }
    return bad ? fail(ID.words, t, `${bad} of ${rows.length} line(s) hold a field that is not a number or a fixed word`) : pass(ID.words, t, `${rows.length} line(s)`);
  },
  (e) => {
    const t = `no latency file is older than ${LATENCY_RETENTION_DAYS} days`;
    const files = latencyFiles(e);
    if (!files.length) return skip(ID.keep, t, 'no latency file yet: give a command first');
    // One extra day of slack: old files are deleted when the listener starts, not at midnight.
    const first = day(new Date(e.now.getTime() - (LATENCY_RETENTION_DAYS + 1) * DAY_MS));
    const old = files.filter((f) => FILE_RE.exec(f)![1]! < first);
    return old.length ? fail(ID.keep, t, `${old.length} old file(s), oldest ${old[0]}`) : pass(ID.keep, t, `${files.length} file(s)`);
  },
  (e) => {
    const t = 'the tool log names exactly one command';
    const ids = toolLogIds(e);
    if (ids === null) return skip(ID.tool, t, 'no tool log yet: give a browser command first');
    if (!ids.length) return skip(ID.tool, t, 'the tool log has no command id yet: give a browser command first');
    return ids.length === 1 && COMMAND_ID_RE.test(ids[0]!) ? pass(ID.tool, t, ids[0]!) : fail(ID.tool, t, `${ids.length} different ids: ${ids.slice(0, 3).join(' ')}`);
  },
  ...(
    [
      [ID.inLatency, 'that command id is in the latency log', (e: CheckEnv) => latencyFiles(e).map((f) => text(join(latencyDir(e.home), f)) ?? '').join('\n')],
      [ID.inHistory, 'that command id is in the history', (e: CheckEnv) => names(join(e.home, 'history')).filter((n) => n.endsWith('.jsonl')).map((f) => text(join(e.home, 'history', f)) ?? '').join('\n')],
      [ID.inAudit, 'that command id is in the audit log', (e: CheckEnv) => text(e.auditLog) ?? ''],
    ] as const
  ).map(([id, title, read]): Check => (e) => {
    const ids = toolLogIds(e);
    if (!ids || ids.length !== 1) return skip(id, title, 'needs a tool log with one command id first');
    const n = read(e).split(ids[0]!).length - 1;
    return n ? pass(id, title, `${ids[0]} found ${n} time(s)`) : fail(id, title, `${ids[0]} not found`);
  }),
  (e) => {
    const t = 'the command id file is private (0600)';
    if (e.platform === 'win32') return skip(ID.cmdFile, t, 'file modes are not checked on Windows');
    const p = join(e.home, 'voice', 'command.json');
    if (!statOf(p)) return skip(ID.cmdFile, t, 'no command id file yet: give a browser command first');
    const bad = modeProblem(p, 'file', 0o600);
    return bad ? fail(ID.cmdFile, t, rel(e, bad)) : pass(ID.cmdFile, t, rel(e, p));
  },
  (e) => {
    const t = 'the command id file holds the same id as the tool log';
    const raw = text(join(e.home, 'voice', 'command.json'));
    const ids = toolLogIds(e);
    if (raw === null || !ids || ids.length !== 1) return skip(ID.cmdSame, t, 'needs a command id file and a tool log with one id');
    let id: unknown;
    try {
      id = (JSON.parse(raw) as { id?: unknown }).id;
    } catch {
      id = undefined;
    }
    return id === ids[0] ? pass(ID.cmdSame, t, ids[0]) : fail(ID.cmdSame, t, 'the ids differ or the file is not {"id":"h_..."}');
  },
];

export function runChecks(e: CheckEnv): CheckResult[] {
  return CHECKS.map((c) => {
    try {
      return c(e);
    } catch (x) {
      return fail('13.?', 'a check could not run', (x as Error).message.slice(0, 120));
    }
  });
}

export interface MacChecksIo {
  out?: (l: string) => void;
  err?: (l: string) => void;
  env?: CheckEnv;
}

export async function runMacChecksCli(argv: string[], io: MacChecksIo = {}): Promise<number> {
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  if (argv.includes('--help') || argv.includes('-h')) return out(MAC_CHECKS_HELP), 0;
  const bad = argv.find((a) => a !== '--json');
  if (bad) return err(`Unknown option "${bad}" for mac-checks.\n\n${MAC_CHECKS_HELP}`), 2;
  const c = io.env ? null : loadConfig();
  const env: CheckEnv = io.env ?? { home: c!.home, auditLog: c!.auditLogPath, now: new Date(), platform: process.platform };
  const results = runChecks(env);
  const n = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  if (argv.includes('--json')) out(JSON.stringify({ results, pass: n('pass'), fail: n('fail'), skip: n('skip') }, null, 2));
  else {
    for (const r of results) out(`${r.status.toUpperCase().padEnd(4)}  ${r.id}  ${r.title}${r.detail ? ` (${r.detail})` : ''}`);
    out(`${n('pass')} passed, ${n('fail')} failed, ${n('skip')} skipped`);
  }
  return n('fail') ? 1 : 0;
}
