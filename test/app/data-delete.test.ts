/**
 * R10: `stephen data delete --all`. Every test uses a temp home, a temp job folder, a fake Keychain and a fake
 * Gmail disconnect: nothing here touches the real home folder, the real Keychain or the real ~/Stephen Jobs.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deleteAllData, KEYCHAIN_SERVICES, socketAnswers, unsafeToDelete, type DeleteDeps } from '../../src/app/data-cli.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-delete-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A temp Stephen home full of fixture files, a job folder, an outside folder a link points to, and fakes. */
function world(answers: string[], o: Partial<DeleteDeps> = {}) {
  const base = join(tmp, `w${n++}`);
  const home = join(base, 'home', '.stephen');
  const jobsRoot = join(base, 'home', 'Stephen Jobs');
  const outside = join(base, 'outside');
  for (const d of ['history', 'voice', 'telemetry', 'incidents', 'jobs', 'logs', 'run', 'replay']) mkdirSync(join(home, d), { recursive: true });
  for (const f of ['memory.json', 'memory-proposals.json', 'timers.json', 'config.json', 'audit.log', '.env', 'history/2026-11-25.jsonl', 'voice/conversation.json', 'voice/tool-log.jsonl', 'telemetry/latency-2026-11-25.jsonl', 'jobs/.announced.json', 'logs/listen.log']) {
    writeFileSync(join(home, f), 'x');
  }
  mkdirSync(join(jobsRoot, 'job-1'), { recursive: true });
  writeFileSync(join(jobsRoot, 'job-1', 'report.md'), 'the person\'s own file');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'keep.txt'), 'outside Stephen');
  symlinkSync(outside, join(home, 'link-out'));
  const transcriptDir = join(base, 'claude', 'projects', 'voice');
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(transcriptDir, '11111111-2222-4333-8444-555555555555.jsonl'), 't');

  const deleted: string[] = [];
  const disconnected: string[] = [];
  const out: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  const deps: DeleteDeps = {
    places: { home, jobsRoot },
    userHome: join(base, 'home'),
    ask: async (q) => {
      asked.push(q);
      return queue.shift() ?? '';
    },
    listenerAnswers: async () => false,
    gmailLabels: ['personal'],
    disconnectGmail: async (label) => {
      disconnected.push(label);
      return 0;
    },
    deleteKeychain: async (s) => {
      deleted.push(s);
      return s === 'stephen-canvas' ? 'deleted' : 'missing';
    },
    transcriptDir,
    out: (l) => out.push(l),
    err: (l) => out.push(`ERR ${l}`),
    ...o,
  };
  return { deps, home, jobsRoot, outside, transcriptDir, deleted, disconnected, out, asked };
}

