/**
 * ElevenLabs cloud voice: POST /v1/text-to-speech/{voiceId}?output_format=mp3_44100_128 → mp3 → afplay.
 * Only the reply text is sent. The key goes in the `xi-api-key` header and never into an error message.
 */
import type { SpeakHandle } from '../speech.js';
import { ELEVENLABS_BASE_URL } from './config.js';
import { playBuffer, TtsFailure, type PlayFn, type PlayHandle, type TtsProvider } from './player.js';
import { redactKey, scrubKey } from './redact.js';

export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
/** Refuse absurd responses (a 300-char reply is ~100–300 KB of mp3). */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export interface ElevenLabsOptions {
  key: string;
  voiceId: string;
  modelId: string;
  timeoutMs: number;
  play: PlayFn;
  /** Default https://api.elevenlabs.io (tests point it at a local fake server). */
  baseUrl?: string;
  fetch?: typeof fetch;
  tmpRoot?: string;
}

interface ErrorDetail {
  status: string;
  message: string;
}

async function errorDetail(res: Response, key: string): Promise<ErrorDetail> {
  let text = '';
  try {
    text = (await res.text()).slice(0, 2000);
  } catch {
    /* no body */
  }
  let status = '';
  let message = '';
  try {
    const j = JSON.parse(text) as { detail?: unknown };
    const d = j.detail;
    if (d && typeof d === 'object') {
      status = String((d as { status?: unknown; code?: unknown }).status ?? (d as { code?: unknown }).code ?? '');
      message = String((d as { message?: unknown }).message ?? '');
    } else if (typeof d === 'string') message = d;
  } catch {
    message = text;
  }
  const clean = (s: string) => scrubKey(s, key).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
  return { status: clean(status), message: clean(message) };
}

/** Map an ElevenLabs error response to a clear reason. */
export function httpFailure(httpStatus: number, d: ErrorDetail, voiceId: string, key = ''): TtsFailure {
  const why = d.message ? ` (${d.message})` : '';
  const s = d.status.toLowerCase();
  if (s === 'quota_exceeded' || (httpStatus < 500 && /quota|credits/i.test(d.message))) {
    return new TtsFailure('elevenlabs', 'no-credits', `ElevenLabs is out of credits (HTTP ${httpStatus})${why}`, true);
  }
  if (httpStatus === 402) {
    return new TtsFailure('elevenlabs', 'no-credits', `ElevenLabs needs a paid plan or more credits for this (HTTP 402)${why}`, true);
  }
  if (httpStatus === 401 || httpStatus === 403) {
    if (s === 'detected_unusual_activity') return new TtsFailure('elevenlabs', 'bad-key', `ElevenLabs refused the request: unusual activity on a free account (HTTP ${httpStatus})`, true);
    if (s === 'missing_permissions') return new TtsFailure('elevenlabs', 'bad-key', `the ElevenLabs API key lacks the text-to-speech permission (HTTP ${httpStatus})`, true);
    return new TtsFailure('elevenlabs', 'bad-key', `ElevenLabs rejected the API key ${redactKey(key)} (HTTP ${httpStatus}; run \`stephen voice-key set\`)`, true);
  }
  if (httpStatus === 404) {
    return new TtsFailure('elevenlabs', 'voice', `ElevenLabs voice "${voiceId}" was not found or isn't available on your plan (HTTP 404)${why}`, true);
  }
  if (httpStatus === 429) return new TtsFailure('elevenlabs', 'rate-limited', `ElevenLabs is busy or rate-limited (HTTP 429)${why}`, false);
  // Other 4xx: our request is wrong (e.g. an unknown voice.elevenlabs.modelId) — retrying won't help.
  return new TtsFailure('elevenlabs', 'http', `ElevenLabs error HTTP ${httpStatus}${why}`, httpStatus < 500);
}

