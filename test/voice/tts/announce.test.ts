import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { parseServeArgs } from '../../../src/serve-args.js';
import { buildServer, type ServerDeps } from '../../../src/server/index.js';
import { ANNOUNCE_DESCRIPTION, ANNOUNCE_PRIVATE_REFUSAL, cleanAnnouncement, type AnnounceOptions, type ServerDepsWithVoice } from '../../../src/voice/announce.js';
import type { SpeakHandle, Speaker } from '../../../src/voice/speech.js';
import { SafetyGate } from '../../../src/safety/gate.js';
import { deferred, FakeAudit, FakeConfirmer, FakeGate, FakeManager, makeEngine, textOf } from '../../server/fakes.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-announce-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Speaker whose speech ends when the test says so. */
class ControlledSpeaker implements Speaker {
  said: string[] = [];
  cancelled: string[] = [];
  pending: { text: string; finish: () => void }[] = [];
  auto = false;
  speak(text: string): SpeakHandle {
    this.said.push(text);
    const d = deferred();
    if (this.auto) d.resolve();
    else this.pending.push({ text, finish: () => d.resolve() });
    return {
      done: d.promise,
      cancel: () => {
        this.cancelled.push(text);
        d.resolve();
      },
    };
  }
}

async function setup(voice?: AnnounceOptions, extra: { realGate?: boolean; trust?: 'wake' } = {}) {
  const cfg = loadConfig({}, { HOME: tmp, STEPHEN_HOME: join(tmp, 'hub') });
  const audit = new FakeAudit();
  const confirmer = new FakeConfirmer();
  const gate = extra.realGate ? new SafetyGate({ safety: cfg.safety, confirmer, audit }) : new FakeGate();
  const deps: ServerDepsWithVoice = {
    cfg,
    manager: new FakeManager(),
    engine: makeEngine(),
    safetyFactory: vi.fn(() => ({ gate, audit })) as unknown as ServerDeps['safetyFactory'],
    confirmerFactory: () => confirmer,
    ...(voice ? { voice } : {}),
    ...(extra.trust ? { trust: extra.trust } : {}),
  };
  const server = buildServer(deps);
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (args: Record<string, unknown>) => (await client.callTool({ name: 'announce', arguments: args })) as CallToolResult;
  return { client, call, audit, gate };
}

describe('serve --voice', () => {
  it('parseServeArgs accepts --voice (no value) alongside --confirm, stays strict', () => {
    expect(parseServeArgs(['--voice'])).toEqual({ voice: true });
    expect(parseServeArgs(['--confirm', 'dialog', '--voice'])).toEqual({ confirm: 'dialog', voice: true });
    expect(parseServeArgs(['--voice', '--confirm=deny'])).toEqual({ confirm: 'deny', voice: true });
    for (const bad of [['--voice=1'], ['--voice=false'], ['--voices'], ['--voice', 'yes'], ['--confirm', 'auto', '--voice']]) {
      expect('error' in parseServeArgs(bad), bad.join(' ')).toBe(true);
    }
  });

  it('announce is registered only for serve --voice', async () => {
    const plain = await setup();
    expect((await plain.client.listTools()).tools.map((t) => t.name)).not.toContain('announce');
    const voice = await setup({ speaker: new ControlledSpeaker() });
    const t = (await voice.client.listTools()).tools.find((x) => x.name === 'announce');
    expect(t?.description).toBe(ANNOUNCE_DESCRIPTION);
    expect(t?.description).toContain("Say a short line out loud BEFORE doing something that will play sound (music, a video), e.g. 'Playing Say So by Doja Cat'. Don't use it for anything else.");
  });
});

