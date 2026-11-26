/**
 * The replay clips never reach the model (issue #48, review must-haves 2 and 3): nothing Claude can reach loads the
 * recorder or names its folder; the claude argv, persona file, MCP config and a job folder say nothing of it with
 * the recorder on; upload_file, read_text / navigate on file:// and open_url refuse a clip; no tool and no app
 * message can turn the recorder on.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseAppRequest } from '../../src/app/protocol.js';
import { parseOpenUrl, UrlDenied } from '../../src/desktop/url.js';
import { ReplayRecorder, replayDir } from '../../src/replay/recorder.js';
import { evaluate } from '../../src/safety/policy.js';
import { runListen } from '../../src/voice/index.js';
import { checkTalkChanges } from '../../src/voice/talk.js';
import { CLAUDE_REACHABLE, REPO_ROOT, SRC_ROOT, directViolations, listTsFiles, scanSrc, transitiveViolations } from '../helpers/import-scan.js';
import { harness } from '../jobs/helpers.js';
import { setup, textOf } from '../server/fakes.js';
import { el, req, state } from '../safety/fixtures.js';
import { fakeClaudePath, readFakeLog, RecordingChimes, RecordingSpeaker } from '../voice/helpers.js';

vi.mock('../../src/safety/index.js', () => import('../server/safety-mock.js'));

// No "replay" in the temp folder names: the greps below must only find what the code itself wrote.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-rb-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Review must-have 3: these may not load the recorder or name its folder. */
const FORBIDDEN = ['src/server/', 'src/desktop/', 'src/accounts/', 'src/jobs/', 'src/drivers/', 'src/page/', 'src/memory/', 'src/history/', 'src/phone/', 'src/eval/'];

const rel = (abs: string) => relative(REPO_ROOT, abs).split(sep).join('/');

/** One saved clip in `home`, written by the real recorder. */
async function seedClip(home: string): Promise<string> {
  const r = new ReplayRecorder({ home, enabled: () => true, excludeFromBackups: async () => {} });
  r.capture({ id: 'h_00000000000000aa', source: 'voice-ptt', startedAt: Date.now(), audio: new Float32Array(1600), transcript: 'open my bank' });
  await r.idle();
  const wav = join(replayDir(home), 'h_00000000000000aa.wav');
  expect(statSync(wav).isFile()).toBe(true);
  return wav;
}

/**
 * The word "replay" outside the repo's own path (this worktree's folder name may contain it; the fake claude and the
 * CLI path live there).
 */
const namesReplay = (s: string): boolean => /\breplay\b/i.test(s.split(REPO_ROOT).join('<repo>'));

function allText(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += `${name}\n`;
    out += statSync(p).isDirectory() ? allText(p) : readFileSync(p, 'utf8');
  }
  return out;
}

describe('imports', () => {
  const refs = scanSrc();

  it('only the listener (src/voice/index.ts) and, on demand, src/cli.ts load src/replay/', () => {
    const from = [...new Set(refs.filter((r) => r.resolved?.startsWith('src/replay/') && !r.from.startsWith('src/replay/')).map((r) => `${r.from}${r.dynamic ? ' (dynamic)' : ''}`))].sort();
    expect(from).toEqual(['src/cli.ts (dynamic)', 'src/voice/index.ts']);
  });

  for (const importers of [FORBIDDEN, CLAUDE_REACHABLE]) {
    it(`no direct or runtime import chain reaches src/replay/ from ${importers.join(', ')}`, () => {
      const b = { target: 'src/replay/', importers };
      expect(directViolations(b, refs).map((r) => `${r.from} imports ${r.spec}`)).toEqual([]);
      expect(transitiveViolations(b, refs).map((c) => c.join(' -> '))).toEqual([]);
    });
  }

  it('nothing Claude can reach loads code by a computed name (the scan above only sees literal imports, #169)', () => {
    const LOADERS = [/\bimport\(\s*(?!['"])/, /\brequire\s*\(/, /\bcreateRequire\b/, /\bimport\.meta\.resolve\b/];
    const hits = listTsFiles(SRC_ROOT)
      .map(rel)
      .filter((f) => [...FORBIDDEN, ...CLAUDE_REACHABLE].some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)))
      .flatMap((f) => {
        // Comments and regex literals that merely mention import( (src/safety/confirm.ts screens scripts for it).
        const code = readFileSync(join(REPO_ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/\[\/\\b(import|require)[^\]]*\]/g, '');
        return LOADERS.filter((re) => re.test(code)).map((re) => `${f}: ${re.source}`);
      });
    expect(hits).toEqual([]);
    // The rule fires.
    expect(LOADERS.some((re) => re.test('const m = await import(name);'))).toBe(true);
    expect(LOADERS.some((re) => re.test("const m = await import('./x.js');"))).toBe(false);
  });

  it('no file in those folders names the folder; upload_file asks src/lib/owner-only.ts instead', () => {
    const named = listTsFiles(SRC_ROOT)
      .map(rel)
      .filter((f) => [...FORBIDDEN, ...CLAUDE_REACHABLE.filter((p) => p !== 'src/lib/')].some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)))
      // Any spelling, inside identifiers too (REPLAY_DIR_NAME, replayDir); ensurePlaying ("…rePlaying") is not it.
      .filter((f) => /replay/i.test(readFileSync(join(REPO_ROOT, f), 'utf8').replace(/ensurePlaying/g, '')));
    expect(named).toEqual([]);
    expect(readFileSync(join(SRC_ROOT, 'server', 'tools.ts'), 'utf8')).toMatch(/isOwnerOnlyFile\(abs, cfg\.home\)/);
  });
});