export class ElevenLabsSpeaker implements TtsProvider {
  readonly name = 'elevenlabs' as const;
  constructor(private readonly o: ElevenLabsOptions) {}

  speak(text: string): SpeakHandle {
    const ac = new AbortController();
    const state: { cancelled: boolean; player: PlayHandle | null } = { cancelled: false, player: null };
    const done = this.run(text, ac, state);
    return {
      done,
      cancel: () => {
        state.cancelled = true;
        ac.abort();
        state.player?.cancel();
      },
    };
  }

  private async run(text: string, ac: AbortController, state: { cancelled: boolean; player: PlayHandle | null }): Promise<void> {
    const { key, voiceId, modelId, timeoutMs } = this.o;
    const base = (this.o.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, '');
    const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    let audio: Uint8Array;
    try {
      const res = await (this.o.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: modelId }),
        signal: ac.signal,
        redirect: 'error',
      });
      if (!res.ok) throw httpFailure(res.status, await errorDetail(res, key), voiceId, key);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_AUDIO_BYTES) throw new TtsFailure('elevenlabs', 'http', `ElevenLabs sent ${len} bytes of audio — refused`);
      audio = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (state.cancelled) return;
      if (e instanceof TtsFailure) throw e;
      if (timedOut) throw new TtsFailure('elevenlabs', 'timeout', `ElevenLabs did not answer within ${Math.round(timeoutMs / 100) / 10} s`);
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code ?? cause?.message ?? (e as Error).message;
      throw new TtsFailure('elevenlabs', 'network', `could not reach ElevenLabs (${scrubKey(String(why), key).slice(0, 120)})`);
    } finally {
      clearTimeout(timer);
    }
    if (state.cancelled) return;
    if (audio.byteLength === 0) throw new TtsFailure('elevenlabs', 'http', 'ElevenLabs returned no audio');
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new TtsFailure('elevenlabs', 'http', 'ElevenLabs sent too much audio — refused');
    await playBuffer(audio, 'mp3', 'elevenlabs', this.o.play, state, this.o.tmpRoot);
  }
}

// ───────────────────────────── doctor --network ─────────────────────────────

export interface AccountCheck {
  subscription?: { tier: string; used: number; limit: number; resetsAt: string | null } | { error: string };
  voice?: { name: string } | { error: string };
}

/** GET /v1/user/subscription and GET /v1/voices/{id} (doctor --network). Never throws; never echoes the key. */
export async function checkElevenLabsAccount(
  key: string,
  voiceId: string,
  opts: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<AccountCheck> {
  const base = (opts.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, '');
  const f = opts.fetch ?? fetch;
  const get = async (path: string): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; error: string }> => {
    try {
      const res = await f(`${base}${path}`, { headers: { 'xi-api-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000), redirect: 'error' });
      if (!res.ok) {
        const d = await errorDetail(res, key);
        if (res.status === 401 && d.status === 'missing_permissions') return { ok: false, error: 'the key may not read this (missing permission) — speech can still work' };
        return { ok: false, error: httpFailure(res.status, d, voiceId, key).message };
      }
      return { ok: true, json: (await res.json()) as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: `could not reach ElevenLabs (${scrubKey((e as Error).message, key).slice(0, 120)})` };
    }
  };
  const [sub, voice] = await Promise.all([get('/v1/user/subscription'), get(`/v1/voices/${encodeURIComponent(voiceId)}`)]);
  const out: AccountCheck = {};
  if (sub.ok) {
    const reset = Number(sub.json.next_character_count_reset_unix);
    out.subscription = {
      tier: String(sub.json.tier ?? 'unknown'),
      used: Number(sub.json.character_count ?? 0),
      limit: Number(sub.json.character_limit ?? 0),
      resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString().slice(0, 10) : null,
    };
  } else out.subscription = { error: sub.error };
  out.voice = voice.ok ? { name: String(voice.json.name ?? voiceId) } : { error: voice.error };
  return out;
}
