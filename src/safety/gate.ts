/**
 * SafetyGate: evaluate policy → (maybe) ask a human → GateResult + audit entry.
 * Holds the only mutable session state the policy needs: allowed-action timestamps (rate limit), the
 * private scopes read this session (cross-site taint, see egress.ts) and the hosts the user allowed Claude
 * to interact with after that (first-interaction rule). None of it expires while the server runs: a
 * prompt-injected model can simply wait out any window.
 */
import type {
  ActionRequest,
  AuditEntry,
  Confirmer,
  ElementInfo,
  GateResult,
  IAuditLog,
  ISafetyGate,
  PolicyDecision,
  ResolvedConfig,
} from '../types.js';
import { countsTowardRateLimit, isSecretField } from './classify.js';
import { buildPrompt, describeAction, type PromptContext, redactValue } from './confirm.js';
import { normalizeHost } from './domains.js';
import { describeSources, taintScope } from './egress.js';
import {
  compileLists,
  evaluate,
  isPrivateUrl,
  landingVerdict,
  type LandingVerdict,
  type PolicyLists,
  type PrivateRead,
  privateReadOf,
  RATE_WINDOW_MS,
  untrustedDestinationHosts,
  untrustedInteractionHosts,
} from './policy.js';
import { clean, digest, redactUrl } from './text.js';

/** Distinct private scopes remembered per session; the oldest is dropped beyond this (others keep the taint armed). */
export const MAX_PRIVATE_SCOPES = 256;
/** Hosts the user approved for interaction after a private read; the oldest approval is dropped beyond this (it asks again). */
export const MAX_TRUSTED_HOSTS = 256;

/**
 * The part of the gate's memory that must live exactly as long as Claude's memory of the conversation
 * (`serve --session-state`, see src/safety/session-state.ts): the private reads (cross-site taint) and the hosts
 * the user approved after them. Both lists are oldest first. The rate limiter is NOT part of it.
 */
export interface GateState {
  version: 1;
  privateReads: PrivateRead[];
  trustedHosts: string[];
}

export const GATE_STATE_VERSION = 1;
/** Imported timestamps may be at most this far in the future (clock adjustments), never more. */
export const GATE_STATE_MAX_SKEW_MS = 5 * 60_000;
/** A canonical host name, exactly as the policy stores it (lower case, WHATWG-normalized, no port). */
const isHost = (h: unknown): h is string => typeof h === 'string' && h.length > 0 && h.length <= 255 && normalizeHost(h) === h;
const MAX_SCOPE_LEN = 2048;

/**
 * Check an imported gate state: exact shape (no unknown keys), the caps, hosts that look like hosts, scopes that
 * belong to their host, unique entries and sane timestamps (positive, not in the future). Pure.
 */
export function validateGateState(raw: unknown, now: number): GateState | { error: string } {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(raw)) return { error: 'not an object' };
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'privateReads,trustedHosts,version') return { error: `unexpected keys (${keys.slice(0, 100)})` };
  if (raw.version !== GATE_STATE_VERSION) return { error: 'unknown version' };
  const reads = raw.privateReads;
  const hosts = raw.trustedHosts;
  if (!Array.isArray(reads) || !Array.isArray(hosts)) return { error: 'privateReads and trustedHosts must be lists' };
  if (reads.length > MAX_PRIVATE_SCOPES) return { error: `more than ${MAX_PRIVATE_SCOPES} private reads` };
  if (hosts.length > MAX_TRUSTED_HOSTS) return { error: `more than ${MAX_TRUSTED_HOSTS} trusted hosts` };
  const out: GateState = { version: 1, privateReads: [], trustedHosts: [] };
  const scopes = new Set<string>();
  for (const r of reads) {
    if (!isObj(r) || Object.keys(r).sort().join(',') !== 'at,host,scope') return { error: 'a private read has the wrong shape' };
    const { host, scope, at } = r;
    if (!isHost(host)) return { error: 'a private read has a bad host' };
    if (typeof scope !== 'string' || scope.length > MAX_SCOPE_LEN || /[\s\u0000-\u001f\u007f]/.test(scope)) return { error: 'a private read has a bad scope' };
    if (scope !== host && !scope.startsWith(`${host}/`)) return { error: 'a private read scope does not belong to its host' };
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 || at > now + GATE_STATE_MAX_SKEW_MS) return { error: 'a private read has a bad timestamp' };
    if (scopes.has(scope)) return { error: 'duplicate private read scope' };
    scopes.add(scope);
    out.privateReads.push({ host, scope, at });
  }
  const seen = new Set<string>();
  for (const h of hosts) {
    if (!isHost(h)) return { error: 'a trusted host is not a host name' };
    if (seen.has(h)) return { error: 'duplicate trusted host' };
    seen.add(h);
    out.trustedHosts.push(h);
  }
  return out;
}

export interface SafetyGateOptions {
  safety: ResolvedConfig['safety'];
  confirmer: Confirmer;
  audit: IAuditLog;
  now?: () => number;
  /** Where audit-write failures are reported (never stdout: that is the MCP channel). */
  onAuditError?: (e: unknown) => void;
}

