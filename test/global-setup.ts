import { silenceSound } from './helpers/no-sound.js';
import { acquireSuiteLock } from './helpers/suite-lock.js';

/** Vitest globalSetup: one suite per machine (#109), and no sound from tests. The returned function is the teardown. */
export default function setup(): () => void {
  const release = acquireSuiteLock();
  const unsilence = silenceSound();
  return () => {
    unsilence();
    release();
  };
}
