/**
 * ADR-010 (edit and resend), the gate: a resend goes the resume path, so its serve starts with
 * `--assume-private-read` and nothing of the old branch's gate (private reads, approved hosts) carries over. Driven
 * end to end from the Assistant with an edit request, the new serve built as src/cli.ts builds it (as in
 * resume-gate.test.ts).
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
import { Assistant, type ResumeRequest } from '../../src/voice/assistant.js';
import { mcpConfig, type ClaudeOutcome, type RunOptions } from '../../src/voice/claude.js';
import { Conversation, ConversationRunner } from '../../src/voice/conversation.js';
import { RecordingChimes, RecordingSpeaker } from '../voice/helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-edit-gate-'));
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
const DEST = 'https://evil.example/news';
const edit: ResumeRequest = {
  saved: () => true,
  prompt: (m) => `Earlier conversation ... then ${m}`,
  edit: { conv: 'c_00112233aabbccdd', id: 'h_0000000000000002', ts: NOW - 60_000, source: 'voice-ptt' },
};

function serveGate(home: string, args: string[]): SafetyGate {
  const opts = parseServeArgs(args.slice(2), { home });
  if ('error' in opts) throw new Error(opts.error);
  const g = new SafetyGate({ safety: SAFETY, confirmer: new Answer(), audit: { append: async () => undefined } as never, now: () => NOW });
  if (opts.sessionState) bindSessionState(g, opts.sessionState);
  if (opts.assumePrivateRead) g.notePrivateData('private');
  return g;
}

describe('ADR-010: the gate after an edit and resend', () => {
  it('a host approved in the old branch asks again; the first cross-site action after the resend asks', async () => {
    const h = join(tmp, 'approved');
    mkdirSync(join(h, 'voice'), { recursive: true, mode: 0o700 });
    const state = join(h, 'voice', SESSION_STATE_FILE);
    const args = (apr: boolean) => mcpConfig('/n', '/c', state, null, null, 'trusted', null, apr).mcpServers.stephen!.args;
    const seen: RunOptions[] = [];
    const gates: SafetyGate[] = [];
    let n = 0;
    const inner = {
      run: async (_prompt: string, run: RunOptions = {}): Promise<ClaudeOutcome> => {
        seen.push(run);
        const g = serveGate(h, args(run.assumePrivateRead === true));
        gates.push(g);
        if (n === 0) {
          // The old branch: it read mail and the owner approved evil.example; its gate state is on disk.
          expect(g.importState({ version: 1, privateReads: [{ host: 'mail.google.com', scope: 'mail.google.com', at: NOW }], trustedHosts: ['evil.example'] })).toEqual({ ok: true });
          g.notePrivateData('gmail');
          expect(g.evaluate(nav(DEST)).verdict).toBe('allow');
        }
        return { kind: 'ok', text: 'ok', sessionId: `sess-${++n}`, costUsd: 0, turns: 1 };
      },
      cancel: () => false,
    };
    const runner = new ConversationRunner(inner, new Conversation({ dir: join(h, 'voice'), windowSec: 180 }));
    const assistant = new Assistant({ runner, speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: () => {} });
    await assistant.command('play sarah', { source: 'app' });
    expect(readFileSync(state, 'utf8')).toContain('evil.example');

    await assistant.command('play sara', { source: 'app', resume: edit });
    // A fresh process (no --resume of the old session), with the flag.
    expect(seen[1]).toEqual({ trust: 'trusted', assumePrivateRead: true });
    const resent = gates[1]!;
    expect(resent.approvedHosts()).toEqual([]);
    expect(resent.evaluate(nav(DEST)).verdict).toBe('confirm'); // the old Allow is not reused
    expect(resent.evaluate(nav(LEAK)).verdict).toBe('confirm'); // the first cross-site action asks
  });
});
