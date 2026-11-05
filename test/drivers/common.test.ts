import { EventEmitter } from 'node:events';
import type { Browser } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { DriverBase, isLive } from '../../src/drivers/common.js';
import type { ProfileMode } from '../../src/types.js';

/** A puppeteer-like Browser: `connected` as given, and a BiDi-style `connection.closed`. */
function fakeBrowser(): Browser & { connection: { closed: boolean } } {
  const b = Object.assign(new EventEmitter(), { connected: true, connection: { closed: false }, version: async () => 'Zen/1' });
  return b as unknown as Browser & { connection: { closed: boolean } };
}

class TestDriver extends DriverBase {
  readonly name = 'zen' as const;
  readonly protocol = 'webDriverBiDi' as const;
  connects = 0;
  next: Browser[] = [];
  protected async doConnect(mode: ProfileMode): Promise<Browser> {
    this.connects++;
    const b = this.next.shift()!;
    this.adopt(b, mode, () => 'Zen went away.');
    return b;
  }
  async disconnect(): Promise<void> {}
}

describe('DriverBase notices a dead BiDi connection (puppeteer never fires "disconnected" for it)', () => {
  it('isLive: connected and open → live; closed connection or not connected → dead; CDP (no getter) → live', () => {
    const b = fakeBrowser();
    expect(isLive(b)).toBe(true);
    b.connection.closed = true;
    expect(isLive(b)).toBe(false);
    expect(isLive({ connected: false } as unknown as Browser)).toBe(false);
    expect(isLive({ connected: true } as unknown as Browser)).toBe(true);
  });

  it('a closed connection is forgotten and the next connect() attaches again', async () => {
    const d = new TestDriver();
    const first = fakeBrowser();
    const second = fakeBrowser();
    d.next.push(first, second);
    expect(await d.connect('real')).toBe(first);
    expect(await d.connect('real')).toBe(first); // still live: reused
    expect(d.connects).toBe(1);

    first.connection.closed = true; // Zen quit; `connected` still says true
    expect(first.connected).toBe(true);
    expect(d.current()).toBeNull();
    expect(d.status()).toMatchObject({ connected: false, mode: null, detail: 'Zen went away.' });
    expect(await d.connect('real')).toBe(second);
    expect(d.connects).toBe(2);
  });
});
