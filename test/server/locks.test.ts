import { describe, expect, it } from 'vitest';
import { HubError } from '../../src/errors.js';
import { RwLock, TabLocks } from '../../src/server/locks.js';
import { deferred, tick } from './fakes.js';

describe('RwLock', () => {
  it('exclusive holders run one at a time, in arrival order', async () => {
    const lock = new RwLock();
    const log: string[] = [];
    const job = async (name: string, ms: number) => {
      const release = await lock.acquire('exclusive');
      log.push(`${name} start`);
      await tick(ms);
      log.push(`${name} end`);
      release();
    };
    await Promise.all([job('a', 20), job('b', 1), job('c', 1)]);
    expect(log).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
    expect(lock.idle).toBe(true);
  });

  it('shared holders run together; a waiting writer blocks later readers (no starvation)', async () => {
    const lock = new RwLock();
    const r1 = await lock.acquire('shared');
    const r2 = await lock.acquire('shared'); // granted immediately alongside r1
    let writer = false;
    let lateReader = false;
    const w = lock.acquire('exclusive').then((rel) => {
      writer = true;
      return rel;
    });
    const r3 = lock.acquire('shared').then((rel) => {
      lateReader = true;
      return rel;
    });
    await tick();
    expect(writer).toBe(false);
    expect(lateReader).toBe(false); // queued behind the writer
    r1();
    await tick();
    expect(writer).toBe(false); // r2 still holds
    r2();
    const wRel = await w;
    expect(writer).toBe(true);
    expect(lateReader).toBe(false);
    wRel();
    (await r3)();
    expect(lateReader).toBe(true);
    expect(lock.idle).toBe(true);
  });

  it('release is idempotent', async () => {
    const lock = new RwLock();
    const rel = await lock.acquire('shared');
    rel();
    rel();
    const x = await lock.acquire('exclusive');
    x();
    expect(lock.idle).toBe(true);
  });
});

describe('TabLocks', () => {
  it('serializes writes per tab but not across tabs', async () => {
    const locks = new TabLocks();
    const gate = deferred();
    const log: string[] = [];
    const a = locks.run('z1', 'write', async () => {
      log.push('z1 a');
      await gate.promise;
    });
    const b = locks.run('z1', 'write', async () => {
      log.push('z1 b');
    });
    const c = locks.run('z2', 'write', async () => {
      log.push('z2 c');
    });
    await c;
    expect(log).toEqual(['z1 a', 'z2 c']);
    gate.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['z1 a', 'z2 c', 'z1 b']);
  });

  it('releases the lock when fn throws', async () => {
    const locks = new TabLocks();
    await expect(locks.run('z1', 'write', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await locks.run('z1', 'write', async () => 42)).toBe(42);
  });

  it('a new holder waits for an orphaned op, then proceeds', async () => {
    const locks = new TabLocks({ orphanWaitMs: 1000 });
    const op = deferred();
    locks.orphan('z1', op.promise);
    expect(locks.busy('z1')).toBe(true);
    let ran = false;
    const p = locks.run('z1', 'read', async () => {
      ran = true;
    });
    await tick(30);
    expect(ran).toBe(false);
    op.resolve();
    await p;
    expect(ran).toBe(true);
    expect(locks.busy('z1')).toBe(false);
  });

  it('a rejected orphan also frees the tab', async () => {
    const locks = new TabLocks({ orphanWaitMs: 1000 });
    const op = deferred();
    locks.orphan('z1', op.promise);
    op.reject(new Error('x'));
    await expect(locks.run('z1', 'write', async () => 'ok')).resolves.toBe('ok');
  });

  it('gives up with TIMEOUT (without running fn) if the orphan keeps running', async () => {
    const locks = new TabLocks({ orphanWaitMs: 40 });
    locks.orphan('z1', new Promise(() => {}));
    let ran = false;
    const e = await locks
      .run('z1', 'write', async () => {
        ran = true;
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubError);
    expect((e as HubError).code).toBe('TIMEOUT');
    expect(ran).toBe(false);
  });

  it('does not wait for the orphan while a dialog blocks it; dialog access awaits it before releasing', async () => {
    const locks = new TabLocks({ orphanWaitMs: 1000 });
    const op = deferred();
    locks.orphan('z1', op.promise);
    let dialog = true;
    // Any call while the dialog is pending runs at once (the tool reports the dialog).
    await locks.run('z1', 'read', async () => undefined, () => dialog);
    // handle_dialog runs immediately, and its release waits for the orphan to settle.
    const log: string[] = [];
    const handled = locks.run('z1', 'dialog', async () => {
      log.push('answered');
      dialog = false;
      setTimeout(() => op.resolve(), 20); // answering the dialog unblocks the op
    });
    const next = locks.run('z1', 'write', async () => {
      log.push('next');
    });
    await Promise.all([handled, next]);
    expect(log).toEqual(['answered', 'next']);
    expect(locks.busy('z1')).toBe(false);
  });
});