/** 'button "Send"' — role + accessible name, never values. */
export function elementSummary(el: ElementInfo): string {
  const name = clean(el.name || el.text || el.ariaLabel, 80);
  return `${clean(el.role, 30) || el.tag}${name ? ` "${name}"` : ''}`;
}

/**
 * Args for the audit log: URLs without query/fragment, typed text only as length + short preview
 * (secrets fully redacted), evaluate code and prompt() text only as length + hash.
 */
export function redactedArgs(req: ActionRequest): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const secret = req.element ? isSecretField(req.element) : false;
  if (req.targetUrl) args.url = redactUrl(req.targetUrl);
  if (req.text !== undefined) {
    if (req.kind === 'evaluate') args.expression = digest(req.text);
    else if (req.kind === 'dialog') args.prompt_text = digest(req.text);
    else args.text = redactValue(req.text, secret);
  }
  if (req.key) args.key = clean(req.key, 50);
  if (req.focus) args.focus = req.focus;
  if (req.files) args.files = [...req.files];
  if (req.dialog) args.dialog = { type: req.dialog.type, accept: req.dialog.accept };
  return args;
}

export class SafetyGate implements ISafetyGate {
  private readonly safety: ResolvedConfig['safety'];
  private readonly lists: PolicyLists;
  private readonly confirmer: Confirmer;
  private readonly audit: IAuditLog;
  private readonly now: () => number;
  private readonly onAuditError: (e: unknown) => void;
  private mutationTimes: number[] = [];
  private readonly privateReads = new Map<string, PrivateRead>();
  private readonly trustedHosts = new Set<string>();
  /** Called synchronously after the private reads or trusted hosts changed (session-state persistence). */
  private stateListener: ((state: GateState) => void) | null = null;

  constructor(opts: SafetyGateOptions) {
    this.safety = opts.safety;
    this.lists = compileLists(opts.safety);
    this.confirmer = opts.confirmer;
    this.audit = opts.audit;
    this.now = opts.now ?? Date.now;
    this.onAuditError =
      opts.onAuditError ??
      ((e) => {
        process.stderr.write(`stephen: audit log write failed: ${e instanceof Error ? e.message : String(e)}\n`);
      });
  }

  evaluate(req: ActionRequest): PolicyDecision {
    const now = this.now();
    this.prune(now);
    return evaluate(req, {
      safety: this.safety,
      lists: this.lists,
      now,
      mutationTimes: this.mutationTimes,
      privateReads: [...this.privateReads.values()],
      trustedHosts: [...this.trustedHosts],
    });
  }

  isPrivate(url: string): boolean {
    return isPrivateUrl(url, this.lists);
  }

  /**
   * True when `url`'s taint scope (host, or document on collaborative hosts) is among the private reads of this
   * session. Non-private URLs are never recorded, so they return false (callers check isPrivate first).
   */
  wasRead(url: string): boolean {
    const scope = taintScope(url);
    return scope !== '' && this.privateReads.has(scope);
  }

  /** Where an action landed: 'blocked' | 'sensitive' | 'ok' (review #2 finding 12). Same lists as the gate. */
  landing(url: string): LandingVerdict {
    return landingVerdict(url, this.lists);
  }

  /** Hosts the user approved for interaction after a private read (for status/debugging). */
  approvedHosts(): string[] {
    return [...this.trustedHosts];
  }

  isSecretField(el: ElementInfo): boolean {
    return isSecretField(el);
  }

  noteRead(url: string): void {
    const r = privateReadOf(url, this.lists, this.now());
    if (!r) return;
    const known = this.privateReads.has(r.scope);
    this.privateReads.delete(r.scope); // re-insert so Map order = least recently read first
    this.privateReads.set(r.scope, r);
    while (this.privateReads.size > MAX_PRIVATE_SCOPES) {
      const oldest = this.privateReads.keys().next().value;
      if (oldest === undefined) break;
      this.privateReads.delete(oldest);
    }
    // A new scope must be on disk BEFORE the caller hands the page text to the model (the listener throws if it
    // can't be). A re-read of a known scope changes nothing the policy looks at, so it isn't written again.
    if (!known) this.stateChanged();
  }

  /** The private reads and trusted hosts, oldest first (see GateState). */
  exportState(): GateState {
    return {
      version: 1,
      privateReads: [...this.privateReads.values()].map((r) => ({ host: r.host, scope: r.scope, at: r.at })),
      trustedHosts: [...this.trustedHosts],
    };
  }

