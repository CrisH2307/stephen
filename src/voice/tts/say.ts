/** macOS `say` as a chain provider (text on stdin; failures reported, unlike speech.ts's SaySpeaker). */
import { spawn } from 'node:child_process';
import type { SpeakHandle } from '../speech.js';
import { TtsFailure, type TtsProvider } from './player.js';

export class SayProvider implements TtsProvider {
  readonly name = 'say' as const;
  constructor(
    private readonly voice: string | null,
    private readonly rate: number | null,
    private readonly command = 'say',
  ) {}

  speak(text: string): SpeakHandle {
    const args: string[] = [];
    if (this.voice) args.push('-v', this.voice);
    if (this.rate) args.push('-r', String(this.rate));
    const child = spawn(this.command, args, { stdio: ['pipe', 'ignore', 'pipe'], shell: false });
    let killed = false;
    let err = '';
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (err += d.slice(0, 500)));
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', (e: NodeJS.ErrnoException) =>
        reject(new TtsFailure('say', 'player', e.code === 'ENOENT' ? '`say` is not available (macOS only)' : `say failed: ${e.message}`, e.code === 'ENOENT')),
      );
      child.once('close', (code, signal) => {
        if (killed || code === 0) resolve();
        else reject(new TtsFailure('say', 'player', `say failed: ${err.trim().split('\n')[0] || (signal ?? `exit ${code}`)}`));
      });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(text);
    return {
      done,
      cancel: () => {
        killed = true;
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      },
    };
  }
}
