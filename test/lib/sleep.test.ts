import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep } from '../../src/lib/process.js';

afterEach(() => vi.restoreAllMocks());

/** The timer sleep() created: it calls setTimeout synchronously, so it is the last call when sleep returns. */
function timerOf(spy: ReturnType<typeof vi.spyOn>): NodeJS.Timeout {
  return spy.mock.results.at(-1)!.value as NodeJS.Timeout;
}

describe('sleep (lib/process)', () => {
  it('waits about the given time and keeps the process alive by default', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const t0 = Date.now();
    const p = sleep(20);
    expect(timerOf(spy).hasRef()).toBe(true);
    await p;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it('with unref, the timer does not keep the process alive', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const p = sleep(5, { unref: true });
    expect(timerOf(spy).hasRef()).toBe(false);
    await p;
  });
});
