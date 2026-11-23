import { silenceSound } from './helpers/no-sound.js';
import { acquireSuiteLock } from './helpers/suite-lock.js';

/** Vitest globalSetup: one suite per machine (#109), and no sound from tests. The returned function is the teardown. */
export default function setup(): () => void {
  let release: () => void;
  try {
    release = acquireSuiteLock();
  } catch (e) {
    // Stop here with the plain message (#171). If we throw, vitest prints a vite stack-trace crash
    // ("code.charCodeAt is not a function") instead of the message, and a JSON reporter writes an empty result.
    process.stderr.write(`\n${(e as Error).message}\n\n`);
    process.exit(1);
  }
  const unsilence = silenceSound();
  return () => {
    unsilence();
    release();
  };
}
