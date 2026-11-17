import { acquireSuiteLock } from './helpers/suite-lock.js';

/** Vitest globalSetup: one suite per machine (#109). The returned function is the teardown. */
export default function setup(): () => void {
  return acquireSuiteLock();
}
