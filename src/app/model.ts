/**
 * model.set: the Stephen window's Settings > Model. The Claude model name and effort live in config.json's "voice"
 * section (claudeModel, claudeEffort) like the other settings, and are read at the start of each Claude session, so a
 * change applies from the next command (the server ends the warm conversation so that is the very next one).
 * Only a model alias or name (the same pattern config.json uses) and one of the fixed effort levels are accepted.
 */
import { updateConfigSection } from '../config-write.js';
import { CLAUDE_MODEL_RE, EFFORTS, resolveClaudeModel, type Effort } from '../voice/config.js';

export interface ModelPrefs {
  /** `--model` value; null = no flag ("default"). */
  model: string | null;
  /** `--effort` value; null = no flag. */
  effort: Effort | null;
}

export interface ModelChanges {
  /** Alias or name as typed ("haiku", "sonnet", "default", a full name). */
  model?: string;
  /** A level, or "default" to clear it. */
  effort?: Effort | 'default';
}

export type ModelCheck = { ok: true; changes: ModelChanges } | { ok: false; message: string };

export function checkModelChange(v: { model?: unknown; effort?: unknown }): ModelCheck {
  const changes: ModelChanges = {};
  if (v.model !== undefined && v.model !== null) {
    if (typeof v.model !== 'string' || !CLAUDE_MODEL_RE.test(v.model.trim())) return { ok: false, message: 'model must be a model alias or name like "haiku"' };
    changes.model = v.model.trim();
  }
  if (v.effort !== undefined && v.effort !== null) {
    if (v.effort !== 'default' && !(EFFORTS as readonly unknown[]).includes(v.effort)) return { ok: false, message: `effort must be default or one of ${EFFORTS.join(', ')}` };
    changes.effort = v.effort as Effort | 'default';
  }
  if (changes.model === undefined && changes.effort === undefined) return { ok: false, message: 'give a model or an effort' };
  return { ok: true, changes };
}

export class ModelStore {
  private state: ModelPrefs;
  constructor(
    private readonly file: string,
    initial: ModelPrefs,
  ) {
    this.state = { ...initial };
  }

  get(): ModelPrefs {
    return { ...this.state };
  }

  /** Written to config.json first, then applied. Throws if the file can't be written. */
  set(c: ModelChanges): ModelPrefs {
    const next = { ...this.state };
    if (c.model !== undefined) next.model = resolveClaudeModel(c.model);
    if (c.effort !== undefined) next.effort = c.effort === 'default' ? null : c.effort;
    updateConfigSection(this.file, 'voice', (old) => ({
      ...old,
      ...(c.model !== undefined ? { claudeModel: c.model } : {}),
      ...(c.effort !== undefined ? { claudeEffort: c.effort === 'default' ? null : c.effort } : {}),
    }));
    this.state = next;
    return this.get();
  }
}
