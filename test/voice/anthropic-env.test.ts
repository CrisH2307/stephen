/**
 * R23: no model endpoint from the shell. Claude's environment (voice, phone and jobs) is built from an allow-list, so
 * no endpoint, proxy, trust or code-loading variable from the shell reaches it, and sign-in still works.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildJobEnv } from '../../src/jobs/spec.js';
import { phoneClaudeEnv, phoneConfigDir } from '../../src/phone/setup.js';
import { claudeConfigDir } from '../../src/lib/claude-env.js';
import { KEPT_ANTHROPIC_ENV, KEPT_BASE_ENV, claudeSpawnOptions, droppedEndpointEnv, probeClaudeFlags, withoutSecrets } from '../../src/voice/claude.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-r23-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** What must never reach Claude, whatever the shell has. */
const RISKY = {
  ANTHROPIC_BASE_URL: 'https://proxy.example',
  ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-proxy.example',
  ANTHROPIC_VERTEX_BASE_URL: 'https://vertex-proxy.example',
  ANTHROPIC_CUSTOM_HEADERS: 'x-a: b',
  ANTHROPIC_MODEL: 'some-model',
  HTTPS_PROXY: 'http://mitm.example:8080',
  https_proxy: 'http://mitm.example:8080',
  HTTP_PROXY: 'http://mitm.example:8080',
  http_proxy: 'http://mitm.example:8080',
  ALL_PROXY: 'socks5://mitm.example:1080',
  all_proxy: 'socks5://mitm.example:1080',
  NO_PROXY: 'anthropic.com',
  no_proxy: 'anthropic.com',
  SSL_CERT_FILE: '/tmp/evil-ca.pem',
  REQUESTS_CA_BUNDLE: '/tmp/evil-ca.pem',
  AWS_CA_BUNDLE: '/tmp/evil-ca.pem',
  AWS_CONFIG_FILE: '/tmp/evil-aws-config',
  AWS_SHARED_CREDENTIALS_FILE: '/tmp/evil-aws-creds',
  DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
  LD_PRELOAD: '/tmp/evil.so',
  ANTHROPIC_FOUNDRY_BASE_URL: 'https://foundry-proxy.example',
  CLAUDE_CODE_API_BASE_URL: 'https://proxy.example',
  STEPHEN_EVAL_YOUTUBE: '1',
  STEPHEN_TEST_CHROME: '/tmp/chrome',
  NODE_OPTIONS: '--require /tmp/evil.js',
  NODE_EXTRA_CA_CERTS: '/tmp/evil-ca.pem',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  AWS_ENDPOINT_URL: 'https://aws-proxy.example',
  AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://bedrock-proxy.example',
  ELEVENLABS_API_KEY: 'sk_fake',
  CANVAS_API_TOKEN: 'fake',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'parent',
};
/** What must still reach Claude: the basics, sign-in, Stephen's home, provider sign-in. */
const KEEP = {
  PATH: '/usr/bin',
  HOME: '/Users/me',
  LANG: 'en_US.UTF-8',
  STEPHEN_HOME: '/Users/me/.stephen',
  ANTHROPIC_API_KEY: 'sk-ant-fake',
  ANTHROPIC_AUTH_TOKEN: 'tok-fake',
  ANTHROPIC_VERTEX_PROJECT_ID: 'my-project',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fake',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_REGION: 'us-east-1',
  AWS_PROFILE: 'me',
};
const shell = { ...RISKY, ...KEEP };

