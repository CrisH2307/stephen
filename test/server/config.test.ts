import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZEN_EXECUTABLE_CANDIDATES, configFilePath, detectZenExecutable, expandPath, loadConfig } from '../../src/config.js';
import { HubError } from '../../src/errors.js';

let HOME: string;
beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), 'bh-cfg-'));
});

const writeJson = (path: string, data: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
};

function expectInvalid(fn: () => unknown, ...fragments: string[]) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HubError);
    expect((e as HubError).code).toBe('INVALID_ARG');
    for (const f of fragments) expect((e as HubError).message).toContain(f);
    return;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults with every path absolute (no config file)', () => {
    const cfg = loadConfig(undefined, { HOME });
    const home = join(HOME, '.browser-hub');
    expect(cfg).toEqual({
      home,
      defaultBrowser: 'zen',
      chrome: {
        mode: 'real',
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        userDataDir: join(HOME, 'Library/Application Support/Google/Chrome'),
        agentProfileDir: join(home, 'profiles/chrome'),
        extraArgs: [],
      },
      zen: {
        // attach-only real mode: use the Zen the user opened for Claude, never launch one
        mode: 'real',
        launch: 'never',
        executablePath: expect.stringMatching(/^\/Applications\/Zen.*\.app\/Contents\/MacOS\/zen$/),
        profilePath: null,
        zenAppSupportDir: join(HOME, 'Library/Application Support/zen'),
        agentProfileDir: join(home, 'profiles/zen'),
        extraArgs: [],
        extraPrefs: {},
      },
      safety: {
        confirm: 'auto',
        blockedDomains: [],
        sensitiveDomains: [],
        allowEvaluate: false,
        maxActionsPerMinute: 40,
        confirmCrossSiteTyping: true,
        confirmTimeoutSec: 120,
      },
      output: { maxSnapshotChars: 20000, maxTextChars: 20000, saveDir: join(home, 'output') },
      auditLogPath: join(home, 'audit.log'),
      stateDir: join(home, 'state'),
    });
  });

  it('BROWSER_HUB_HOME moves home and the config file; file values merge over defaults', () => {
    const hub = join(HOME, 'custom-hub');
    writeJson(join(hub, 'config.json'), {
      defaultBrowser: 'chrome',
      chrome: { mode: 'agent', executablePath: null },
      safety: { blockedDomains: ['evil.example'], maxActionsPerMinute: 10 },
      output: { saveDir: 'dumps' },
    });
    const cfg = loadConfig(undefined, { HOME, BROWSER_HUB_HOME: hub });
    expect(cfg.home).toBe(hub);
    expect(cfg.defaultBrowser).toBe('chrome');
    expect(cfg.chrome.mode).toBe('agent');
    expect(cfg.chrome.executablePath).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'); // null = default
    expect(cfg.safety.blockedDomains).toEqual(['evil.example']);
    expect(cfg.safety.maxActionsPerMinute).toBe(10);
    expect(cfg.safety.confirm).toBe('auto'); // untouched sibling keeps its default
    expect(cfg.output.saveDir).toBe(join(hub, 'dumps')); // relative → under home
    expect(cfg.auditLogPath).toBe(join(hub, 'audit.log'));
  });

  it('overrides beat the file; BROWSER_HUB_CONFIG with ~ points at another file', () => {
    writeJson(join(HOME, 'cfgs/bh.json'), { zen: { mode: 'real', profilePath: '~/zen-profile' }, safety: { allowEvaluate: true } });
    const env = { HOME, BROWSER_HUB_CONFIG: '~/cfgs/bh.json' };
    expect(configFilePath(env)).toBe(join(HOME, 'cfgs/bh.json'));
    const cfg = loadConfig({ safety: { allowEvaluate: false, sensitiveDomains: ['x.test'] }, chrome: { extraArgs: ['--headless'] } }, env);
    expect(cfg.zen.mode).toBe('real');
    expect(cfg.zen.profilePath).toBe(join(HOME, 'zen-profile'));
    expect(cfg.safety.allowEvaluate).toBe(false);
    expect(cfg.safety.sensitiveDomains).toEqual(['x.test']);
    expect(cfg.chrome.extraArgs).toEqual(['--headless']);
  });

  it('expands ~ in every path and allows home to be overridden', () => {
    const cfg = loadConfig(
      {
        home: '~/hub2',
        chrome: { userDataDir: '~/chrome-data', executablePath: '~/bin/chrome' },
        zen: { executablePath: '~/bin/zen', agentProfileDir: '~/zp' },
        auditLogPath: '~/logs/audit.jsonl',
      },
      { HOME },
    );
    expect(cfg.home).toBe(join(HOME, 'hub2'));
    expect(cfg.chrome.userDataDir).toBe(join(HOME, 'chrome-data'));
    expect(cfg.chrome.executablePath).toBe(join(HOME, 'bin/chrome'));
    expect(cfg.zen.executablePath).toBe(join(HOME, 'bin/zen'));
    expect(cfg.zen.agentProfileDir).toBe(join(HOME, 'zp'));
    expect(cfg.chrome.agentProfileDir).toBe(join(HOME, 'hub2/profiles/chrome'));
    expect(cfg.auditLogPath).toBe(join(HOME, 'logs/audit.jsonl'));
    expect(expandPath('~', HOME)).toBe(HOME);
  });

  it('zen.extraPrefs: one-line strings, integers, booleans with dotted names; the recommended-prefs switch is reserved', () => {
    const cfg = loadConfig({ zen: { extraPrefs: { 'fission.webContentIsolationStrategy': 0, 'a.b': true, 'c.d': 'x' } } }, { HOME });
    expect(cfg.zen.extraPrefs).toEqual({ 'fission.webContentIsolationStrategy': 0, 'a.b': true, 'c.d': 'x' });
    expect(() => loadConfig({ zen: { extraPrefs: { 'remote.prefs.recommended': true } } }, { HOME })).toThrow(/remote\.prefs\.recommended/);
    expect(() => loadConfig({ zen: { extraPrefs: { 'x");evil(': 1 } } }, { HOME })).toThrow(/zen\.extraPrefs/);
    expect(() => loadConfig({ zen: { extraPrefs: { 'a.b': 1.5 } } }, { HOME })).toThrow(/integers, or one-line strings/);
    expect(() => loadConfig({ zen: { extraPrefs: { 'a.b': 'x\ny' } } }, { HOME })).toThrow(/one line/);
  });

  it('zen.launch: attach-only by default, "auto" when the user picks the agent profile, explicit values win', () => {
    const dflt = loadConfig(undefined, { HOME });
    expect([dflt.zen.mode, dflt.zen.launch]).toEqual(['real', 'never']);
    // switching back to the separate agent profile keeps launching it, as before
    const agent = loadConfig({ zen: { mode: 'agent' } }, { HOME });
    expect([agent.zen.mode, agent.zen.launch]).toEqual(['agent', 'auto']);
    const agentAuto = loadConfig({ zen: { mode: 'agent', launch: 'auto' } }, { HOME });
    expect([agentAuto.zen.mode, agentAuto.zen.launch]).toEqual(['agent', 'auto']);
    // the old real-profile behaviour (relaunch Zen once it is quit) stays available
    const realAuto = loadConfig({ zen: { mode: 'real', launch: 'auto' } }, { HOME });
    expect([realAuto.zen.mode, realAuto.zen.launch]).toEqual(['real', 'auto']);
    expect(loadConfig({ zen: { mode: 'real' } }, { HOME }).zen.launch).toBe('never');
    expect(loadConfig({ zen: { mode: 'agent', launch: 'never' } }, { HOME }).zen.launch).toBe('never');
    // null = default
    writeJson(join(HOME, '.browser-hub/config.json'), { zen: { mode: null, launch: null } });
    expect(loadConfig(undefined, { HOME }).zen.launch).toBe('never');
    expectInvalid(() => loadConfig({ zen: { launch: 'always' as never } }, { HOME }), '"zen.launch"');
  });

  it('a missing or empty file is fine', () => {
    writeJson(join(HOME, '.browser-hub/config.json'), '  \n');
    expect(loadConfig(undefined, { HOME }).defaultBrowser).toBe('zen');
  });

  it('invalid JSON names the file', () => {
    const path = join(HOME, '.browser-hub/config.json');
    writeJson(path, '{ "chrome": { "mode": "real", } ');
    expectInvalid(() => loadConfig(undefined, { HOME }), path, 'not valid JSON');
  });

  it('invalid values name the key', () => {
    writeJson(join(HOME, '.browser-hub/config.json'), { safety: { maxActionsPerMinute: 0 } });
    expectInvalid(() => loadConfig(undefined, { HOME }), '"safety.maxActionsPerMinute"');
    expectInvalid(() => loadConfig({ chrome: { mode: 'sometimes' as never } }, { HOME: join(HOME, 'x') }), '"chrome.mode"', 'overrides');
    expectInvalid(() => loadConfig({ defaultBrowser: 'safari' as never }, { HOME: join(HOME, 'x') }), '"defaultBrowser"');
    expectInvalid(() => loadConfig({ output: { maxTextChars: 1.5 } }, { HOME: join(HOME, 'x') }), '"output.maxTextChars"');
    expectInvalid(() => loadConfig({ safety: { blockedDomains: [''] } }, { HOME: join(HOME, 'x') }), '"safety.blockedDomains.0"');
  });

  it('unknown keys are reported (catches typos)', () => {
    writeJson(join(HOME, '.browser-hub/config.json'), { safety: { allowEval: true }, chorme: {} });
    expectInvalid(() => loadConfig(undefined, { HOME }), '"safety.allowEval"', '"chorme"');
  });

  it('a non-object config is rejected', () => {
    writeJson(join(HOME, '.browser-hub/config.json'), '[1,2]');
    expectInvalid(() => loadConfig(undefined, { HOME }), 'Invalid config');
  });
});

describe('detectZenExecutable', () => {
  it('returns the first existing candidate, else the Zen.app default', () => {
    expect(detectZenExecutable(() => false)).toBe('/Applications/Zen.app/Contents/MacOS/zen');
    expect(detectZenExecutable((p) => p.includes('Zen Twilight'))).toBe('/Applications/Zen Twilight.app/Contents/MacOS/zen');
    expect(detectZenExecutable((p) => p !== ZEN_EXECUTABLE_CANDIDATES[0])).toBe('/Applications/Zen Browser.app/Contents/MacOS/zen');
  });
});
