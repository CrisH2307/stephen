/**
 * `stephen install [--run]`: register Stephen with Claude Code for all projects (user scope):
 *
 *   claude mcp add --scope user stephen -- node <abs>/dist/cli.js serve
 *
 * With --run it runs that, then removes a user-scope registration under the pre-rename name `browser-hub`
 * (same server, old name) so Claude Code does not start two copies — and says so. Without --run it only prints
 * the commands. Everything goes through `execFile` with argv arrays (no shell).
 */
import { execNoThrow, firstLine } from './lib/process.js';
import { SERVER_NAME } from './server/index.js';

/** The MCP server name used before the rename; `install --run` removes a user-scope registration under it. */
export const LEGACY_SERVER_NAME = 'browser-hub';

export interface ClaudeResult {
  /** Exit code; null if the program could not be started (see `notFound`) or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The `claude` command does not exist (ENOENT). */
  notFound?: boolean;
}
export type RunClaude = (args: string[]) => Promise<ClaudeResult>;

export interface InstallDeps {
  runClaude: RunClaude;
  /** Does the built CLI exist? */
  exists: (p: string) => boolean;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** `claude` argv that registers Stephen (user scope) for the built CLI at `cliPath`. */
export function mcpAddArgs(cliPath: string): string[] {
  return ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', 'node', cliPath, 'serve'];
}

/** `claude` argv that removes a user-scope registration called `name`. */
export function mcpRemoveArgs(name: string): string[] {
  return ['mcp', 'remove', '--scope', 'user', name];
}

/** The add command as a user would type it. */
export function printableAdd(cliPath: string): string {
  return `claude mcp add --scope user ${SERVER_NAME} -- node "${cliPath}" serve`;
}

const LEGACY_REMOVE = `claude mcp remove --scope user ${LEGACY_SERVER_NAME}`;

/** `claude mcp remove` failed only because nothing by that name is registered in that scope. */
function isNotRegistered(r: ClaudeResult): boolean {
  return /not found|no .*(server|mcp).*(found|named|exists|configured)|does not exist|doesn't exist/i.test(`${r.stderr}\n${r.stdout}`);
}

export const defaultRunClaude: RunClaude = async (args) => {
  const r = await execNoThrow('claude', args, 60_000);
  return {
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr || (r.error && r.code === null ? r.error.message : ''),
    notFound: r.error?.code === 'ENOENT',
  };
};

/** Run `stephen install` (print only) or `stephen install --run`. Returns the exit code. */
export async function runInstall(opts: { run: boolean; cliPath: string }, deps: InstallDeps): Promise<number> {
  const { cliPath } = opts;
  const { log, error } = deps;
  const printable = printableAdd(cliPath);
  if (!deps.exists(cliPath)) log(`Note: ${cliPath} does not exist yet — run \`npm run build\` first.\n`);
  if (!opts.run) {
    log(
      `Register Stephen with Claude Code (all projects):\n\n  ${printable}\n\n` +
        `If you used browser-hub before, also remove its old registration:\n\n  ${LEGACY_REMOVE}\n\n` +
        'Then restart Claude Code and check /mcp. Or run: stephen install --run (does both)',
    );
    return 0;
  }

  log(`Running: ${printable}`);
  const add = await deps.runClaude(mcpAddArgs(cliPath));
  if (add.stdout.trim()) log(add.stdout.trim());
  if (add.stderr.trim()) error(add.stderr.trim());
  if (add.notFound) {
    error('The `claude` command was not found. Install Claude Code, or run the command above in a terminal where `claude` works.');
    return 1;
  }
  if (add.code !== 0) {
    error(
      `claude mcp add failed${add.code === null ? '' : ` (exit code ${add.code})`}: ${firstLine(add.stderr || add.stdout) || 'no output'}. ` +
        `If Stephen is already registered, remove it first: claude mcp remove --scope user ${SERVER_NAME}`,
    );
    return 1;
  }

  // Only after Stephen is registered: drop the old browser-hub registration (same server, old name).
  const rm = await deps.runClaude(mcpRemoveArgs(LEGACY_SERVER_NAME));
  if (rm.code === 0) {
    log(`Removed the old user-scope "${LEGACY_SERVER_NAME}" registration (Stephen replaces it; its tools were mcp__${LEGACY_SERVER_NAME}__*).`);
  } else if (!isNotRegistered(rm)) {
    error(
      `Note: could not check for an old "${LEGACY_SERVER_NAME}" registration (${firstLine(rm.stderr || rm.stdout) || `exit code ${rm.code}`}). ` +
        `If \`claude mcp list\` still shows it, remove it: ${LEGACY_REMOVE}`,
    );
  }
  log(`Done. Restart Claude Code, then run /mcp to see ${SERVER_NAME} (its tools appear as mcp__${SERVER_NAME}__*).`);
  return 0;
}
