/**
 * `stephen voice-key set|status|delete`: the ElevenLabs API key in the macOS Keychain. Owner-only CLI, loaded on
 * demand by src/cli.ts (review 7, R7-8: the Keychain writes are not in `stephen serve`'s module graph).
 */
import type { TtsConfig } from '../voice/tts/config.js';
import { defaultExec, isMac, keychainAccount } from '../lib/keychain.js';
import { KEY_ENV, KEYCHAIN_SERVICE, findApiKey, type KeyDeps } from '../voice/tts/keys.js';
import { API_KEY_RE, redactKey } from '../voice/tts/redact.js';
import { keychainDelete, keychainStore } from './keychain-write.js';

export const VOICE_KEY_USAGE = `stephen voice-key set      Store your ElevenLabs API key in the macOS Keychain (reads it from stdin:
                           hidden prompt in a terminal, or piped: \`pbpaste | stephen voice-key set\`)
stephen voice-key status   Where the key is found (shows only its last 4 characters)
stephen voice-key delete   Remove it from the Keychain`;

export interface VoiceKeyEnv extends KeyDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Reads the key (default: hidden prompt on a TTY, else all of stdin). */
  readSecret?: (prompt: string) => Promise<string>;
  /** The "voice" section of config.json (for apiKeyFile in `status`). */
  ttsConfig?: () => Pick<TtsConfig, 'elevenlabs'>;
}

/** Read a secret from stdin: hidden (no echo) when stdin is a terminal, otherwise everything piped in. */
export function readSecretFromStdin(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d: string) => {
        data += d;
        if (data.length > 4096) {
          stdin.destroy();
          reject(new Error('input too long'));
        }
      });
      stdin.once('end', () => resolve(data));
      stdin.once('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let data = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.off('data', onData);
      stdin.pause();
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(data);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') data = data.slice(0, -1);
        else if (ch >= ' ') data += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

export async function runVoiceKey(argv: string[], env: VoiceKeyEnv = {}): Promise<number> {
  const out = env.out ?? ((l: string) => console.log(l));
  const err = env.err ?? ((l: string) => console.error(l));
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    (sub ? out : err)(VOICE_KEY_USAGE);
    return sub ? 0 : 2;
  }
  if (rest.length) {
    err(`Unknown option "${rest[0]}".\n${VOICE_KEY_USAGE}`);
    return 2;
  }
  const exec = env.exec ?? defaultExec;
  const user = keychainAccount(env);
  if (sub === 'status') {
    let cfg: Pick<TtsConfig, 'elevenlabs'> = { elevenlabs: { voiceId: '', modelId: '', timeoutSec: 8, apiKeyFile: null } };
    try {
      if (env.ttsConfig) cfg = env.ttsConfig();
    } catch (e) {
      err((e as Error).message);
    }
    const r = await findApiKey(cfg, env);
    for (const n of r.notes) err(`note: ${n}`);
    if (!r.found) {
      out('No ElevenLabs API key found (looked in: macOS Keychain, $ELEVENLABS_API_KEY, voice.elevenlabs.apiKeyFile).');
      out('Run `stephen voice-key set` to add one. Until then Stephen speaks with the local voice.');
      return 1;
    }
    out(`ElevenLabs API key: ${redactKey(r.found.key)} — from ${r.found.where}.`);
    return 0;
  }
  if (sub !== 'set' && sub !== 'delete') {
    err(`Unknown voice-key command "${sub}".\n${VOICE_KEY_USAGE}`);
    return 2;
  }
  if (!isMac(env)) {
    err(`The Keychain is macOS-only. On this system set $${KEY_ENV} or voice.elevenlabs.apiKeyFile (a mode-0600 file) instead.`);
    return 1;
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    err(`Unsupported user name for the Keychain account: ${JSON.stringify(user)}`);
    return 1;
  }
  if (sub === 'delete') {
    const r = await keychainDelete(KEYCHAIN_SERVICE, { exec, user });
    if (r === 'missing') {
      out('There was no ElevenLabs key in the Keychain.');
      return 0;
    }
    if (r !== 'deleted') {
      err(`Could not delete the key: ${r}`);
      return 1;
    }
    out(`Deleted the ElevenLabs key from the Keychain (service "${KEYCHAIN_SERVICE}").`);
    if ((env.env ?? process.env)[KEY_ENV]) out(`Note: $${KEY_ENV} is still set in this shell and will be used.`);
    return 0;
  }

  // set
  let key: string;
  try {
    key = (await (env.readSecret ?? readSecretFromStdin)('ElevenLabs API key (input hidden): ')).trim();
  } catch (e) {
    err(`No key read: ${(e as Error).message}`);
    return 1;
  }
  if (!key) {
    err('No key given. Paste it at the prompt, or pipe it in: `pbpaste | stephen voice-key set`.');
    return 1;
  }
  if (!API_KEY_RE.test(key)) {
    err('That does not look like an ElevenLabs API key (expected one word like "sk_…", no spaces or quotes). Nothing was stored.');
    return 1;
  }
  const bad = await keychainStore(KEYCHAIN_SERVICE, 'Stephen ElevenLabs API key', key, { exec, user });
  if (bad) {
    err(bad);
    return 1;
  }
  out(`Stored the ElevenLabs API key ${redactKey(key)} in the Keychain (service "${KEYCHAIN_SERVICE}", account "${user}").`);
  out('Check it with `stephen doctor --network`. If this key was ever pasted into a chat or a file, rotate it at elevenlabs.io → API keys.');
  return 0;
}