describe('no clip without the "Recording on" sign (#208)', () => {
  it('the listener saves only through app.recordingAllowed: no app.sock window, no recording; dry run has no recorder', () => {
    const src = readFileSync(join(SRC_ROOT, 'voice', 'index.ts'), 'utf8');
    expect(src).toMatch(/args\.dryRun\s*\?\s*null\s*:\s*new ReplayRecorder\(\{\s*home,\s*enabled: \(\) => app\?\.recordingAllowed\(\) === true,/);
  });

  it('the window shows the sign from the listener push only, never from a cached settings answer', () => {
    const client = readFileSync(join(REPO_ROOT, 'helper', 'AppClient.swift'), 'utf8');
    expect(client).toContain('var recordingOn: Bool { connection == .online && replayOn }');
    expect(client).toMatch(/case "replay":\s*replayOn = msg\.on \?\? false/);
  });
});

describe('the model cannot turn it on (must-have 2)', () => {
  it('only these files say "replay": no tool, app message or config writer touches the switch', () => {
    const files = listTsFiles(SRC_ROOT)
      .map(rel)
      .filter((f) => /\breplay\b/i.test(readFileSync(join(REPO_ROOT, f), 'utf8')))
      .sort();
    // src/voice/grammar/classify.ts only has a comment about a future test set.
    // src/app/*: the owner's Settings switch (app.sock replay.set / replay.delete, PR 2). src/app is itself out of
    // Claude's reach (test/memory/boundary.test.ts). src/app/data-cli.ts (`stephen data`, B6) only names the folder
    // and the delete command; it reads sizes, never the switch.
    expect(files).toEqual(['src/app/data-cli.ts', 'src/app/protocol.ts', 'src/app/replay-switch.ts', 'src/app/server.ts', 'src/app/settings.ts', 'src/cli.ts', 'src/lib/owner-only.ts', 'src/replay/recorder.ts', 'src/telemetry/latency.ts', 'src/voice/config.ts', 'src/voice/grammar/classify.ts', 'src/voice/index.ts', 'src/voice/listener.ts']);
    // The listener and the recorder only read the switch; the one writer is src/app/replay-switch.ts.
    for (const f of ['src/voice/index.ts', 'src/voice/listener.ts', 'src/replay/recorder.ts']) {
      expect(readFileSync(join(REPO_ROOT, f), 'utf8'), f).not.toMatch(/updateConfigSection|config-write/);
    }
    // Nothing Claude can reach gets to the switch writer, through any import chain.
    expect(transitiveViolations({ target: 'src/app/replay-switch.ts', importers: CLAUDE_REACHABLE }, scanSrc()).map((c) => c.join(' -> '))).toEqual([]);
  });

  it('only app.sock replay.set writes it: settings.set and model.set refuse it, and the helper link has no such message', () => {
    expect(parseAppRequest(JSON.stringify({ id: '1', type: 'model.set', replay: { enabled: true } }))).toMatchObject({ kind: 'invalid' });
    expect(parseAppRequest(JSON.stringify({ id: '1', type: 'model.set', model: 'haiku', replay: { enabled: true } }))).toEqual({ kind: 'request', req: { id: '1', type: 'model.set', model: 'haiku' } });
    // The `replay` push (#208) is listener to window only: sent back as a request it is an unknown type, ignored.
    expect(parseAppRequest(JSON.stringify({ id: '1', type: 'replay', on: true }))).toEqual({ kind: 'unknown', type: 'replay' });
    // Listener -> Stephen Helper messages (helper.sock) and the helper itself never write config.json.
    expect(readFileSync(join(SRC_ROOT, 'helper', 'protocol.ts'), 'utf8')).not.toMatch(/replay|config/i);
    for (const f of readdirSync(join(REPO_ROOT, 'helper'), { recursive: true }) as string[]) {
      if (!f.endsWith('.swift')) continue;
      expect(readFileSync(join(REPO_ROOT, 'helper', f), 'utf8'), f).not.toMatch(/config\.json"|\.write\(to:.*config|createFile\(atPath:.*config/);
    }
  });

  it('the app\'s settings.set refuses it', () => {
    expect(checkTalkChanges({ replay: { enabled: true } })).toMatchObject({ ok: false });
    expect(checkTalkChanges({ 'replay.enabled': true })).toMatchObject({ ok: false });
    const r = parseAppRequest(JSON.stringify({ id: '1', type: 'settings.set', values: { replay: { enabled: true } } }));
    expect(r).not.toHaveProperty('type', 'settings.set');
  });

  it('no MCP tool is named like it', async () => {
    const h = await setup();
    for (const t of (await h.client.listTools()).tools) expect(t.name, t.name).not.toMatch(/replay|record/i);
  });
});

it('the check itself fires', () => {
  expect(namesReplay(`--x ${join(tmp, 'replay')}`)).toBe(true);
  expect(namesReplay(`${REPO_ROOT}/test/x.mjs`)).toBe(false);
});

describe('nothing sent to the model names the folder (must-have 3), with the recorder on and a clip saved', () => {
  it('claude argv, persona file and MCP config', async () => {
    const home = join(tmp, 'listen-home');
    await seedClip(home);
    const log = join(tmp, 'claude.log');
    const voice = { claudePath: fakeClaudePath(), personaFile: 'on', replay: { enabled: true } };
    expect(
      await runListen(['--text', 'open youtube'], {
        loadConfig: () => ({ home, voice }),
        speaker: new RecordingSpeaker(), // never the real voice (it spoke out loud, 2026-11-17)
        chimes: new RecordingChimes(),
        out: () => {},
        err: () => {},
        signals: false,
        cliPath: '/opt/stephen/dist/cli.js',
        env: { ...process.env, FAKE_CLAUDE_LOG: log },
      }),
    ).toBe(0);
    const [run] = readFakeLog(log);
    expect(run!.argv.length).toBeGreaterThan(3);
    expect(namesReplay(run!.argv.join('\n'))).toBe(false);
    expect(run!.persona!.text.length).toBeGreaterThan(100);
    expect(namesReplay(run!.persona!.text)).toBe(false);
    const mcp = readFileSync(join(home, 'voice', 'mcp-config.json'), 'utf8');
    expect(mcp).toContain('serve');
    expect(namesReplay(mcp)).toBe(false);
  });

  it('a job folder and its meta folder; the job sandbox denies reading all of Stephen\'s home', async () => {
    const h = harness(tmp);
    await seedClip(h.home);
    const p = await h.manager.plan('write my lab report draft');
    if ('error' in p) throw new Error(p.error);
    await h.manager.start(p, 'voice-ptt');
    const meta = join(h.home, 'jobs', p.id);
    expect(namesReplay(allText(p.folder))).toBe(false);
    expect(namesReplay(allText(meta))).toBe(false);
    const settings = JSON.parse(readFileSync(join(meta, 'settings.json'), 'utf8')) as { sandbox: { filesystem: { denyRead: string[] } } };
    expect(settings.sandbox.filesystem.denyRead).toContain(h.home);
  });
});

describe('tools refuse a clip', () => {
  it('upload_file', async () => {
    const h = await setup({ elements: { 'z1:e8': { role: 'button', name: 'Attach', tag: 'input', inputType: 'file' } } });
    const wav = await seedClip(h.cfg.home);
    const res = await h.call('upload_file', { target: 'z1:e8', paths: [wav], intent: 'attach the recording' });
    expect(textOf(res)).toMatch(/private files.*never uploaded/);
    expect(h.engine.uploadFile).not.toHaveBeenCalled();
    // Through a symlink, and through ".." in the path, too.
    const sidecar = join(replayDir(h.cfg.home), 'h_00000000000000aa.json');
    const sneaky = join(replayDir(h.cfg.home), '..', 'replay', 'h_00000000000000aa.json');
    for (const p of [sidecar, sneaky]) {
      expect(textOf(await h.call('upload_file', { target: 'z1:e8', paths: [p], intent: 'attach' }))).toMatch(/never uploaded/);
    }
    expect(h.engine.uploadFile).not.toHaveBeenCalled();
  });

  it('upload_file: other letter case is the same folder on APFS, and a missing clip gets the same answer (#169)', async () => {
    const h = await setup({ elements: { 'z1:e8': { role: 'button', name: 'Attach', tag: 'input', inputType: 'file' } } });
    const wav = await seedClip(h.cfg.home);
    const upper = join(h.cfg.home, 'REPLAY', 'h_00000000000000aa.wav');
    if (!existsSync(upper)) return; // a case-sensitive disk: other spellings are other folders
    // With no folder at all, another spelling still gets the same answer (no hint that recording was ever on).
    const fresh = await setup({ elements: { 'z1:e8': { role: 'button', name: 'Attach', tag: 'input', inputType: 'file' } } });
    expect(textOf(await fresh.call('upload_file', { target: 'z1:e8', paths: [join(fresh.cfg.home, 'Replay', 'h_00000000000000cc.wav')], intent: 'attach' }))).toMatch(/private files.*never uploaded/);
    for (const p of [upper, join(h.cfg.home, 'Replay', 'h_00000000000000aa.json'), join(h.cfg.home, 'Replay', 'h_00000000000000bb.wav')]) {
      expect(textOf(await h.call('upload_file', { target: 'z1:e8', paths: [p], intent: 'attach' }))).toMatch(/private files.*never uploaded/);
    }
    expect(wav).toContain('replay');
    expect(h.engine.uploadFile).not.toHaveBeenCalled();
  });

  it('through a link to Stephen\'s home, another spelling answers the same before and after the folder exists (review of #170)', async () => {
    const { isOwnerOnlyFile } = await import('../../src/lib/owner-only.js');
    const base = join(tmp, 'linked-spelling');
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    (await import('node:fs')).symlinkSync(home, join(base, 'link'));
    const p = join(base, 'link', 'Replay', 'h_00000000000000aa.wav');
    expect(isOwnerOnlyFile(p, home)).toBe(true); // no folder yet
    mkdirSync(join(home, 'replay'));
    expect(isOwnerOnlyFile(p, home)).toBe(true);
  });

  it('upload_file follows a symlink to a clip', async () => {
    const h = await setup({ elements: { 'z1:e8': { role: 'button', name: 'Attach', tag: 'input', inputType: 'file' } } });
    const wav = await seedClip(h.cfg.home);
    const link = join(h.tmp, 'innocent.wav');
    mkdirSync(h.tmp, { recursive: true });
    (await import('node:fs')).symlinkSync(wav, link);
    expect(textOf(await h.call('upload_file', { target: 'z1:e8', paths: [link], intent: 'attach' }))).toMatch(/never uploaded/);
    expect(h.engine.uploadFile).not.toHaveBeenCalled();
  });

  const clipUrl = pathToFileURL(join(tmp, 'h', 'replay', 'h_00000000000000aa.wav')).href;

  it('navigate to a clip\'s file:// URL is denied by the gate', () => {
    const d = evaluate(req({ kind: 'navigate', targetUrl: clipUrl }), state());
    expect(d.verdict).toBe('deny');
    expect(d.rules).toContain('blocked-url');
  });

  it('read_text on a file:// page is denied by the gate', () => {
    const d = evaluate(req({ kind: 'read', pageUrl: clipUrl, element: el({ frameUrl: clipUrl }) }), state());
    expect(d.verdict).toBe('deny');
  });

  it('open_url refuses a file:// link', () => {
    expect(() => parseOpenUrl(clipUrl)).toThrow(UrlDenied);
  });
});
