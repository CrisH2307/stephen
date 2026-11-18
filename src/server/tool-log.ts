/**
 * `stephen serve --tool-log <file>`: which tools Claude called during one voice / app command, for the owner's
 * history (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 5). Every tool registration is wrapped (same shim idea as
 * buildDryRunServer in src/eval/dry-server.ts) and each call appends ONE JSON line `{tool,isError,ms}` to the file.
 * Arguments and results are NEVER written: page text, URLs and typed text stay out of the log.
 *
 * The file is private (0600, opened with O_NOFOLLOW) and lives directly inside `<home>/voice/` (checked like
 * `--session-state`, see checkToolLogPath). The listener truncates it before a run (resetToolLog) and reads it after
 * (readToolLog). A write failure never fails the tool call; it is only logged.
 *
 * `serve --command-file <file>` (plan A2): each record also gets `cmd`, the id of the command the listener is sending
 * (src/lib/command-id.ts). It is a label only. No id, or a bad one, means the record is written without `cmd`.
 */
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { validCommandId } from '../lib/command-id.js';
import { checkVoiceFilePath, sessionStateDir } from '../safety/session-state.js';

/** One tool call as recorded by `serve --tool-log`. */
export interface ToolCallRecord {
  /** Tool name without the mcp__stephen__ prefix. */
  tool: string;
  isError: boolean;
  /** Wall time of the call in milliseconds. */
  ms: number;
  /** The command id the call belongs to (`serve --command-file`). Absent on old lines and when the id is unknown. */
  cmd?: string;
}

/** The voice listener's tool log, in `<home>/voice/`. */
export const TOOL_LOG_FILE = 'tool-log.jsonl';
/** The listener's command id file, in `<home>/voice/` (src/lib/command-id.ts). */
export const COMMAND_FILE = 'command.json';
/** readToolLog keeps at most this many calls (a voice command uses far fewer; maxTurns bounds them anyway). */
export const MAX_TOOL_LOG_ENTRIES = 200;
/** A log larger than this is not read. */
export const MAX_TOOL_LOG_BYTES = 256 * 1024;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.jsonl$/;
const JSON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPEN_APPEND = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;

/** `<home>/voice/tool-log.jsonl` (or another file name in that folder). */
export function toolLogPath(home: string, file: string = TOOL_LOG_FILE): string {
  return join(sessionStateDir(home), file);
}

/** The `serve` argv addition for a tool log, for the listener's MCP config. */
export function toolLogServeArgs(path: string | null): string[] {
  return path ? ['--tool-log', path] : [];
}

/** Validate a `--tool-log` value: a `.jsonl` file directly inside `<home>/voice/` (rules of checkSessionStatePath). */
export function checkToolLogPath(p: string, home: string): { path: string } | { error: string } {
  return checkVoiceFilePath(p, home, { flag: '--tool-log', name: NAME_RE, nameHint: 'a .jsonl file' });
}

/** `<home>/voice/command.json`. */
export function commandFilePath(home: string): string {
  return join(sessionStateDir(home), COMMAND_FILE);
}

/** The `serve` argv addition for the command id file, for the listener's MCP config. */
export function commandFileServeArgs(path: string | null): string[] {
  return path ? ['--command-file', path] : [];
}

/** Validate a `--command-file` value: a `.json` file directly inside `<home>/voice/` (rules of checkSessionStatePath). */
export function checkCommandFilePath(p: string, home: string): { path: string } | { error: string } {
  return checkVoiceFilePath(p, home, { flag: '--command-file', name: JSON_NAME_RE, nameHint: 'a .json file' });
}

/** The fields of a record that go to disk: `cmd` only when it is a valid command id. */
function toLine(rec: ToolCallRecord): ToolCallRecord {
  const cmd = validCommandId(rec.cmd);
  return { tool: rec.tool, isError: rec.isError, ms: rec.ms, ...(cmd ? { cmd } : {}) };
}

/** Append one record (single O_APPEND write, 0600, never follows a symlink). Throws on failure. */
export function appendToolLog(file: string, rec: ToolCallRecord): void {
  const line = `${JSON.stringify(toLine(rec))}\n`;
  const fd = openSync(file, OPEN_APPEND, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if ((st.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

/** Empty the log before a run (creates it 0600 if missing; never follows a symlink). */
export function resetToolLog(file: string): void {
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

/** A valid ToolCallRecord from parsed JSON, or null (also used by the history store). */
export function parseToolCallRecord(v: unknown): ToolCallRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.tool !== 'string' || !TOOL_NAME_RE.test(o.tool)) return null;
  if (typeof o.isError !== 'boolean') return null;
  if (typeof o.ms !== 'number' || !Number.isFinite(o.ms) || o.ms < 0) return null;
  return toLine({ tool: o.tool, isError: o.isError, ms: Math.round(o.ms), cmd: o.cmd as string });
}

/** Read a tool log back. Missing, unreadable, oversized or symlinked file = no calls; malformed lines are skipped. */
export function readToolLog(file: string): ToolCallRecord[] {
  let text: string;
  try {
    const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_TOOL_LOG_BYTES) return [];
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: ToolCallRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: ToolCallRecord | null = null;
    try {
      rec = parseToolCallRecord(JSON.parse(line));
    } catch {
      rec = null;
    }
    if (rec) out.push(rec);
    if (out.length >= MAX_TOOL_LOG_ENTRIES) break;
  }
  return out;
}

type Recorder = (rec: ToolCallRecord) => void;

/** A recorder that appends to `file`; failures go to stderr and never reach the tool call. */
export function fileToolLogger(file: string, onError: (e: unknown) => void = (e) => console.error(`[stephen] tool log: ${(e as Error).message}`)): Recorder {
  return (rec) => {
    try {
      appendToolLog(file, rec);
    } catch (e) {
      onError(e);
    }
  };
}

/**
 * Wrap `mcp` so every tool registered through the result records `{tool,isError,ms}` per call. Only registerTool is
 * intercepted; the wrapped callback passes the arguments and the result through untouched (it never looks at them,
 * except `result.isError`). A thrown error is recorded as isError and rethrown.
 * `commandId` (serve --command-file) is asked once when the call starts. It must not throw; a throw counts as no id.
 */
export function withToolLog(
  mcp: McpServer,
  record: Recorder,
  now: () => number = () => performance.now(),
  commandId?: () => string | undefined,
): McpServer {
  return new Proxy(mcp, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);
      return (name: string, config: unknown, cb: (...a: unknown[]) => unknown) => {
        const wrapped = async (...a: unknown[]) => {
          const t0 = now();
          let cmd: string | undefined;
          try {
            cmd = validCommandId(commandId?.());
          } catch {
            cmd = undefined;
          }
          let isError = true;
          try {
            const res = await cb(...a);
            isError = !!(res && typeof res === 'object' && (res as { isError?: unknown }).isError === true);
            return res;
          } finally {
            record({ tool: name, isError, ms: Math.max(0, Math.round(now() - t0)), ...(cmd ? { cmd } : {}) });
          }
        };
        return (target.registerTool as (n: string, c: unknown, f: unknown) => unknown).call(target, name, config, wrapped);
      };
    },
  });
}
