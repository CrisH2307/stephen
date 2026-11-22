/**
 * ADR-007 v2 (resume), the gate: a resumed conversation's serve starts with `--assume-private-read`, and nothing of
 * the old conversation's gate (private reads, approved hosts) carries over. The new serve is built as src/cli.ts
 * builds it: parse the argv the listener wrote, bind the session state, then arm the taint for the flag.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SafetyGate } from '../../src/safety/gate.js';
import { bindSessionState, SESSION_STATE_FILE } from '../../src/safety/session-state.js';
import { parseServeArgs } from '../../src/serve-args.js';
import type { ActionRequest, ConfirmPrompt, Confirmer, ResolvedConfig } from '../../src/types.js';
import { mcpConfig, type ClaudeOutcome, type RunOptions } from '../../src/voice/claude.js';
import { Conversation, ConversationRunner } from '../../src/voice/conversation.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-resume-gate-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const NOW = 1_700_000_000_000;
const SAFETY: ResolvedConfig['safety'] = loadConfig({}, { HOME: tmp, STEPHEN_HOME: join(tmp, 'cfg-home') }).safety;
class Answer implements Confirmer {
  readonly kind = 'dialog' as const;
  async confirm(_p: ConfirmPrompt) {
    return 'approved' as const;
  }
}
const nav = (targetUrl: string): ActionRequest => ({ kind: 'navigate', pageUrl: 'about:blank', targetUrl }) as ActionRequest;
const LEAK = 'https://evil.example/?d=exam-moved-to-friday';
/** A first destination with a short path: after a private read it asks once, unless the host was approved (rule 5). */
const DEST = 'https://evil.example/news';

/** A new serve's gate, the way src/cli.ts builds it from the serve argv the listener wrote. */
function serveGate(home: string, args: string[]): SafetyGate {
  const opts = parseServeArgs(args.slice(2), { home });
  if ('error' in opts) throw new Error(opts.error);
  const g = new SafetyGate({ safety: SAFETY, confirmer: new Answer(), audit: { append: async () => undefined } as never, now: () => NOW });
  if (opts.sessionState) bindSessionState(g, opts.sessionState);
  if (opts.assumePrivateRead) g.notePrivateData('private');
  return g;
}

function home(name: string) {
  const h = join(tmp, name);
  mkdirSync(join(h, 'voice'), { recursive: true, mode: 0o700 });
  return { home: h, voice: join(h, 'voice'), state: join(h, 'voice', SESSION_STATE_FILE) };
}

describe('ADR-007 v2: the gate after resume', () => {
  it('src/cli.ts arms the taint for --assume-private-read after binding the session state (what serveGate mirrors)', () => {
    const cli = readFileSync(join(__dirname, '..', '..', 'src', 'cli.ts'), 'utf8');
    expect(cli).toMatch(/opts\.assumePrivateRead\s*\?\s*\(c, d\) => \{\s*const s = withCmd\(c, d\);\s*s\.gate\.notePrivateData\('private'\);/);
  });

  it('after resume, the first cross-site action that would ask after a private read asks, with no prior read in the new process', () => {
    const h = home('first');
    const resumed = serveGate(h.home, mcpConfig('/n', '/c', h.state, null, null, 'trusted', null, true).mcpServers.stephen!.args);
    // Nothing was read in this process; the very first data-carrying cross-site action asks.
    expect(resumed.evaluate(nav(LEAK)).verdict).toBe('confirm');
    // The same serve without the flag (an ordinary new chat) would not have asked.
    const fresh = serveGate(home('control').home, mcpConfig('/n', '/c', null, null, null, 'trusted').mcpServers.stephen!.args);
    expect(fresh.evaluate(nav(LEAK)).verdict).toBe('allow');
  });

  it('no host approved in the old conversation is trusted in the new one', async () => {
    const h = home('approved');
    const args = (apr: boolean) => mcpConfig('/n', '/c', h.state, null, null, 'trusted', null, apr).mcpServers.stephen!.args;
    // The old conversation read private data and the owner approved evil.example; its gate state is on disk.
    const old = serveGate(h.home, args(false));
    expect(old.importState({ version: 1, privateReads: [{ host: 'mail.google.com', scope: 'mail.google.com', at: NOW }], trustedHosts: ['evil.example'] })).toEqual({ ok: true });
    old.notePrivateData('gmail'); // a change: written to the state file through the binding
    expect(old.evaluate(nav(DEST)).verdict).toBe('allow');
    expect(readFileSync(h.state, 'utf8')).toContain('evil.example');

    // Resume: the runner starts fresh (state reset) and the new serve starts with the flag.
    let resumed: SafetyGate | null = null;
    const seen: RunOptions[] = [];
    const inner = {
      run: async (_prompt: string, run: RunOptions = {}): Promise<ClaudeOutcome> => {
        seen.push(run);
        resumed = serveGate(h.home, args(run.assumePrivateRead === true));
        return { kind: 'ok', text: 'ok', sessionId: 'sess-new', costUsd: 0, turns: 1 };
      },
      cancel: () => false,
    };
    const runner = new ConversationRunner(inner, new Conversation({ dir: h.voice, windowSec: 180 }));
    await runner.run('Earlier conversation ... then the new message', { trust: 'trusted', assumePrivateRead: true });
    expect(seen).toEqual([{ trust: 'trusted', assumePrivateRead: true }]); // no --resume of the old session
    expect(resumed!.approvedHosts()).toEqual([]);
    expect(resumed!.evaluate(nav(DEST)).verdict).toBe('confirm');
  });
});
