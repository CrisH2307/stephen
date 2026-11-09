/**
 * The one config.json section writer (R9-11): change one top-level section, keep everything else (plain JSON, so no
 * comments). Written to a temporary 0600 file and renamed (src/lib/fs.ts writePrivateFileAtomicSync). Used by the
 * owner-only CLIs (`accounts`, `connect`) and the listener's settings.set (src/app/talk.ts). Not in src/lib and not
 * imported by anything Claude can reach (test/memory/boundary.test.ts R7-8).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFileAtomicSync } from './lib/fs.js';

export function updateConfigSection(file: string, key: string, change: (section: Record<string, unknown>) => Record<string, unknown>): void {
  let root: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.json is not a JSON object');
    root = parsed as Record<string, unknown>;
  }
  const old = root[key];
  root[key] = change(old && typeof old === 'object' && !Array.isArray(old) ? (old as Record<string, unknown>) : {});
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(file, `${JSON.stringify(root, null, 2)}\n`);
}
