/** src/lib/fs.ts and src/lib/process.ts: the one private-file writer/reader, private folders, pid probe. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendPrivateLineCapped, ensurePrivateDir, isExecutable, readPrivateJsonFile, readPrivateRegularFile, writePrivateFileAtomicSync, writePrivateJsonFileSync } from '../../src/lib/fs.js';
import { isPidAlive } from '../../src/lib/process.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () => (dir = mkdtempSync(join(tmpdir(), 'stephen-lib-fs-')));
const mode = (p: string) => statSync(p).mode & 0o777;

describe('writePrivateFileAtomicSync', () => {
  it('writes the text with mode 0600 whatever the umask, and leaves no temp file', () => {
    fresh();
    const f = join(dir, 'a.json');
    const old = process.umask(0o000);
    try {
      writePrivateFileAtomicSync(f, 'hello\n');
    } finally {
      process.umask(old);
    }
    expect(readFileSync(f, 'utf8')).toBe('hello\n');
    expect(mode(f)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('replaces an existing file (even a looser one) and a symlink at the destination instead of writing through it', () => {
    fresh();
    const f = join(dir, 'a.json');
    writeFileSync(f, 'old', { mode: 0o644 });
    writePrivateFileAtomicSync(f, 'new');
    expect(readFileSync(f, 'utf8')).toBe('new');
    expect(mode(f)).toBe(0o600);

    const target = join(dir, 'target');
    writeFileSync(target, 'untouched');
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    writePrivateFileAtomicSync(link, 'mine');
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(statSync(link).isFile()).toBe(true);
    expect(readFileSync(link, 'utf8')).toBe('mine');
  });

  it('throws and removes its temp file when the rename fails (destination is a folder)', () => {
    fresh();
    const f = join(dir, 'busy');
    mkdirSync(join(f, 'inside'), { recursive: true });
    expect(() => writePrivateFileAtomicSync(f, 'x')).toThrow();
    expect(readdirSync(dir)).toEqual(['busy']);
  });

  it('writePrivateJsonFileSync / readPrivateJsonFile round-trip; the reader refuses loose modes and symlinks', () => {
    fresh();
    const f = join(dir, 's.json');
    expect(readPrivateJsonFile(f)).toEqual({ missing: true });
    writePrivateJsonFileSync(f, { a: 1 });
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}\n');
    expect(readPrivateJsonFile(f)).toEqual({ state: { a: 1 } });
    chmodSync(f, 0o644);
    expect(readPrivateJsonFile(f)).toEqual({ error: 'has mode 644, not 600' });
    const link = join(dir, 'l.json');
    symlinkSync(f, link);
    expect(readPrivateJsonFile(link)).toEqual({ error: 'is a symlink' });
  });
});

describe('ensurePrivateDir (D3, moved from src/drivers/util.ts)', () => {
  it('creates 0700 dirs and tightens existing ones up to the root', async () => {
    fresh();
    const root = join(dir, 'hub');
    mkdirSync(join(root, 'profiles'), { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    chmodSync(join(root, 'profiles'), 0o755);
    await ensurePrivateDir(join(root, 'profiles', 'zen'), root);
    expect(mode(root)).toBe(0o700);
    expect(mode(join(root, 'profiles'))).toBe(0o700);
    expect(mode(join(root, 'profiles', 'zen'))).toBe(0o700);
    // Outside the root only the leaf is touched.
    const outside = join(dir, 'elsewhere');
    mkdirSync(outside, { mode: 0o755 });
    chmodSync(outside, 0o755);
    await ensurePrivateDir(join(outside, 'out'), root);
    expect(mode(outside)).toBe(0o755);
    expect(mode(join(outside, 'out'))).toBe(0o700);
  });

  it('isExecutable', async () => {
    fresh();
    const f = join(dir, 'x');
    writeFileSync(f, '#!/bin/sh\n', { mode: 0o644 });
    expect(await isExecutable(f)).toBe(false);
    chmodSync(f, 0o755);
    expect(await isExecutable(f)).toBe(true);
    expect(await isExecutable(join(dir, 'missing'))).toBe(false);
  });
});

describe('isPidAlive', () => {
  it('true for this process, false for nonsense pids', () => {
    dir = mkdtempSync(join(tmpdir(), 'stephen-lib-fs-'));
    expect(isPidAlive(process.pid)).toBe(true);
    for (const p of [0, -1, 1.5, Number.NaN]) expect(isPidAlive(p)).toBe(false);
  });
});

describe('appendPrivateLineCapped and readPrivateRegularFile', () => {
  it('appends lines, fixes the mode to 0600, and stops at the cap', () => {
    fresh();
    const f = join(dir, 'day.jsonl');
    writeFileSync(f, 'a\n', { mode: 0o644 });
    expect(appendPrivateLineCapped(f, 'b\n', 6)).toBe(true);
    expect(appendPrivateLineCapped(f, 'ccc\n', 6)).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe('a\nb\n');
    expect(mode(f)).toBe(0o600);
  });
  it('refuses a symlink and a folder when appending, and reads them as null', () => {
    fresh();
    const real = join(dir, 'real');
    writeFileSync(real, 'x\n');
    const link = join(dir, 'link');
    symlinkSync(real, link);
    expect(() => appendPrivateLineCapped(link, 'y\n', 100)).toThrow();
    expect(readFileSync(real, 'utf8')).toBe('x\n');
    expect(readPrivateRegularFile(link, 100)).toBeNull();
    expect(readPrivateRegularFile(dir, 100)).toBeNull();
    expect(readPrivateRegularFile(join(dir, 'nope'), 100)).toBeNull();
  });
  it('reads a file up to the cap and not above it', () => {
    fresh();
    const f = join(dir, 'f');
    writeFileSync(f, '12345');
    expect(readPrivateRegularFile(f, 5)).toBe('12345');
    expect(readPrivateRegularFile(f, 4)).toBeNull();
  });
});

describe('a FIFO in place of a private file (#388 review)', () => {
  it('readPrivateJsonFile and readPrivateRegularFile refuse it at once, never wait on it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stephen-fifo-'));
    try {
      const f = join(dir, 'memory.json');
      execFileSync('mkfifo', [f]);
      expect(readPrivateJsonFile(f)).toEqual({ error: 'is not a regular file' });
      expect(readPrivateRegularFile(f, 1024)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
