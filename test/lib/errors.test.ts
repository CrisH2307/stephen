/** src/lib/errors.ts: every *ConfigError extends ConfigError and keeps its own name and message. */
import { describe, expect, it } from 'vitest';
import { AccountsConfigError } from '../../src/accounts/config.js';
import { AppConfigError } from '../../src/app/config.js';
import { HistoryConfigError } from '../../src/history/config.js';
import { ConfigError } from '../../src/lib/errors.js';
import { MemoryConfigError } from '../../src/memory/config.js';
import { VoiceConfigError } from '../../src/voice/config.js';
import { TtsConfigError } from '../../src/voice/tts/config.js';

describe('ConfigError', () => {
  it('is the base of every config error; names and messages are unchanged', () => {
    const cases: [Error, string][] = [
      [new HistoryConfigError('h'), 'HistoryConfigError'],
      [new TtsConfigError('t'), 'TtsConfigError'],
      [new VoiceConfigError('v'), 'VoiceConfigError'],
      [new AppConfigError('a'), 'AppConfigError'],
      [new MemoryConfigError('m'), 'MemoryConfigError'],
      [new AccountsConfigError('c'), 'Error'], // never had a name of its own
    ];
    for (const [e, name] of cases) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(name);
    }
    expect(cases.map(([e]) => e.message)).toEqual(['h', 't', 'v', 'a', 'm', 'c']);
    expect(new HistoryConfigError('x')).not.toBeInstanceOf(VoiceConfigError);
  });
});
