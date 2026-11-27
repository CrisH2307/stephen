/**
 * Claude Code's own session transcripts (review 5, R5-1).
 *
 * With follow-ups on, `--no-session-persistence` is left out (a resumed session must be saved), so Claude Code writes
 * `<claude config dir>/projects/<slug of the voice workdir>/<session id>.jsonl` (plus an optional `<session id>/`
 * folder). That file holds the prompt, every tool result and every reply, and Claude Code keeps it ~30 days. Stephen
 * deletes it:
 *  - when a conversation ends or its session id is replaced (Conversation `onSessionDropped`);
 *  - on history purge (older than the retention cutoff) and on `history clear` (all), never the live session.
 *
 * Only that ONE project folder is touched (the voice workdir is used by nothing else). A symlinked project folder,
 * or entries that are symlinks, are left alone. Errors are swallowed: cleanup must never break a command.
 */
import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeConfigDir } from '../lib/claude-env.js';
import { SESSION_ID_RE } from './claude.js';

/** Claude Code's project folder name for a cwd: every character that isn't a letter or digit becomes "-". */
export function claudeProjectSlug(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/** `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>` for the voice workdir. */
export function claudeTranscriptDir(workDir: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  // The same check as the env Claude gets (src/lib/claude-env.ts), so Claude writes where Stephen deletes.
  const base = claudeConfigDir(env, home) ?? join(home, '.claude');
  return join(resolve(base), 'projects', claudeProjectSlug(workDir));
}

/** The project folder, if it is a real folder (not a symlink). */
function realDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Delete one entry (a regular file, or a real folder) inside `dir`; symlinks and anything else are skipped. */
function removeEntry(dir: string, name: string): boolean {
  const p = join(dir, name);
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return false;
    if (st.isFile()) unlinkSync(p);
    else if (st.isDirectory()) rmSync(p, { recursive: true, force: true });
    else return false;
    return true;
  } catch {
    return false;
  }
}

/** Delete one session's transcript (`<id>.jsonl` and `<id>/`). Returns how many entries were deleted. */
export function removeSessionTranscript(dir: string, sessionId: string): number {
  if (!SESSION_ID_RE.test(sessionId) || !realDir(dir)) return 0;
  return Number(removeEntry(dir, `${sessionId}.jsonl`)) + Number(removeEntry(dir, sessionId));
}

/**
 * Delete session transcripts in `dir`: all of them (`olderThanMs` null) or those last changed before `olderThanMs`.
 * `keep` (the live conversation's session id) is never deleted. Returns how many sessions were deleted.
 */
export function purgeTranscripts(dir: string, olderThanMs: number | null, keep: string | null = null): number {
  if (!realDir(dir)) return 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const ids = new Set<string>();
  for (const n of names) {
    const id = n.endsWith('.jsonl') ? n.slice(0, -'.jsonl'.length) : n;
    if (SESSION_ID_RE.test(id) && id !== keep) ids.add(id);
  }
  let count = 0;
  for (const id of ids) {
    if (olderThanMs !== null) {
      // Newest change of the pair decides: keep it if either part was touched after the cutoff.
      let newest = -Infinity;
      for (const n of [`${id}.jsonl`, id]) {
        try {
          newest = Math.max(newest, lstatSync(join(dir, n)).mtimeMs);
        } catch {
          /* missing */
        }
      }
      if (newest === -Infinity || newest >= olderThanMs) continue;
    }
    if (removeSessionTranscript(dir, id) > 0) count += 1;
  }
  return count;
}
