/** R23: no model endpoint from the shell. Claude and jobs never get an ANTHROPIC_* variable that moves the endpoint. */
import { describe, expect, it } from 'vitest';
import { buildJobEnv } from '../../src/jobs/spec.js';
import { KEPT_ANTHROPIC_ENV, claudeSpawnOptions, droppedAnthropicEnv, withoutSecrets } from '../../src/voice/claude.js';

const shell = {
  PATH: '/usr/bin',
  HOME: '/Users/me',
  ANTHROPIC_BASE_URL: 'https://proxy.example',
  ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-proxy.example',
  ANTHROPIC_VERTEX_BASE_URL: 'https://vertex-proxy.example',
  ANTHROPIC_CUSTOM_HEADERS: 'x-a: b',
  ANTHROPIC_MODEL: 'some-model',
  ANTHROPIC_API_KEY: 'sk-ant-fake',
  ANTHROPIC_AUTH_TOKEN: 'tok-fake',
  ANTHROPIC_VERTEX_PROJECT_ID: 'my-project',
};

describe('R23: the voice Claude gets no endpoint from the shell', () => {
  it('drops every ANTHROPIC_* variable except sign-in and the Vertex project', () => {
    const env = withoutSecrets(shell);
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL']) {
      expect(env, k).not.toHaveProperty(k);
    }
    expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant-fake', ANTHROPIC_AUTH_TOKEN: 'tok-fake', ANTHROPIC_VERTEX_PROJECT_ID: 'my-project', PATH: '/usr/bin' });
  });

  it('the kept list holds no *_BASE_URL, and any new ANTHROPIC_ name is dropped by default', () => {
    for (const k of KEPT_ANTHROPIC_ENV) expect(k).not.toMatch(/BASE_URL|HEADERS/);
    expect(withoutSecrets({ ANTHROPIC_SOMETHING_NEW: 'x' })).not.toHaveProperty('ANTHROPIC_SOMETHING_NEW');
  });

  it('both Claude wrappers spawn with the scrubbed env', () => {
    const env = claudeSpawnOptions({ cwd: '/tmp', env: shell }, 'pipe').env!;
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-fake');
  });

  it('droppedAnthropicEnv names what doctor reports, sorted, and nothing when the shell is clean', () => {
    expect(droppedAnthropicEnv(shell)).toEqual(['ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL', 'ANTHROPIC_VERTEX_BASE_URL']);
    expect(droppedAnthropicEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k' })).toEqual([]);
  });
});

describe('R23 sibling: jobs get no ANTHROPIC_* variable at all', () => {
  it('the job env is built from an allow-list, so none of the shell ANTHROPIC_* names reach it', () => {
    const env = buildJobEnv(shell);
    expect(Object.keys(env).filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
  });
});
