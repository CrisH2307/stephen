/**
 * Text-to-speech providers (FROZEN contract for phase 1.5 — see docs/HANDOVER.md).
 * Implementations: 'elevenlabs' (cloud, API key from macOS Keychain / env / key file), 'kokoro' (local
 * sherpa-onnx neural voice), 'say' (macOS built-in). createTts(cfg) returns a Speaker that tries the
 * configured provider and falls back down the chain elevenlabs → kokoro → say on any failure
 * (no key, no credits, network, model missing), logging the reason once.
 */
export type { SpeakHandle, Speaker } from '../speech.js';

export type TtsProviderName = 'elevenlabs' | 'kokoro' | 'say';
