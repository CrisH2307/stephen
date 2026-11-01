// Regression: the probe must accept the real `claude --help` of 2.1.316 (captured fixture), which does NOT list --max-turns.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { checkClaudeFlags } from '../../src/voice/claude.js';
it('accepts the real Claude Code 2.1.316 help text', () => {
  const r = checkClaudeFlags(readFileSync(new URL('./fixtures/claude-help-2.1.316.txt', import.meta.url), 'utf8'));
  // It lists --append-system-prompt-file only inside the --bare line, as `--append-system-prompt[-file]`.
  expect(r).toEqual({ ok: true, unsupportedOptional: new Set(), personaFile: true });
});
