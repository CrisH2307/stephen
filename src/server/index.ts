import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { errorMessage } from '../errors.js';
import type { createSafety } from '../safety/index.js';
import type { ElicitFn } from '../safety/index.js';
import type { Confirmer, IBrowserManager, PageEngine, ResolvedConfig } from '../types.js';
import { Hub } from './hub.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { withRestartRefusal } from './instance.js';
import { fileToolLogger, withToolLog } from './tool-log.js';
import { registerTools } from './tools.js';
import { log, withTimeout } from './util.js';

export { SERVER_INSTRUCTIONS } from './instructions.js';
export { normalizeUrl } from './util.js';

export interface ServerDeps {
  cfg: ResolvedConfig;
  manager: IBrowserManager;
  engine: PageEngine;
  /** Called after the client connects (so elicitation support is known). */
  safetyFactory: typeof createSafety;
  /**
   * Builds the human confirmer used for non-page decisions (switching a browser to the real profile).
   * Default: the safety layer's buildConfirmer with the same settings as the gate. Tests inject a fake.
   */
  confirmerFactory?: (cfg: ResolvedConfig, deps: { elicit?: ElicitFn }) => Confirmer;
  /** How long a tool call waits for a leftover (timed-out) operation on the same tab. Default 15 s. */
  orphanWaitMs?: number;
  /** Upper bound for one page action. Default ACTION_TIMEOUT_MS (45 s); tests shorten it. */
  actionTimeoutMs?: number;
  /** `serve --tool-log <file>`: append `{tool,isError,ms}` per call (never arguments or results; see tool-log.ts). */
  toolLog?: string;
  /**
   * `serve --instance` found its lock taken (Claude Code restarted serve, docs/REVIEW-7.md R7-1): every tool answers
   * RESTARTED_NOTICE and nothing runs; this is called after each refusal (serve exits non-zero).
   */
  restarted?: () => void;
  /**
   * `serve --trust wake`: a wake-word conversation (docs/REVIEW-7.md R7-2). The account tools then give email as who
   * and when only, and refuse to read a message (src/accounts/index.ts). Absent: trusted.
   */
  trust?: 'wake';
}

/**
 * MCP server name. Claude Code shows the tools as `mcp__stephen__<tool>` (the voice listener allows exactly that
 * prefix), and `stephen install` registers the server under this name.
 */
export const SERVER_NAME = 'stephen';

/** package.json version (works from src/ and dist/, both two levels below the root). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Build the MCP server with every tool registered. Not yet connected to a transport. */
export function buildServer(deps: ServerDeps): McpServer {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: packageVersion() },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const hub = new Hub(deps, mcp);
  const logged = deps.toolLog ? withToolLog(mcp, fileToolLogger(deps.toolLog)) : mcp;
  // The refusal goes outside the tool log, so a refused call is still logged (as an error).
  registerTools(deps.restarted ? withRestartRefusal(logged, deps.restarted) : logged, hub);
  return mcp;
}

/** Start the MCP server on stdio. Resolves once connected; handles SIGINT/SIGTERM → manager.shutdown(). */
export async function serveStdio(deps: ServerDeps): Promise<void> {
  // stdout is reserved for MCP JSON-RPC: route any stray console output to stderr.
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.debug = console.error.bind(console);

  const mcp = buildServer(deps);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (why: string, code = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`shutting down (${why})`);
    try {
      await withTimeout(deps.manager.shutdown(), 8000, 'browser disconnect');
    } catch (e) {
      log('shutdown:', errorMessage(e));
    }
    try {
      await mcp.close();
    } catch {
      /* already closed */
    }
    process.exit(code);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGHUP', () => void shutdown('SIGHUP'));
  process.stdin.once('end', () => void shutdown('stdin closed'));
  process.stdin.once('close', () => void shutdown('stdin closed'));
  transport.onclose = () => void shutdown('transport closed');
  process.on('unhandledRejection', (e) => log('unhandled rejection:', errorMessage(e)));

  await mcp.connect(transport);
  log(`ready (v${packageVersion()}, default browser ${deps.cfg.defaultBrowser})`);
}
