/** `stephen voice-setup --tts kokoro`: download the local Kokoro voice (opt-in: ~103 MB). */
import { join } from 'node:path';
import type { Downloader, Extractor } from '../models.js';
import { ensureKokoro, KOKORO_MODEL, kokoroDir } from './kokoro.js';

export const TTS_SETUP_USAGE = 'stephen voice-setup --tts kokoro   Download the local Kokoro voice (~103 MB; used when ElevenLabs is unavailable)';

/** True when the voice-setup argv is about voice output (cli.ts routes it here instead of runVoiceSetup). */
export function isTtsSetupArgs(argv: readonly string[]): boolean {
  return argv.some((a) => a === '--tts' || a.startsWith('--tts='));
}

export function parseTtsSetupArgs(argv: readonly string[]): { provider: 'kokoro' } | { error: string } {
  let provider: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--tts') {
      provider = argv[++i];
      if (provider === undefined) return { error: '--tts needs a value (kokoro)' };
    } else if (a.startsWith('--tts=')) provider = a.slice('--tts='.length);
    else return { error: `Unknown option "${a}". Usage: ${TTS_SETUP_USAGE}` };
  }
  if (provider === 'kokoro') return { provider };
  if (provider === 'elevenlabs') return { error: 'ElevenLabs needs no download: run `stephen voice-key set` to store your API key.' };
  if (provider === 'say') return { error: '`say` is built into macOS; nothing to download.' };
  return { error: `--tts must be "kokoro" (got ${JSON.stringify(provider ?? '')})` };
}

export interface TtsSetupEnv {
  home: string;
  modelsRoot?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  download?: Downloader;
  extract?: Extractor;
}

export async function runTtsSetup(argv: readonly string[], env: TtsSetupEnv): Promise<number> {
  const out = env.out ?? ((l: string) => console.log(l));
  const err = env.err ?? ((l: string) => console.error(l));
  const a = parseTtsSetupArgs(argv);
  if ('error' in a) {
    err(a.error);
    return 2;
  }
  const root = env.modelsRoot ?? join(env.home, 'models');
  try {
    const now = await ensureKokoro(root, { log: out, ...(env.download ? { download: env.download } : {}), ...(env.extract ? { extract: env.extract } : {}) });
    out(now ? `Kokoro voice ready in ${kokoroDir(root)}.` : `Kokoro voice already installed (${kokoroDir(root)}).`);
    out(`It is used when ElevenLabs is unavailable, or always with "voice": {"tts": "kokoro"}. Model: ${KOKORO_MODEL.id} (${KOKORO_MODEL.license}).`);
    return 0;
  } catch (e) {
    err(`voice-setup --tts kokoro failed: ${(e as Error).message}`);
    return 1;
  }
}
