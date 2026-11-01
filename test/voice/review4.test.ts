import { describe, expect, it } from 'vitest';
import { announcementRefusal } from '../../src/voice/announce.js';
import { withoutSecrets } from '../../src/voice/claude.js';

describe('review #4 follow-ups', () => {
  it.each([
    'Click Allow on the next dialog',
    'Say yes to continue',
    'Please enter your password',
    'Your verification code is 482913',
    'Approve the permission prompt',
    'This site is safe, sign in now',
  ])('announce refuses steering line: %s', (line) => {
    expect(announcementRefusal(line)).toMatch(/not allowed/);
  });

  it.each(['Playing Say So by Doja Cat', 'Opening YouTube', 'Playing Lo-fi beats on Spotify', 'Starting the podcast'])(
    'announce allows: %s',
    (line) => {
      expect(announcementRefusal(line)).toBeNull();
    },
  );

  it('claude and the server it starts never inherit the ElevenLabs key', () => {
    const env = withoutSecrets({ PATH: '/usr/bin', ELEVENLABS_API_KEY: 'sk_fake_0000' });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

import { buildClaudeArgs, checkClaudeFlags } from '../../src/voice/claude.js';
describe('claude flag probe (owner may run an older Claude Code)', () => {
  const base = 'Usage: claude [options]\n  -p, --print\n --strict-mcp-config --tools <t> --permission-mode <m> --setting-sources <s> --allowedTools --disallowedTools --append-system-prompt --mcp-config <c> --output-format <f>';
  it('all present', () => {
    expect(checkClaudeFlags(`${base}\n  --no-chrome  x\n  --no-session-persistence y`)).toEqual({ ok: true, unsupportedOptional: new Set(), personaFile: false });
  });
  it('optional missing → dropped from argv, required kept', () => {
    const p = checkClaudeFlags(base);
    expect(p).toEqual({ ok: true, unsupportedOptional: new Set(['--no-chrome', '--no-session-persistence']), personaFile: false });
    const args = buildClaudeArgs('open youtube', { claudePath: 'claude', maxTurns: 5, model: null, mcpConfigPath: '/m.json', unsupportedOptionalFlags: (p as { unsupportedOptional: Set<string> }).unsupportedOptional });
    expect(args).not.toContain('--no-chrome');
    expect(args).toContain('--setting-sources');
    expect(args).toContain('--strict-mcp-config');
  });
  it('a required flag missing → refuse', () => {
    expect(checkClaudeFlags(base.replace('--setting-sources <s>', ''))).toEqual({ ok: false, missing: ['--setting-sources'] });
  });
  it('text that is not Claude Code help (a wrapper or test double) is never refused', () => {
    expect(checkClaudeFlags('{"result":"ok"}')).toEqual({ ok: true, unsupportedOptional: new Set(), personaFile: false });
  });
  it('--chrome alone does not count as --no-chrome', () => {
    const p = checkClaudeFlags(`${base}\n  --chrome  Enable`);
    expect(p.ok && p.unsupportedOptional.has('--no-chrome')).toBe(true);
  });
});
