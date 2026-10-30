/**
 * `stephen install [--run]`: registers the MCP server as `stephen` (user scope), then removes a user-scope
 * `browser-hub` registration (the pre-rename name) — only after the add succeeded — and says so.
 * `claude` is faked: no real Claude Code config is touched.
 */
import { describe, expect, it } from 'vitest';
import { type ClaudeResult, LEGACY_SERVER_NAME, mcpAddArgs, mcpRemoveArgs, printableAdd, runInstall } from '../../src/install.js';
import { SERVER_NAME } from '../../src/server/index.js';

const CLI = '/Users/jo/My Projects/stephen/dist/cli.js';

function harness(results: Partial<Record<'add' | 'remove', ClaudeResult>>, cliExists = true) {
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const ok: ClaudeResult = { code: 0, stdout: '', stderr: '' };
  const deps = {
    runClaude: async (args: string[]) => {
      calls.push(args);
      return (args[1] === 'add' ? results.add : results.remove) ?? ok;
    },
    exists: () => cliExists,
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
  };
  return { deps, calls, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('stephen install', () => {
  it('the server is "stephen" (tools are mcp__stephen__*); the legacy name is browser-hub', () => {
    expect(SERVER_NAME).toBe('stephen');
    expect(LEGACY_SERVER_NAME).toBe('browser-hub');
    expect(mcpAddArgs(CLI)).toEqual(['mcp', 'add', '--scope', 'user', 'stephen', '--', 'node', CLI, 'serve']);
    expect(mcpRemoveArgs('browser-hub')).toEqual(['mcp', 'remove', '--scope', 'user', 'browser-hub']);
    expect(printableAdd(CLI)).toBe(`claude mcp add --scope user stephen -- node "${CLI}" serve`);
  });

  it('without --run: prints the add command (and how to drop an old browser-hub registration); runs nothing', async () => {
    const h = harness({});
    expect(await runInstall({ run: false, cliPath: CLI }, h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out()).toContain(`claude mcp add --scope user stephen -- node "${CLI}" serve`);
    expect(h.out()).toContain('claude mcp remove --scope user browser-hub');
    expect(h.out()).toContain('stephen install --run');
    expect(h.out()).not.toContain('npm run build');
  });

  it('notes a missing build', async () => {
    const h = harness({}, false);
    await runInstall({ run: false, cliPath: CLI }, h.deps);
    expect(h.out()).toMatch(/does not exist yet — run `npm run build` first/);
  });

  it('--run with an old registration: adds stephen FIRST, then removes browser-hub, and says so', async () => {
    const h = harness({ add: { code: 0, stdout: 'Added stdio MCP server stephen to user config', stderr: '' }, remove: { code: 0, stdout: 'Removed MCP server browser-hub from user config', stderr: '' } });
    expect(await runInstall({ run: true, cliPath: CLI }, h.deps)).toBe(0);
    expect(h.calls).toEqual([mcpAddArgs(CLI), mcpRemoveArgs('browser-hub')]);
    expect(h.out()).toContain('Removed the old user-scope "browser-hub" registration');
    expect(h.out()).toMatch(/Done\. Restart Claude Code, then run \/mcp to see stephen \(its tools appear as mcp__stephen__\*\)/);
    expect(h.err()).toBe('');
  });

  it('--run without an old registration: nothing is said about browser-hub', async () => {
    const h = harness({ remove: { code: 1, stdout: '', stderr: 'No user-scoped MCP server found with name: browser-hub' } });
    expect(await runInstall({ run: true, cliPath: CLI }, h.deps)).toBe(0);
    expect(h.calls).toEqual([mcpAddArgs(CLI), mcpRemoveArgs('browser-hub')]);
    expect(h.out()).not.toContain('Removed');
    expect(h.err()).toBe('');
    expect(h.out()).toContain('Done.');
  });

  it('--run: an unexpected failure removing browser-hub is reported (with the manual command), install still succeeds', async () => {
    const h = harness({ remove: { code: 1, stdout: '', stderr: 'EACCES: permission denied, open ~/.claude.json' } });
    expect(await runInstall({ run: true, cliPath: CLI }, h.deps)).toBe(0);
    expect(h.err()).toMatch(/could not check for an old "browser-hub" registration \(EACCES/);
    expect(h.err()).toContain('claude mcp remove --scope user browser-hub');
  });

  it('--run: if adding stephen fails, browser-hub is NOT removed (the user keeps a working server) and the exit code is 1', async () => {
    const h = harness({ add: { code: 1, stdout: '', stderr: 'MCP server stephen already exists in user config' } });
    expect(await runInstall({ run: true, cliPath: CLI }, h.deps)).toBe(1);
    expect(h.calls).toEqual([mcpAddArgs(CLI)]);
    expect(h.err()).toMatch(/claude mcp add failed \(exit code 1\): MCP server stephen already exists/);
    expect(h.err()).toContain('claude mcp remove --scope user stephen');
  });

  it('--run without the claude command: explains, exit 1, nothing removed', async () => {
    const h = harness({ add: { code: null, stdout: '', stderr: '', notFound: true } });
    expect(await runInstall({ run: true, cliPath: CLI }, h.deps)).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.err()).toMatch(/`claude` command was not found/);
  });
});
