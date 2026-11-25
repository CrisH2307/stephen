/**
 * R23: no model endpoint from the shell. Claude's environment (voice, phone and jobs) is built from an allow-list, so
 * no endpoint, proxy, trust or code-loading variable from the shell reaches it, and sign-in still works.
 */
import { describe, expect, it } from 'vitest';
import { buildJobEnv } from '../../src/jobs/spec.js';
import { phoneClaudeEnv, phoneConfigDir } from '../../src/phone/setup.js';
import { KEPT_ANTHROPIC_ENV, KEPT_BASE_ENV, claudeSpawnOptions, droppedEndpointEnv, withoutSecrets } from '../../src/voice/claude.js';

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
  ALL_PROXY: 'socks5://mitm.example:1080',
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
  CLAUDE_CONFIG_DIR: '/Users/me/.claude-alt',
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
      'ALL_PROXY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL', 'ANTHROPIC_VERTEX_BASE_URL',
      'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS',
      'NODE_TLS_REJECT_UNAUTHORIZED', 'https_proxy',
    ]);
    expect(names.join(' ')).not.toContain('mitm');
    expect(droppedEndpointEnv(KEEP)).toEqual([]);
  });
});
