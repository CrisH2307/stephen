import type { ActionRequest, ConfirmOutcome, ConfirmPrompt, Confirmer, ElementInfo, ResolvedConfig } from '../../src/types.js';
import { compileLists, type PolicyState, type SafetySettings } from '../../src/safety/policy.js';

export function el(over: Partial<ElementInfo> = {}): ElementInfo {
  return {
    ref: 'z1:e1',
    role: 'textbox',
    name: '',
    tag: 'input',
    inputType: 'text',
    autocomplete: null,
    nameAttr: null,
    idAttr: null,
    placeholder: null,
    labelText: null,
    ariaLabel: null,
    text: null,
    href: null,
    isEditable: true,
    isDisabled: false,
    isSubmit: false,
    inForm: false,
    formAction: null,
    frameUrl: 'https://example.com/page',
    ...over,
  };
}

export function button(name: string, over: Partial<ElementInfo> = {}): ElementInfo {
  return el({ role: 'button', name, tag: 'button', inputType: null, isEditable: false, text: name, ...over });
}

export function req(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    kind: 'click',
    tool: 'click',
    browser: 'zen',
    tab: 'z1',
    pageUrl: 'https://example.com/page',
    intent: 'test intent',
    ...over,
  };
}

export function safetyCfg(over: Partial<SafetySettings> = {}): SafetySettings {
  return {
    confirm: 'auto',
    blockedDomains: [],
    sensitiveDomains: [],
    allowEvaluate: false,
    maxActionsPerMinute: 40,
    confirmCrossSiteTyping: true,
    confirmTimeoutSec: 120,
    ...over,
  };
}

export function state(over: Partial<PolicyState> & { safety?: SafetySettings } = {}): PolicyState {
  const safety = over.safety ?? safetyCfg();
  return {
    safety,
    lists: over.lists ?? compileLists(safety),
    now: over.now ?? 1_000_000_000,
    mutationTimes: over.mutationTimes ?? [],
    privateReads: over.privateReads ?? [],
    trustedHosts: over.trustedHosts ?? [],
  };
}

export function resolvedConfig(home: string, safety: Partial<SafetySettings> = {}): ResolvedConfig {
  return {
    home,
    defaultBrowser: 'zen',
    chrome: { mode: 'agent', executablePath: '/x/chrome', userDataDir: `${home}/ud`, agentProfileDir: `${home}/p/c`, extraArgs: [] },
    zen: {
      mode: 'agent',
      executablePath: '/x/zen',
      profilePath: null,
      zenAppSupportDir: `${home}/zen`,
      agentProfileDir: `${home}/p/z`,
      extraArgs: [],
    },
    safety: safetyCfg(safety),
    output: { maxSnapshotChars: 20000, maxTextChars: 20000, saveDir: `${home}/out` },
    auditLogPath: `${home}/audit.log`,
    stateDir: `${home}/state`,
  };
}

/** Confirmer that records prompts and answers from a fixed script. */
export class FakeConfirmer implements Confirmer {
  readonly kind: string;
  readonly prompts: ConfirmPrompt[] = [];
  constructor(
    private readonly answer: ConfirmOutcome | (() => Promise<ConfirmOutcome>),
    kind = 'fake',
  ) {
    this.kind = kind;
  }
  async confirm(prompt: ConfirmPrompt): Promise<ConfirmOutcome> {
    this.prompts.push(prompt);
    return typeof this.answer === 'function' ? this.answer() : this.answer;
  }
}