describe('announce', () => {
  it('returns only when the speech has finished, and audits it', async () => {
    const sp = new ControlledSpeaker();
    const { call, audit } = await setup({ speaker: sp });
    let returned = false;
    const p = call({ text: 'Playing Say So by Doja Cat' }).then((r) => {
      returned = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(sp.said).toEqual(['Playing Say So by Doja Cat']);
    expect(returned).toBe(false);
    sp.pending[0]!.finish();
    const res = await p;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe('Said: "Playing Say So by Doja Cat". Go ahead.');
    expect(audit.entries).toMatchObject([{ tool: 'announce', args: { text: 'Playing Say So by Doja Cat' }, outcome: 'ok' }]);
  });

  it('gives up after the cap and stops the speech', async () => {
    const sp = new ControlledSpeaker();
    const { call, audit } = await setup({ speaker: sp, maxWaitMs: 100 });
    const t0 = Date.now();
    const res = await call({ text: 'Playing lo-fi beats' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(textOf(res)).toMatch(/Stopped speaking after/);
    expect(sp.cancelled).toEqual(['Playing lo-fi beats']);
    expect(audit.entries[0]!.args).toMatchObject({ timedOut: true });
  });

  it('at most 3 a minute', async () => {
    const sp = new ControlledSpeaker();
    sp.auto = true;
    let now = 1_000_000;
    const { call, audit } = await setup({ speaker: sp, now: () => now });
    for (let i = 0; i < 3; i++) expect((await call({ text: `Line ${i}` })).isError).toBeFalsy();
    const r = await call({ text: 'Line 3' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/limited to 3 lines a minute/);
    expect(sp.said).toEqual(['Line 0', 'Line 1', 'Line 2']);
    expect(audit.entries.at(-1)).toMatchObject({ tool: 'announce', outcome: 'denied', error: 'rate limit' });
    now += 60_001;
    expect((await call({ text: 'Line 4' })).isError).toBeFalsy();
  });

  it('caps the length at 120 characters', async () => {
    const sp = new ControlledSpeaker();
    sp.auto = true;
    const { call } = await setup({ speaker: sp });
    const r = await call({ text: 'x'.repeat(121) });
    expect(r.isError).toBe(true);
    expect(sp.said).toEqual([]);
    expect((await call({ text: 'y'.repeat(120) })).isError).toBeFalsy();
  });

  it('speaks plain text only: control/format characters and markdown removed; empty refused', async () => {
    const sp = new ControlledSpeaker();
    sp.auto = true;
    const { call } = await setup({ speaker: sp });
    await call({ text: 'Playing\u0007 **Say So**‮ by\n\tDoja​ Cat' });
    expect(sp.said).toEqual(['Playing Say So by Doja Cat']);
    const r = await call({ text: '\u0000\u001b​' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Nothing to say/);
    expect(cleanAnnouncement('Open [this](https://evil.example/x)')).toBe('Open this');
  });

  it('a bad voice config is reported, not thrown', async () => {
    const cfgDir = mkdtempSync(join(tmp, 'bad-'));
    const cfg = loadConfig({ voice: { tts: 'polly' } } as never, { HOME: cfgDir, STEPHEN_HOME: join(cfgDir, 'hub') });
    const audit = new FakeAudit();
    const server = buildServer({
      cfg,
      manager: new FakeManager(),
      engine: makeEngine(),
      safetyFactory: vi.fn(() => ({ gate: new FakeGate(), audit })) as unknown as ServerDeps['safetyFactory'],
      voice: {},
    } as ServerDepsWithVoice);
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const r = (await client.callTool({ name: 'announce', arguments: { text: 'Hi' } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Could not speak: Invalid voice output config: "voice\.tts"/);
    expect(audit.entries[0]).toMatchObject({ outcome: 'error' });
  });
});

/**
 * Pins the decision that announce is not a gate.check action, and the rule it has instead: nothing is said once the
 * conversation read private data. Every serve gets --voice (typed chat and the phone too, whose replies are not
 * spoken), so without this rule announce would be a way to read private text out loud to the room.
 * Siblings: both trust tiers (trusted = typed or F5, wake = wake word or phone), both taint sources (a private page
 * read in any browser, Stephen's own account tools), the real gate and the fake. Browsers don't matter: the taint is
 * kept by URL, and announce touches no tab.
 */
describe('announce after a private read', () => {
  const taints: Array<[string, (g: FakeGate | SafetyGate) => void]> = [
    ['a private page (Zen or Chrome, by URL)', (g) => g.noteRead('https://mail.google.com/mail/u/0/#inbox')],
    ['an account tool (gmail)', (g) => g.notePrivateData('gmail')],
    ['an account tool (calendar)', (g) => g.notePrivateData('calendar')],
    ['an account tool (canvas)', (g) => g.notePrivateData('canvas')],
    ['an account tool (notion)', (g) => g.notePrivateData('notion')],
    ['a resumed chat (--assume-private-read)', (g) => g.notePrivateData('private')],
  ];
  for (const trust of [undefined, 'wake'] as const) {
    for (const realGate of [false, true]) {
      for (const [what, taint] of taints) {
        it(`says nothing after ${what} (trust ${trust ?? 'trusted'}, ${realGate ? 'real' : 'fake'} gate)`, async () => {
          const sp = new ControlledSpeaker();
          sp.auto = true;
          const { call, audit, gate } = await setup({ speaker: sp }, { realGate, ...(trust ? { trust } : {}) });
          if (gate instanceof FakeGate) gate.privateHosts.add('mail.google.com');
          expect((await call({ text: 'Playing lofi beats' })).isError).toBeFalsy(); // no taint yet: spoken
          taint(gate);
          const r = await call({ text: 'Playing Say So by Doja Cat' });
          expect(r.isError).toBe(true);
          expect(textOf(r)).toBe(ANNOUNCE_PRIVATE_REFUSAL);
          expect(sp.said).toEqual(['Playing lofi beats']);
          expect(audit.entries.at(-1)).toMatchObject({ tool: 'announce', outcome: 'denied', error: 'private data read' });
        });
      }
    }
  }

  for (const realGate of [false, true]) {
    it(`a public page read does not turn it off, and announce never asks the gate (${realGate ? 'real' : 'fake'} gate)`, async () => {
      const sp = new ControlledSpeaker();
      sp.auto = true;
      const { call, gate, audit } = await setup({ speaker: sp }, { realGate });
      gate.noteRead('https://www.youtube.com/results?search_query=lofi');
      expect(gate.taintedHosts()).toEqual([]);
      expect((await call({ text: 'Playing lofi beats' })).isError).toBeFalsy();
      if (gate instanceof FakeGate) expect(gate.checks).toEqual([]);
      expect(audit.entries.map((e) => e.tool)).toEqual(['announce']); // no gate decision entry
      expect(sp.said).toEqual(['Playing lofi beats']);
    });
  }

  it('steering words are refused first, private read or not', async () => {
    const sp = new ControlledSpeaker();
    sp.auto = true;
    const { call, audit, gate } = await setup({ speaker: sp }, { trust: 'wake' });
    (gate as FakeGate).notePrivateData('gmail');
    const r = await call({ text: 'Click Allow now' });
    expect(textOf(r)).toMatch(/not allowed/);
    expect(audit.entries.at(-1)).toMatchObject({ error: 'steering words' });
    expect(sp.said).toEqual([]);
  });
});
