/** The eval scorer and the case list. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { EVAL_ABOUT_ME, EVAL_CASES, type EvalCase } from '../../src/eval/cases.js';
import { buildDryRunServer, type DryCall } from '../../src/eval/dry-server.js';
import { callMatches, replyAsks, scoreRun } from '../../src/eval/score.js';
import { parseVoiceConfig } from '../../src/voice/config.js';
import type { ServerDeps } from '../../src/server/index.js';
import { FakeManager, makeEngine } from '../server/fakes.js';

let n = 0;
const c = (tool: string, args: Record<string, unknown> = {}): DryCall => ({ tool, args, n: ++n });
const caseById = (id: string): EvalCase => EVAL_CASES.find((k) => k.id === id)!;
const maps = (o: string, d: string, mode = 'transit') =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&travelmode=${mode}`;

describe('scoreRun', () => {
  it('ordered calls with regex args (decoded URLs too)', () => {
    const e = { calls: [{ tool: 'open_url', args: { url: ['maps/dir', 'destination=[^&]*union'] } }] };
    expect(scoreRun(e, { calls: [c('open_url', { url: maps('Home', 'Union Station') })], reply: 'opened it' }).pass).toBe(true);
    const r = scoreRun(e, { calls: [c('open_url', { url: maps('Home', 'CN Tower') })], reply: '' });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/^missing call open_url\(url~/);
  });

  it('order matters, other calls may come in between', () => {
    const e = { calls: [{ tool: 'open_app', args: { app: 'notion' } }, { tool: 'play_media' }] };
    expect(scoreRun(e, { calls: [c('open_app', { app: 'Notion' }), c('announce'), c('play_media')], reply: '' }).pass).toBe(true);
    expect(scoreRun(e, { calls: [c('play_media'), c('open_app', { app: 'Notion' })], reply: '' }).pass).toBe(false);
  });

  it('the same expected call twice needs two matching calls', () => {
    const e = { calls: [{ tool: 'open_url' }, { tool: 'open_url' }] };
    expect(scoreRun(e, { calls: [c('open_url')], reply: '' }).reasons).toEqual(['missing call open_url']);
  });

  it('tool names match whole (open_url|open_app), not as substrings', () => {
    expect(callMatches(c('open_app'), { tool: 'open_url|open_app' })).toBe(true);
    expect(callMatches(c('open_application'), { tool: 'open_app' })).toBe(false);
  });

  it('_any matches across all arguments; non-strings compare as JSON', () => {
    expect(callMatches(c('open_url', { url: 'https://www.notion.so' }), { tool: 'open_url', args: { _any: 'notion' } })).toBe(true);
    expect(callMatches(c('open_url', { url: 'x', new_tab: true }), { tool: 'open_url', args: { new_tab: 'true' } })).toBe(true);
    expect(callMatches(c('open_url', { url: 'x' }), { tool: 'open_url', args: { new_tab: 'true' } })).toBe(false);
  });

  it('noCalls, maxCalls, atMost, asks, replyMatches, run errors', () => {
    const run = { calls: [c('announce'), c('announce'), c('type')], reply: 'Which one do you mean?' };
    const r = scoreRun({ noCalls: ['type'], maxCalls: 2, atMost: { announce: 1 }, asks: false, replyMatches: ['lofi'] }, run);
    expect(r.reasons).toEqual(['called type (should not)', '3 calls (max 2)', '2 announce calls (max 1)', 'asked back instead of doing it', "reply doesn't match /lofi/"]);
    expect(scoreRun({ asks: true }, { calls: [], reply: 'Done.' }).reasons).toEqual(['should have asked first']);
    expect(scoreRun({}, { calls: [], reply: '', error: 'timed out' }).reasons).toEqual(['run failed: timed out']);
    expect(replyAsks('which station?')).toBe(true);
  });
});

describe('EVAL_CASES', () => {
  it('has unique ids, compiling regexes, and at least 30 cases across every category', () => {
    const ids = EVAL_CASES.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(EVAL_CASES.map((k) => k.category))).toEqual(new Set(['single', 'misheard', 'multi', 'routes', 'vague', 'cant-yet', 'careful', 'media']));
    for (const k of EVAL_CASES) {
      const res = [...(k.expect.calls ?? []).flatMap((e) => [e.tool, ...Object.values(e.args ?? {}).flat()]), ...(k.expect.noCalls ?? []), ...(k.expect.replyMatches ?? [])];
      for (const r of res) expect(() => new RegExp(r, 'i'), `${k.id}: ${r}`).not.toThrow();
      expect(k.say).toBe(k.say.toLowerCase()); // what speech recognition + normalizeTranscript hand over
    }
  });

  it('every expected tool and argument exists on the real server', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cases-'));
    const deps = { cfg: loadConfig({}, { HOME: tmp, STEPHEN_HOME: join(tmp, 'hub') }), manager: new FakeManager(), engine: makeEngine(), safetyFactory: (() => ({})) as unknown as ServerDeps['safetyFactory'], voice: {} };
    const { server } = buildDryRunServer(deps, '0', () => undefined);
    const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> })._registeredTools;
    const tools = Object.keys(registered);
    for (const k of EVAL_CASES) {
      for (const e of k.expect.calls ?? []) {
        const matching = tools.filter((t) => new RegExp(`^(?:${e.tool})$`, 'i').test(t));
        expect(matching.length, `${k.id}: ${e.tool}`).toBeGreaterThan(0);
        for (const arg of Object.keys(e.args ?? {})) {
          if (arg === '_any') continue;
          const has = matching.some((t) => {
            const sch = registered[t]!.inputSchema as { shape?: Record<string, unknown>; def?: { shape?: Record<string, unknown> } } | undefined;
            const shape = sch?.shape ?? sch?.def?.shape ?? {};
            return arg in shape;
          });
          expect(has, `${k.id}: ${e.tool}.${arg}`).toBe(true);
        }
      }
      for (const t of k.expect.noCalls ?? []) expect(tools.some((x) => new RegExp(`^(?:${t})$`).test(x)), `${k.id}: noCalls ${t}`).toBe(true);
    }
  });

  it('EVAL_ABOUT_ME is a valid voice.aboutMe', () => {
    expect(parseVoiceConfig({ aboutMe: EVAL_ABOUT_ME }).aboutMe).toEqual(EVAL_ABOUT_ME);
  });

  it('owner example "routes from my home to two stations": a good run passes, the reported behaviours fail', () => {
    const k = caseById('routes-two-stations');
    const home = EVAL_ABOUT_ME.home!;
    const good = [c('open_url', { url: maps(home, 'Oshawa GO Station'), new_tab: true }), c('open_url', { url: maps(home, 'Whitby GO Station'), new_tab: true })];
    expect(scoreRun(k.expect, { calls: good, reply: 'Opened routes to Oshawa GO and Whitby GO.' }).pass).toBe(true);
    // what used to happen: asked for the address
    expect(scoreRun(k.expect, { calls: [], reply: "What's your home address?" }).reasons).toEqual(expect.arrayContaining(['asked back instead of doing it']));
    // two routes into one reused tab (no new_tab)
    const reused = good.map((x) => ({ ...x, args: { url: x.args.url } }));
    expect(scoreRun(k.expect, { calls: reused, reply: 'ok' }).pass).toBe(false);
    // origin left out (current location instead of home)
    const noOrigin = [c('open_url', { url: 'https://www.google.com/maps/dir/?api=1&destination=Oshawa%20GO', new_tab: true }), c('open_url', { url: 'https://www.google.com/maps/dir/?api=1&destination=Whitby%20GO', new_tab: true })];
    expect(scoreRun(k.expect, { calls: noOrigin, reply: 'ok' }).pass).toBe(false);
  });

  it('owner example "canvas + google doc": typing into the doc fails; opening Canvas and saying what is missing passes', () => {
    const k = caseById('cant-canvas-doc');
    expect(scoreRun(k.expect, { calls: [c('open_url', { url: 'https://canvas.example' })], reply: "Opened Canvas, but I can't write Google Docs yet." }).pass).toBe(true);
    expect(scoreRun(k.expect, { calls: [c('open_url'), c('type', { text: 'summary' })], reply: 'Wrote it.' }).pass).toBe(false);
  });
});
