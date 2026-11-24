// Safety layer entry point — owned by worktree wt-safety. Export signatures are a frozen contract.
import type { ConfirmPrompt, Confirmer, IAuditLog, ISafetyGate, ResolvedConfig } from '../types.js';
import { AuditLog } from './audit.js';
import { buildConfirmer, redactValue as redact } from './confirm.js';
import { SafetyGate } from './gate.js';
import type { LandingVerdict } from './policy.js';

export type ElicitFn = (prompt: ConfirmPrompt) => Promise<'accept' | 'decline' | 'cancel'>;

export interface SafetyDeps {
  /** Present when the MCP client advertised the elicitation capability. */
  elicit?: ElicitFn;
  /** Override the confirmer entirely (tests). */
  confirmer?: Confirmer;
  /** Defaults to process.platform; 'darwin' enables the osascript dialog. */
  platform?: NodeJS.Platform;
  /** Clock for rate limiting (tests). */
  now?: () => number;
  /** `serve --trust wake`: written on the private-read audit lines (absent = trusted). */
  trust?: 'wake';
  /**
   * `serve --command-file`: the listener's command id, asked by the audit log for each entry it writes (`cmd`).
   * A label only. It goes to the audit log and nowhere else: the gate is built without it.
   */
  commandId?: () => string | undefined;
}

export function createSafety(cfg: ResolvedConfig, deps?: SafetyDeps): { gate: ISafetyGate; audit: IAuditLog } {
  const audit = new AuditLog({ path: cfg.auditLogPath, ...(deps?.commandId ? { commandId: deps.commandId } : {}) });
  const confirmer =
    deps?.confirmer ?? buildConfirmer(cfg.safety, { elicit: deps?.elicit, platform: deps?.platform, home: cfg.home });
  const gate = new SafetyGate({ safety: cfg.safety, confirmer, audit, now: deps?.now, ...(deps?.trust ? { trust: deps.trust } : {}) });
  return { gate, audit };
}

export type { LandingVerdict };

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// '<' + optional whitespace/zero-width + optional '/' + … + 'untrusted_web_content', any case.
const DELIMITER_RE = /<([\s\u200b-\u200d\u2060\ufeff]*\/?[\s\u200b-\u200d\u2060\ufeff]*untrusted_web_content)/gi;

/**
 * Wrap page-derived text so the model treats it as data:
 * <untrusted_web_content source="z1" origin="https://example.com">…</untrusted_web_content>
 * Any occurrence of "</untrusted_web_content" (or an opening tag) inside `text` is neutralized as "&lt;…".
 */
export function wrapUntrusted(source: string, url: string, text: string): string {
  let origin = 'unknown';
  try {
    const u = new URL(url);
    origin = u.origin !== 'null' ? u.origin : u.protocol === 'about:' ? u.href.split(/[?#]/)[0] ?? u.protocol : u.protocol;
  } catch {
    /* unknown */
  }
  const safe = text.replace(DELIMITER_RE, '&lt;$1');
  return `<untrusted_web_content source="${escapeAttr(source)}" origin="${escapeAttr(origin)}">\n${safe}\n</untrusted_web_content>`;
}

/** Redact a typed value for logs/prompts: '[23 chars] "Hello Mar…"' — secrets become '[redacted, 12 chars]'. */
export function redactValue(value: string, secret: boolean): string {
  return redact(value, secret);
}

/** Log-safe URL: origin + capped path, query → '?…', fragment → '#…' (for server-side audit args / recent_actions). */
export { redactUrl, digest } from './text.js';
