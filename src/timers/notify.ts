/**
 * A macOS notification for a fired timer/reminder or a finished job. The text goes in as argv items to an
 * `on run argv` script, never spliced into AppleScript source, so it can't inject script. Best effort: errors are ignored.
 */
import { execFile } from 'node:child_process';

export type NotifyFn = (text: string) => void;
/** A notification with its own title (job finished). */
export type NotifyTitledFn = (title: string, body: string) => void;

/** The osascript argv for one notification (pure, so tests can check that the text only ever travels as argv). */
export function notifyArgv(title: string, body: string): string[] {
  return [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"',
    '-e',
    'end run',
    body.slice(0, 240),
    title.slice(0, 80),
  ];
}

export const macNotifyTitled: NotifyTitledFn = (title, body) => {
  if (process.platform !== 'darwin') return;
  execFile('osascript', notifyArgv(title, body), { timeout: 5000 }, () => undefined);
};

export const macNotify: NotifyFn = (text) => macNotifyTitled('Stephen', text);
