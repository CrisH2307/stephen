/**
 * `announce {text}`: Stephen says a short line out loud BEFORE Claude starts something that plays sound
 * ("Playing Say So by Doja Cat"), and the tool returns only once the line has been spoken (or after ~8 s), so
 * the voice never talks over the music. Registered only when the server runs as `stephen serve --voice` (the
 * voice listener's MCP config passes it); a normal Claude Code session never gets this tool.
 *
 * Guards: ≤ 120 characters of plain text (control/format characters and markdown removed), at most
 * ANNOUNCE_MAX_PER_MINUTE calls per minute per server process (each voice command starts its own server, so
 * that is also a per-command cap), every call audited.
 */
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubConfig } from '../config.js';
import type { Hub } from '../server/hub.js';
import type { ServerDeps } from '../server/index.js';
import { NoticeError, okResult, toErrorResult } from '../server/util.js';
import { stripForSpeech, type Speaker } from './speech.js';
import { createTts, parseTtsConfig, type TtsSpeaker } from './tts/index.js';

export const ANNOUNCE_TOOL = 'announce';
export const ANNOUNCE_MAX_CHARS = 120;
export const ANNOUNCE_MAX_PER_MINUTE = 3;
export const ANNOUNCE_MAX_WAIT_MS = 8000;

export const ANNOUNCE_DESCRIPTION =
  "Say a short line out loud BEFORE doing something that will play sound (music, a video), e.g. 'Playing Say So by Doja Cat'. Don't use it for anything else. " +
  `Plain text, at most ${ANNOUNCE_MAX_CHARS} characters (about 12 words). Returns when the line has been spoken; then start the sound.`;

export interface AnnounceOptions {
  /** Default: createTts(voice config from config.json) — the same voice as the listener's replies. */
  speaker?: Speaker;
  now?: () => number;
  maxWaitMs?: number;
  log?: (line: string) => void;
}

/** `serve --voice` sets `voice` on the server deps; tests put fakes there. */
export type ServerDepsWithVoice = ServerDeps & { voice?: AnnounceOptions };

/** Control and invisible format characters (bidi overrides, zero-width…) become spaces; markdown is dropped. */
/**
 * Words that try to steer the human — approve a dialog, type a secret, trust a site — have no place in a
 * "Playing <title>" line. A prompt-injected model could otherwise use Stephen's own voice to talk the user past
 * the macOS confirmation dialog (review #4 finding 3). Matched on whole words, case-insensitively.
 */
export const ANNOUNCE_FORBIDDEN_RE =
  /\b(?:allow|allowed|approve|approved|confirm|confirmed|accept|click|press|tap|yes|ok|okay|permission|permissions|password|passcode|code|pin|verify|verification|dialog|grant|trust|safe|enter|type|log ?in|sign ?in|authori[sz]e)\b/i;

export function announcementRefusal(line: string): string | null {
  const m = ANNOUNCE_FORBIDDEN_RE.exec(line);
  return m ? `announce only says what is about to play (e.g. "Playing Say So by Doja Cat"); "${m[0]}" is not allowed in it. Nothing was said.` : null;
}

export function cleanAnnouncement(text: string): string {
  return stripForSpeech(text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' '), ANNOUNCE_MAX_CHARS);
}

export function registerAnnounceTool(mcp: McpServer, hub: Hub, names: string[], opts?: AnnounceOptions): void {
  const o = opts ?? (hub.deps as ServerDepsWithVoice).voice;
  if (!o) return;
  const now = o.now ?? Date.now;
  const maxWait = o.maxWaitMs ?? ANNOUNCE_MAX_WAIT_MS;
  const recent: number[] = [];
  let speaker: Speaker | null = o.speaker ?? null;
  const getSpeaker = (): Speaker => {
    if (!speaker) {
      // Throws TtsConfigError on a bad "voice" section — reported to Claude, nothing spoken.
      const cfg = parseTtsConfig((hub.cfg as Partial<HubConfig>).voice ?? {});
      speaker = createTts(cfg, { home: hub.cfg.home, ...(o.log ? { log: o.log } : {}) });
    }
    return speaker;
  };

  const inputSchema = {
    text: z.string().min(1).max(ANNOUNCE_MAX_CHARS).describe('The line to say, e.g. "Playing Say So by Doja Cat". Plain text, ≤ 12 words.'),
  };
  const handler = async ({ text }: { text: string }): Promise<CallToolResult> => {
    const line = cleanAnnouncement(text);
    if (!line) throw new NoticeError('Nothing to say: the text was empty after removing markup and control characters.');
    const refusal = announcementRefusal(line);
    if (refusal) {
      await hub.audit({ tool: ANNOUNCE_TOOL, args: { text: line }, outcome: 'denied', error: 'steering words' });
      throw new NoticeError(refusal);
    }
    const t = now();
    while (recent.length && t - recent[0]! >= 60_000) recent.shift();
    if (recent.length >= ANNOUNCE_MAX_PER_MINUTE) {
      await hub.audit({ tool: ANNOUNCE_TOOL, args: { text: line }, outcome: 'denied', error: 'rate limit' });
      throw new NoticeError(`announce is limited to ${ANNOUNCE_MAX_PER_MINUTE} lines a minute. Nothing was said; go ahead without announcing.`);
    }
    recent.push(t);
    let sp: Speaker;
    try {
      sp = getSpeaker();
    } catch (e) {
      await hub.audit({ tool: ANNOUNCE_TOOL, args: { text: line }, outcome: 'error', error: (e as Error).message });
      throw new NoticeError(`Could not speak: ${(e as Error).message}. Go ahead without announcing.`);
    }
    const h = sp.speak(line);
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      h.done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), maxWait);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) h.cancel();
    const provider = (sp as Partial<TtsSpeaker>).lastProvider ?? null;
    await hub.audit({ tool: ANNOUNCE_TOOL, args: { text: line, ...(provider && finished ? { voice: provider } : {}), ...(finished ? {} : { timedOut: true }) }, outcome: 'ok' });
    return okResult(finished ? `Said: "${line}". Go ahead.` : `Stopped speaking after ${Math.round(maxWait / 1000)} s. Go ahead.`);
  };

  const cb = (async (args: { text: string }) => {
    try {
      hub.safety(); // created lazily on the first call, once client capabilities are known
      return await handler(args);
    } catch (e) {
      return toErrorResult(e);
    }
  }) as unknown as ToolCallback<typeof inputSchema>;
  mcp.registerTool(
    ANNOUNCE_TOOL,
    {
      title: 'Say a line out loud',
      description: ANNOUNCE_DESCRIPTION,
      inputSchema,
      annotations: { title: 'Say a line out loud', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    cb,
  );
  names.push(ANNOUNCE_TOOL);
}