describe('stephen data delete --all (R10)', () => {
  it('yes: the Stephen folder, the transcripts and every Keychain item go; a link target outside is kept', async () => {
    const w = world(['y', 'n']);
    expect(await deleteAllData(w.deps)).toBe(0);
    expect(existsSync(w.home)).toBe(false);
    expect(existsSync(join(w.transcriptDir, '11111111-2222-4333-8444-555555555555.jsonl'))).toBe(false);
    expect(w.deleted).toEqual([...KEYCHAIN_SERVICES]);
    expect(w.deleted).toEqual(expect.arrayContaining(['stephen-canvas', 'stephen-notion', 'stephen-calendar-ics', 'stephen-google-oauth', 'stephen-elevenlabs']));
    expect(w.disconnected).toEqual(['personal']);
    expect(existsSync(join(w.outside, 'keep.txt'))).toBe(true); // the link was removed, not followed
    expect(existsSync(join(w.jobsRoot, 'job-1', 'report.md'))).toBe(true); // second answer was no
    expect(w.asked).toEqual(['Delete all of this? [y/N] ', expect.stringContaining('It holds your job output files. [y/N]')]);
    expect(w.out).toContain('Deleted the Keychain item stephen-canvas.');
    expect(w.out.some((l) => l.startsWith('Deleted ~/.stephen'))).toBe(true);
    expect(w.out).toContain('Kept ~/Stephen Jobs.');
  });

  it('the job folder goes only after its own yes', async () => {
    const w = world(['yes', 'y']);
    expect(await deleteAllData(w.deps)).toBe(0);
    expect(existsSync(w.jobsRoot)).toBe(false);
    expect(w.out).toContain('Deleted ~/Stephen Jobs.');
  });

  it('a job folder that is a link: only the link goes, never what it points to', async () => {
    const w = world(['y', 'y']);
    const real = join(w.outside, 'Real Jobs');
    mkdirSync(real);
    writeFileSync(join(real, 'mine.txt'), 'x');
    rmSync(w.jobsRoot, { recursive: true });
    symlinkSync(real, w.jobsRoot);
    expect(await deleteAllData(w.deps)).toBe(0);
    expect(existsSync(w.jobsRoot)).toBe(false);
    expect(existsSync(join(real, 'mine.txt'))).toBe(true);
  });

  it('a job folder inside the Stephen folder is kept on no', async () => {
    const w = world(['y', 'n']);
    const inner = join(w.home, 'jobs-out');
    mkdirSync(join(inner, 'job-2'), { recursive: true });
    writeFileSync(join(inner, 'job-2', 'mine.txt'), 'x');
    w.deps.places = { home: w.home, jobsRoot: inner };
    expect(await deleteAllData(w.deps)).toBe(0);
    expect(existsSync(join(inner, 'job-2', 'mine.txt'))).toBe(true);
    expect(existsSync(join(w.home, 'memory.json'))).toBe(false);
  });

  it.each([['n'], [''], ['no'], ['maybe']])('answer %j: nothing is deleted', async (a) => {
    const w = world([a]);
    expect(await deleteAllData(w.deps)).toBe(0);
    expect(existsSync(join(w.home, 'memory.json'))).toBe(true);
    expect(existsSync(join(w.transcriptDir, '11111111-2222-4333-8444-555555555555.jsonl'))).toBe(true);
    expect(w.deleted).toEqual([]);
    expect(w.disconnected).toEqual([]);
    expect(w.out).toContain('Nothing was deleted.');
  });

  it('refuses while stephen listen answers on app.sock, before asking anything', async () => {
    const base = join(tmp, `sock${n++}`);
    mkdirSync(join(base, 'run'), { recursive: true });
    const sock = join(base, 'run', 'app.sock');
    const server: Server = createServer((c) => c.end());
    await new Promise<void>((r) => server.listen(sock, () => r()));
    try {
      expect(await socketAnswers(sock)).toBe(true);
      const w = world(['y'], { listenerAnswers: () => socketAnswers(sock) });
      expect(await deleteAllData(w.deps)).toBe(1);
      expect(w.out).toContain('ERR Quit Stephen first.');
      expect(w.asked).toEqual([]);
      expect(existsSync(join(w.home, 'memory.json'))).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(await socketAnswers(join(base, 'run', 'none.sock'))).toBe(false);
  });

  it('refuses with no terminal to ask in', async () => {
    const w = world([], { ask: null });
    expect(await deleteAllData(w.deps)).toBe(1);
    expect(existsSync(join(w.home, 'memory.json'))).toBe(true);
    expect(w.deleted).toEqual([]);
  });

  it('never deletes the disk root, the person\'s home folder, or a folder above it', async () => {
    const real = homedir();
    expect(unsafeToDelete('/', real)).toBe(true);
    expect(unsafeToDelete(real, real)).toBe(true);
    expect(unsafeToDelete(join(real, '..'), real)).toBe(true);
    expect(unsafeToDelete(join(real, '.stephen'), real)).toBe(false);
    for (const home of ['/', real]) {
      const w = world(['y', 'y']);
      w.deps.places = { home, jobsRoot: w.jobsRoot };
      w.deps.userHome = real;
      expect(await deleteAllData(w.deps)).toBe(1);
      expect(w.asked).toEqual([]);
      expect(w.deleted).toEqual([]);
    }
  });

  it('a Keychain item that cannot be deleted is reported and the exit code is 1', async () => {
    const w = world(['y', 'n'], { deleteKeychain: async () => 'locked' });
    expect(await deleteAllData(w.deps)).toBe(1);
    expect(w.out.some((l) => l.startsWith('ERR Could not delete the Keychain item'))).toBe(true);
  });
});
