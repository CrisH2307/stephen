/**
 * Tests never make sound (the "Done! I opened YouTube" voice, 2026-11-17). Stephen plays speech and chimes with
 * `say` and `afplay` looked up on PATH, so the suite puts silent stand-ins first on PATH. They only write one line
 * to a log; every test checks that log and fails if it played something (test/no-sound-check.ts).
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const SOUND_LOG_ENV = 'STEPHEN_TEST_SOUND_LOG';

/** Install the stand-ins into `env` (PATH and the log path). Returns a cleanup. */
export function silenceSound(env: NodeJS.ProcessEnv = process.env): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'stephen-no-sound-'));
  const log = join(dir, 'played.log');
  writeFileSync(log, '');
  for (const [cmd, readsStdin] of [['say', true], ['afplay', false]] as const) {
    const p = join(dir, cmd);
    // `say` reads its text from stdin; afplay's stdin may stay open, so only `say` drains it.
    writeFileSync(p, `#!/bin/sh\necho "${cmd} $*" >> "$${SOUND_LOG_ENV}"\n${readsStdin ? 'cat >/dev/null\n' : ''}exit 0\n`);
    chmodSync(p, 0o755);
  }
  env.PATH = `${dir}${delimiter}${env.PATH ?? ''}`;
  env[SOUND_LOG_ENV] = log;
  return () => rmSync(dir, { recursive: true, force: true });
}

/** What was played since the last call (and clear it). Empty when the guard is not installed. */
export function takePlayed(env: NodeJS.ProcessEnv = process.env): string[] {
  const log = env[SOUND_LOG_ENV];
  if (!log) return [];
  let text = '';
  try {
    text = readFileSync(log, 'utf8');
  } catch {
    return [];
  }
  if (text) writeFileSync(log, '');
  return text.split('\n').filter(Boolean);
}