describe('R23: the voice Claude', () => {
  it('gets nothing risky from the shell, and keeps sign-in, home and provider sign-in', () => {
    const env = withoutSecrets(shell);
    for (const k of Object.keys(RISKY)) expect(env, k).not.toHaveProperty(k);
    expect(env).toEqual(KEEP);
  });

  it('a name on no list is dropped by default', () => {
    expect(withoutSecrets({ PATH: '/usr/bin', SOMETHING_NEW: 'x', ANTHROPIC_SOMETHING_NEW: 'y' })).toEqual({ PATH: '/usr/bin' });
    // The test fakes for `claude` read FAKE_* settings; Claude Code ignores them.
    expect(withoutSecrets({ FAKE_CLAUDE_MODE: 'hang' })).toEqual({ FAKE_CLAUDE_MODE: 'hang' });
  });

  it('no kept name can move the endpoint, add a proxy or load code', () => {
    for (const k of [...KEPT_BASE_ENV, ...KEPT_ANTHROPIC_ENV]) expect(k).not.toMatch(/BASE_URL|ENDPOINT|PROXY|HEADERS|^NODE_/i);
  });

  it('both Claude wrappers spawn with the allow-listed env', () => {
    const env = claudeSpawnOptions({ cwd: '/tmp', env: shell }, 'pipe').env!;
    expect(env).toEqual(KEEP);
  });
});

describe('R23 siblings: the phone Claude and jobs', () => {
  it('the phone Claude gets the same allow-list, plus its own config folder and the plugin switch', () => {
    const env = phoneClaudeEnv('/h', shell);
    for (const k of Object.keys(RISKY)) expect(env, k).not.toHaveProperty(k);
    expect(env.CLAUDE_CONFIG_DIR).toBe(phoneConfigDir('/h'));
    expect(env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS).toBe('1');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-fake');
  });

  it('a job gets none of the risky names (its env is built from scratch)', () => {
    const env = buildJobEnv(shell);
    for (const k of Object.keys(RISKY)) expect(env, k).not.toHaveProperty(k);
  });
});

describe('R23: the doctor note', () => {
  it('names every dropped endpoint, proxy and trust variable, sorted, values never', () => {
    const names = droppedEndpointEnv(shell);
    expect(names).toEqual([
      'ALL_PROXY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_MODEL',
      'ANTHROPIC_VERTEX_BASE_URL', 'AWS_CA_BUNDLE', 'AWS_CONFIG_FILE', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'AWS_SHARED_CREDENTIALS_FILE',
      'DYLD_INSERT_LIBRARIES', 'HTTPS_PROXY', 'HTTP_PROXY', 'LD_PRELOAD', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED',
      'NO_PROXY', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'all_proxy', 'http_proxy', 'https_proxy', 'no_proxy',
    ]);
    expect(names.join(' ')).not.toContain('mitm');
    expect(droppedEndpointEnv(KEEP)).toEqual([]);
  });
});

describe('R23 review L1: one safe CLAUDE_CONFIG_DIR for Claude and for transcript cleanup', () => {
  const home = join(tmp, 'home');
  mkdirSync(join(home, '.claude-alt'), { recursive: true });
  mkdirSync(join(tmp, 'outside'), { recursive: true });
  symlinkSync(join(tmp, 'outside'), join(home, '.claude-link'));

  it('a real folder inside the home is kept, resolved', () => {
    expect(withoutSecrets({ CLAUDE_CONFIG_DIR: join(home, '.claude-alt', '..', '.claude-alt') }, home).CLAUDE_CONFIG_DIR).toBe(join(home, '.claude-alt'));
  });

  it('outside the home, relative, missing, a symlink or the home itself: dropped', () => {
    for (const bad of [join(tmp, 'outside'), '.claude-alt', join(home, 'missing'), join(home, '.claude-link'), home, '']) {
      expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: bad }, home), bad).toBeUndefined();
      expect(withoutSecrets({ CLAUDE_CONFIG_DIR: bad }, home), bad).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    }
  });
});

describe('R23 review M1: the help probe also gets the allow-listed env', () => {
  it('claude --help runs with no proxy, NODE_OPTIONS or endpoint variable', async () => {
    const out = join(tmp, 'probe-env.txt');
    const fake = join(tmp, 'fake-claude.sh');
    writeFileSync(fake, `#!/bin/sh\nenv > "${out}"\necho "not claude help"\n`);
    chmodSync(fake, 0o755);
    await probeClaudeFlags(fake, shell);
    const seen = readFileSync(out, 'utf8').split('\n').map((l) => l.split('=')[0]);
    for (const k of Object.keys(RISKY)) expect(seen, k).not.toContain(k);
    expect(seen).toContain('ANTHROPIC_API_KEY');
  });
});
