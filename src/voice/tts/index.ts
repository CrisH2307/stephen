/**
 * Voice output. createTts(cfg, deps) returns a Speaker that speaks with the configured provider and falls back
 * down the chain elevenlabs → kokoro → say:
 *   - before speaking: a provider that is unavailable (no API key, Kokoro model not installed) is skipped;
 *   - while speaking: if a provider fails (bad key, out of credits, voice not on the plan, network, timeout,
 *     player missing), the SAME text is spoken with the next one, and the reason is logged once per session.
 *     Failures that won't fix themselves (bad key, no credits, missing voice) disable that provider for the
 *     rest of the session; network errors and timeouts are retried on the next reply.
 * Text is markdown-stripped and capped (stripForSpeech) before it reaches any provider.
 */
import { join } from 'node:path';
import { stripForSpeech, type SpeakHandle, type Speaker } from '../speech.js';
import type { TtsConfig } from './config.js';
import { kokoroSpeakerId } from './config.js';
import { ElevenLabsSpeaker } from './elevenlabs.js';
import { findApiKey, type FoundKey, type KeyDeps, type KeyLookup } from './keys.js';
import { isKokoroInstalled, KokoroSpeaker, type KokoroEngineFactory } from './kokoro.js';
import { afplayPlayer, TtsFailure, type PlayFn, type TtsProvider } from './player.js';
import { redactKey } from './redact.js';
import { SayProvider } from './say.js';
import type { TtsProviderName } from './types.js';

export type { TtsProviderName } from './types.js';
export type { SpeakHandle, Speaker } from '../speech.js';
export { parseTtsConfig, TtsConfigError, TTS_CONFIG_SHAPE, type TtsConfig } from './config.js';
export { findApiKey } from './keys.js';
export { ensureKokoro, isKokoroInstalled, KOKORO_MODEL } from './kokoro.js';
export { redactKey } from './redact.js';

export const TTS_CHAIN: readonly TtsProviderName[] = ['elevenlabs', 'kokoro', 'say'];

export const PROVIDER_LABEL: Record<TtsProviderName, string> = {
  elevenlabs: 'ElevenLabs',
  kokoro: 'the local Kokoro voice',
  say: 'macOS say',
};

export interface TtsDeps {
  /** Stephen home; the Kokoro model lives in <home>/models. */
  home: string;
  /** Override the models folder (default <home>/models). */
  modelsRoot?: string;
  /** One line per notable event (fallbacks), at most once per reason per session. Default: stderr. */
  log?: (line: string) => void;
  /** Key lookup environment (exec for `security`, env, user…), or a replacement lookup. */
  keys?: KeyDeps;
  findKey?: () => Promise<KeyLookup>;
  /** ElevenLabs API base URL (tests point it at a local fake). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Audio player (default `afplay`). */
  play?: PlayFn;
  /** `say` binary (default "say"). */
  sayCommand?: string;
  kokoroEngine?: KokoroEngineFactory;
  /** Where the private temp audio folders go (default os.tmpdir()). */
  tmpRoot?: string;
}

export interface TtsPlan {
  /** Providers that will be tried, in order. */
  providers: TtsProviderName[];
  /** Where the ElevenLabs key was found (never the key itself). */
  key: { source: FoundKey['source']; where: string; redacted: string } | null;
  kokoroInstalled: boolean;
  /** Why a provider was skipped, and key-lookup notes. */
  notes: string[];
}

export interface TtsSpeaker extends Speaker {
  /** Resolves the provider order (key lookup, model check) — done once, then cached. */
  plan(): Promise<TtsPlan>;
  /** Look up the key and load the local model now, so the first reply isn't slower. Never rejects. */
  warm(): Promise<void>;
  /** The provider that spoke the last finished reply (null before the first one). */
  readonly lastProvider: TtsProviderName | null;
}

