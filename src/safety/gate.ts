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
    this.privateReads.delete(r.scope); // re-insert so Map order = least recently read first
    this.privateReads.set(r.scope, r);
    while (this.privateReads.size > MAX_PRIVATE_SCOPES) {
      const oldest = this.privateReads.keys().next().value;
      if (oldest === undefined) break;
      this.privateReads.delete(oldest);
    }
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
