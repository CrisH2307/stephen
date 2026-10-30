/**
 * Who may choose a browser's profile mode.
 *
 * The real profile holds the user's logins, so the model (which may be prompt-injected by a web
 * page) must never be able to escalate to it. Rules for browser_connect:
 *   - the model may connect in the mode configured in ~/.browser-hub/config.json, or downgrade to 'agent';
 *   - asking for 'real' when the config says 'agent' is refused — only the user can change the config;
 *   - even when the config allows 'real', SWITCHING a connected browser from 'agent' to 'real' through
 *     the tool needs the human's approval (a plain connect in the configured mode does not — that is
 *     exactly what other tools do lazily);
 *   - attach-only Zen (`zen.launch: "never"`): only the configured mode — a "downgrade" to agent would
 *     start a separate Zen window, which attach-only never does.
 */
import { ZEN_ATTACH_ONLY_LABEL } from '../drivers/zen.js';
import type { BrowserName, BrowserStatus, ProfileMode } from '../types.js';

export type ConnectDecision =
  | { verdict: 'connect'; mode: ProfileMode; confirm: false }
  | { verdict: 'confirm'; mode: 'real'; confirm: true; from: ProfileMode }
  | { verdict: 'refuse'; message: string };

const NICE: Record<BrowserName, string> = { chrome: 'Chrome', zen: 'Zen' };

export function decideConnect(
  browser: BrowserName,
  configured: ProfileMode,
  requested: ProfileMode | undefined,
  current: Pick<BrowserStatus, 'connected' | 'mode'>,
  opts: { attachOnly?: boolean } = {},
): ConnectDecision {
  const mode = requested ?? configured;
  if (opts.attachOnly && mode !== configured) {
    return {
      verdict: 'refuse',
      message:
        `Refused: ${NICE[browser]} is ${ZEN_ATTACH_ONLY_LABEL}. browser-hub only uses the ${NICE[browser]} the user opened for Claude ` +
        `(the configured ${configured} profile) and never starts a separate ${NICE[browser]} window. Connect without "mode" and work in the ` +
        `user's ${NICE[browser]} (tab_open opens a new tab there), or use Chrome. Do not edit ~/.browser-hub/config.json yourself.`,
    };
  }
  if (mode === 'agent') return { verdict: 'connect', mode, confirm: false };
  if (configured !== 'real') {
    return {
      verdict: 'refuse',
      message:
        `Refused: ${browser} is configured to use the separate browser-hub (agent) profile, and browser-hub never switches to ` +
        `the user's real ${NICE[browser]} profile on Claude's request. Tell the user: if they want Claude to use their everyday ` +
        `${NICE[browser]} profile, they can set "${browser}": {"mode": "real"} in ~/.browser-hub/config.json themselves and restart Claude Code. ` +
        `Do not edit that file yourself.`,
    };
  }
  if (current.connected && current.mode !== null && current.mode !== 'real') {
    return { verdict: 'confirm', mode: 'real', confirm: true, from: current.mode };
  }
  return { verdict: 'connect', mode: 'real', confirm: false };
}

export function switchPrompt(browser: BrowserName, from: ProfileMode, intent: string | undefined): { title: string; body: string } {
  const what =
    browser === 'zen'
      ? 'Zen will be relaunched on your everyday profile with remote control enabled (Zen must be quit first).'
      : 'browser-hub will attach to your everyday Chrome (Chrome may ask you to click Allow).';
  return {
    title: `Claude wants to switch ${NICE[browser]} from the ${from} profile to your REAL profile`,
    body: [
      `Your real ${NICE[browser]} profile has your logins, cookies and history. ${what}`,
      'Only allow this if you asked Claude to work in your everyday browser.',
      ...(intent ? [`Claude says: ${intent.replace(/\s+/g, ' ').slice(0, 300)}`] : []),
    ].join('\n'),
  };
}
