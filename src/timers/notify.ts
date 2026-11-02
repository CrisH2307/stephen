/**
 * A macOS notification for a fired timer/reminder. The text goes in as an argv item to an `on run argv` script, never
 * spliced into AppleScript source, so it can't inject script. Best effort: errors are ignored.
 */
import { execFile } from 'node:child_process';

export type NotifyFn = (text: string) => void;

export const macNotify: NotifyFn = (text) => {
  if (process.platform !== 'darwin') return;
  execFile(
    'osascript',
    ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Stephen" sound name "Glass"', '-e', 'end run', text.slice(0, 240)],
    { timeout: 5000 },
    () => undefined,
  );
};
