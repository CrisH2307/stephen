/** Spoken replies (macOS `say`) and chimes (`afplay`). Both are injectable so tests never need a Mac. */
import { execFile, spawn } from 'node:child_process';

export const SPEECH_MAX_CHARS = 300;

/**
 * Make Claude's reply fit for text-to-speech: drop markdown (code, emphasis, headings, lists, tables, links →
 * their text, bare URLs → their host), collapse whitespace and cap at ~300 characters on a sentence or word
 * boundary.
 */
export function stripForSpeech(text: string, max: number = SPEECH_MAX_CHARS): string {
  let s = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#)]+)[^\s)]*/gi, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gm, ' ')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/[*_~#]+/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/(?:,\s*){2,}/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd >= max * 0.4) s = cut.slice(0, sentenceEnd + 1);
  else {
    const sp = cut.lastIndexOf(' ');
    s = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, '') + '…';
  }
  return s;
}

export interface SpeakHandle {
  done: Promise<void>;
  cancel(): void;
}

export interface Speaker {
  speak(text: string): SpeakHandle;
}

export type Chime = 'wake' | 'done';

export interface Chimes {
  play(c: Chime): void;
}

const SOUNDS: Record<Chime, string> = {
  wake: '/System/Library/Sounds/Tink.aiff',
  done: '/System/Library/Sounds/Pop.aiff',
};

/** `say` reading the text from stdin (no argv quoting issues, nothing option-like). */
export class SaySpeaker implements Speaker {
  constructor(
    private readonly voice: string | null,
    private readonly rate: number | null,
    private readonly onError: (msg: string) => void = () => {},
  ) {}
  speak(text: string): SpeakHandle {
    const args: string[] = [];
    if (this.voice) args.push('-v', this.voice);
    if (this.rate) args.push('-r', String(this.rate));
    const child = spawn('say', args, { stdio: ['pipe', 'ignore', 'pipe'], shell: false });
    let err = '';
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (err += d));
    const done = new Promise<void>((resolve) => {
      child.once('error', (e: NodeJS.ErrnoException) => {
        this.onError(e.code === 'ENOENT' ? '`say` is not available (macOS only) — reply shown as text only.' : `say failed: ${e.message}`);
        resolve();
      });
      child.once('close', (code, signal) => {
        if (code && !signal) this.onError(`say failed: ${err.trim().split('\n')[0] ?? `exit ${code}`}`);
        resolve();
      });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(text);
    return {
      done,
      cancel: () => {
        if (child.exitCode === null) child.kill('SIGTERM');
      },
    };
  }
}

/** `afplay` with the macOS system sounds; fire-and-forget, silent when unavailable. */
export class AfplayChimes implements Chimes {
  play(c: Chime): void {
    execFile('afplay', [SOUNDS[c]], { timeout: 5000 }, () => {});
  }
}

export const silentSpeaker: Speaker = { speak: () => ({ done: Promise.resolve(), cancel: () => {} }) };
export const silentChimes: Chimes = { play: () => {} };