/** Build the voice-output Speaker (see the file header). Cheap: nothing runs until the first speak()/plan(). */
export function createTts(cfg: TtsConfig, deps: TtsDeps): TtsSpeaker {
  const log = deps.log ?? ((l: string) => process.stderr.write(`[stephen] ${l}\n`));
  const play = deps.play ?? afplayPlayer();
  const modelsRoot = deps.modelsRoot ?? join(deps.home, 'models');
  const logged = new Set<string>();
  const logOnce = (k: string, line: string) => {
    if (logged.has(k)) return;
    logged.add(k);
    log(line);
  };
  const dead = new Set<TtsProviderName>();
  const providers = new Map<TtsProviderName, TtsProvider>();
  let planP: Promise<{ plan: TtsPlan; key: string | null }> | null = null;
  let last: TtsProviderName | null = null;

  const resolvePlan = async (): Promise<{ plan: TtsPlan; key: string | null }> => {
    const notes: string[] = [];
    let lookup: KeyLookup;
    try {
      lookup = await (deps.findKey ?? (() => findApiKey(cfg, { home: deps.home, ...deps.keys })))();
    } catch (e) {
      lookup = { found: null, notes: [`key lookup failed: ${(e as Error).message}`] };
    }
    notes.push(...lookup.notes);
    const kokoroInstalled = await isKokoroInstalled(modelsRoot).catch(() => false);
    const available: Record<TtsProviderName, boolean> = { elevenlabs: !!lookup.found, kokoro: kokoroInstalled, say: true };
    const why: Record<TtsProviderName, string> = {
      elevenlabs: 'no ElevenLabs API key was found (run `stephen voice-key set`)',
      kokoro: 'the Kokoro model is not installed (run `stephen voice-setup --tts kokoro`)',
      say: '',
    };
    const start = cfg.tts === 'auto' ? 0 : TTS_CHAIN.indexOf(cfg.tts);
    const order = TTS_CHAIN.slice(start).filter((p) => {
      if (!available[p]) notes.push(`${PROVIDER_LABEL[p]} skipped: ${why[p]}`);
      return available[p];
    });
    if (cfg.tts !== 'auto' && !available[cfg.tts]) {
      logOnce(`unavailable:${cfg.tts}`, `Voice output: voice.tts is "${cfg.tts}" but ${why[cfg.tts]} — using ${PROVIDER_LABEL[order[0]!]}.`);
    }
    for (const n of lookup.notes) logOnce(`note:${n}`, `Voice output: ${n}`);
    const f = lookup.found;
    return {
      plan: { providers: order, key: f ? { source: f.source, where: f.where, redacted: redactKey(f.key) } : null, kokoroInstalled, notes },
      key: f?.key ?? null,
    };
  };
  const getPlan = () => (planP ??= resolvePlan());

  const provider = (name: TtsProviderName, key: string | null): TtsProvider => {
    let p = providers.get(name);
    if (!p) {
      if (name === 'elevenlabs') {
        p = new ElevenLabsSpeaker({
          key: key!,
          voiceId: cfg.elevenlabs.voiceId,
          modelId: cfg.elevenlabs.modelId,
          timeoutMs: cfg.elevenlabs.timeoutSec * 1000,
          play,
          ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
        });
      } else if (name === 'kokoro') {
        p = new KokoroSpeaker({
          modelsRoot,
          sid: kokoroSpeakerId(cfg.kokoro.speaker),
          speed: cfg.kokoro.speed,
          play,
          ...(deps.kokoroEngine ? { engine: deps.kokoroEngine } : {}),
          ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
        });
      } else p = new SayProvider(cfg.voice, cfg.rate, deps.sayCommand);
      providers.set(name, p);
    }
    return p;
  };

  return {
    plan: async () => (await getPlan()).plan,
    get lastProvider() {
      return last;
    },
    async warm() {
      try {
        const { plan, key } = await getPlan();
        const first = plan.providers.find((p) => !dead.has(p));
        // Kokoro takes 1–2 s to load: do it now when it is first, or the fallback right after ElevenLabs.
        if (plan.providers.includes('kokoro') && (first === 'kokoro' || first === 'elevenlabs')) {
          await (provider('kokoro', key) as KokoroSpeaker).warm();
        }
      } catch {
        /* reported when it is used */
      }
    },
    speak(text: string): SpeakHandle {
      const clean = stripForSpeech(text);
      let cancelled = false;
      let current: SpeakHandle | null = null;
      const done = (async () => {
        if (!clean) return;
        const { plan, key } = await getPlan();
        const order = plan.providers;
        for (let i = 0; i < order.length; i++) {
          const name = order[i]!;
          if (dead.has(name)) continue;
          if (cancelled) return;
          current = provider(name, key).speak(clean);
          try {
            await current.done;
            if (!cancelled) last = name;
            return;
          } catch (e) {
            if (cancelled) return;
            const f = e instanceof TtsFailure ? e : new TtsFailure(name, 'engine', (e as Error).message);
            if (f.sticky) dead.add(name);
            const next = order.slice(i + 1).find((p) => !dead.has(p));
            logOnce(`fail:${name}:${f.reason}`, `Voice output: ${f.message} — ${next ? `using ${PROVIDER_LABEL[next]}` : 'reply not spoken'}.`);
          }
        }
      })().catch((e: unknown) => logOnce(`bug:${(e as Error).message}`, `Voice output failed: ${(e as Error).message}`));
      return {
        done,
        cancel: () => {
          cancelled = true;
          current?.cancel();
        },
      };
    },
  };
}