  /**
   * Add a saved state (validated with validateGateState; nothing changes when it is invalid). Imported entries
   * count as older than this gate's own; the caps still apply. Never removes taint or approvals already held.
   */
  importState(raw: unknown): { ok: true } | { ok: false; error: string } {
    const v = validateGateState(raw, this.now());
    if ('error' in v) return { ok: false, error: v.error };
    const ownReads = [...this.privateReads.values()];
    const ownHosts = [...this.trustedHosts];
    this.privateReads.clear();
    this.trustedHosts.clear();
    for (const r of [...v.privateReads.filter((x) => !ownReads.some((o) => o.scope === x.scope)), ...ownReads]) this.privateReads.set(r.scope, r);
    for (const h of [...v.trustedHosts.filter((x) => !ownHosts.includes(x)), ...ownHosts]) this.trustedHosts.add(h);
    while (this.privateReads.size > MAX_PRIVATE_SCOPES) this.privateReads.delete(this.privateReads.keys().next().value!);
    while (this.trustedHosts.size > MAX_TRUSTED_HOSTS) this.trustedHosts.delete(this.trustedHosts.values().next().value!);
    return { ok: true };
  }

  /**
   * Called synchronously with the new state after every change to the private reads or trusted hosts. If it
   * throws, the error propagates out of noteRead / check (fail closed: the read or action does not complete).
   */
  onStateChange(fn: ((state: GateState) => void) | null): void {
    this.stateListener = fn;
  }

  private stateChanged(): void {
    this.stateListener?.(this.exportState());
  }

  /** Hosts whose private content was read this session (for status/debugging). */
  taintedHosts(): string[] {
    return [...new Set([...this.privateReads.values()].map((r) => r.host))];
  }

  async check(req: ActionRequest): Promise<GateResult> {
    const decision = this.evaluate(req);
    let confirmation: GateResult['confirmation'] = 'not-needed';
    let allowed = decision.verdict === 'allow';
    let message = '';
    const what = describeAction(req);

    let trustHosts: string[] = [];
    if (decision.verdict === 'deny') {
      message = `Blocked by Stephen's safety policy — did not ${what}. ${decision.reason}`;
    } else if (decision.verdict === 'confirm') {
      const ctx: PromptContext = {};
      if (decision.rules.includes('first-interaction') || decision.rules.includes('first-destination')) {
        const reads = [...this.privateReads.values()];
        const trusted = [...this.trustedHosts];
        trustHosts = [
          ...new Set([
            ...(decision.rules.includes('first-interaction') ? untrustedInteractionHosts(req, reads, trusted) : []),
            ...(decision.rules.includes('first-destination') ? untrustedDestinationHosts(req, reads, trusted, this.lists.openEndpoints) : []),
          ]),
        ];
        ctx.trustHosts = trustHosts;
        ctx.readSources = describeSources(reads);
      }
      const prompt = buildPrompt(req, decision, ctx);
      try {
        confirmation = await this.confirmer.confirm(prompt);
      } catch {
        confirmation = 'unavailable';
      }
      allowed = confirmation === 'approved';
      if (confirmation === 'declined') {
        message =
          this.confirmer.kind === 'deny'
            ? `Not performed: "${what}" needs the user's confirmation (${decision.reason}) and Stephen is configured to decline such actions automatically (safety.confirm = "deny"). Ask the user to do this step themselves.`
            : `The user declined: did not ${what}. Do not retry this action; ask the user how they want to proceed.`;
      } else if (confirmation === 'unavailable') {
        message =
          `Not performed: "${what}" needs the user's confirmation (${decision.reason}), but no confirmation channel is available, so it was denied. ` +
          'To enable confirmations, use an MCP client that supports elicitation, or run Stephen on macOS with "safety": {"confirm": "auto"} or "dialog" in ~/.stephen/config.json. Until then, ask the user to do this step themselves.';
      }
    }

    if (allowed && trustHosts.length > 0) {
      for (const h of trustHosts) {
        this.trustedHosts.delete(h);
        this.trustedHosts.add(h);
      }
      while (this.trustedHosts.size > MAX_TRUSTED_HOSTS) {
        const oldest = this.trustedHosts.values().next().value;
        if (oldest === undefined) break;
        this.trustedHosts.delete(oldest);
      }
      this.stateChanged();
    }
    if (allowed && countsTowardRateLimit(req.kind)) this.mutationTimes.push(this.now());
    if (allowed && req.kind === 'read') this.noteRead(req.pageUrl);

    if (req.kind !== 'read') {
      const entry: Omit<AuditEntry, 'ts'> = {
        tool: req.tool,
        browser: req.browser,
        tab: req.tab,
        kind: req.kind,
        urlBefore: redactUrl(req.pageUrl),
        risk: decision.risk,
        verdict: decision.verdict,
        confirmation,
        outcome: allowed ? 'ok' : 'denied',
        intent: clean(req.intent, 200),
        args: { ...redactedArgs(req), rules: decision.rules, ...(allowed && trustHosts.length > 0 ? { trustedHosts: trustHosts } : {}) },
      };
      if (req.element) entry.element = elementSummary(req.element);
      if (!allowed) entry.error = message;
      try {
        await this.audit.append(entry);
      } catch (e) {
        this.onAuditError(e);
      }
    }

    return { allowed, decision, confirmation, message };
  }

  private prune(now: number): void {
    this.mutationTimes = this.mutationTimes.filter((t) => now - t < RATE_WINDOW_MS);
  }
}
