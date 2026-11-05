/** src/lib/keychain.ts: the one Keychain READ path (argv-only `security`) and its process runner. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultExec, keychainHas, keychainRead, type ExecFn } from '../../src/lib/keychain.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-lib-keychain-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('defaultExec (moved from src/voice/tts/keys.ts)', () => {
  it('pipes input to stdin and reports exit codes; a missing binary is code -1', async () => {
    const r = await defaultExec(process.execPath, ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(d.toUpperCase());process.exit(3)})'], { input: 'abc', timeoutMs: 10_000 });
    expect(r).toEqual({ code: 3, stdout: 'ABC', stderr: '' });
    expect((await defaultExec(join(tmp, 'no-such-bin'), [], { timeoutMs: 1000 })).code).toBe(-1);
  });
});

describe('keychainRead / keychainHas', () => {
  const calls: string[][] = [];
  const fake =
    (code: number, stdout = '', stderr = ''): ExecFn =>
    async (file, args) => {
      calls.push([file, ...args]);
      return { code, stdout, stderr };
    };
  const mac = { platform: 'darwin' as const, user: 'tester' };

  it('reads with argv only (-w last), trims the value, and maps "not found" and errors', async () => {
    calls.length = 0;
    expect(await keychainRead('stephen-x', { ...mac, exec: fake(0, ' v4lue \n') })).toEqual({ value: 'v4lue' });
    expect(calls).toEqual([['security', 'find-generic-password', '-s', 'stephen-x', '-a', 'tester', '-w']]);
    expect(await keychainRead('stephen-x', { ...mac, exec: fake(44) })).toEqual({ value: null });
    expect(await keychainRead('stephen-x', { ...mac, exec: fake(51, '', 'locked\nmore') })).toEqual({ value: null, error: 'locked' });
    expect(await keychainRead('stephen-x', { ...mac, exec: fake(51) })).toEqual({ value: null, error: 'exit 51' });
  });

  it('is a no-op off macOS, and keychainHas never asks for the value', async () => {
    calls.length = 0;
    expect(await keychainRead('stephen-x', { platform: 'linux', exec: fake(0, 'v') })).toEqual({ value: null });
    expect(await keychainHas('stephen-x', { platform: 'linux', exec: fake(0) })).toBe(false);
    expect(calls).toEqual([]);
    expect(await keychainHas('stephen-x', { ...mac, exec: fake(0) })).toBe(true);
    expect(await keychainHas('stephen-x', { ...mac, exec: fake(44) })).toBe(false);
    expect(calls.every((c) => !c.includes('-w'))).toBe(true);
  });
});
