/**
 * Per-tab concurrency control.
 *
 * MCP clients may issue tool calls concurrently. Two actions on the same tab must never interleave
 * (e.g. a click landing between "describe the element" and "type into it"), and a read must not see
 * a half-done action. So each tab has a fair readers–writer lock:
 *   - mutating tools take it exclusively (the whole describe → gate → re-check → act → report sequence);
 *   - reads (snapshot, find, read_text, screenshot, wait_for) share it with each other.
 * Waiters are served FIFO, so a waiting action is not starved by a stream of reads.
 *
 * A page operation can outlive its tool call: it timed out, or a JS dialog opened and the call
 * returned early so the model can answer it. Such an operation is kept as the tab's "orphan".
 * The next holder of the tab first waits for the orphan to settle (bounded), so a leftover
 * operation can never run interleaved with a new one. handle_dialog is the exception: it is what
 * unblocks the orphan, so it skips the wait and instead awaits the orphan before releasing.
 */
import { HubError } from '../errors.js';
import type { TabId } from '../types.js';

export type LockMode = 'shared' | 'exclusive';

interface Waiter {
  mode: LockMode;
  grant: () => void;
}

/** A fair (FIFO) readers–writer lock. */
export class RwLock {
  #readers = 0;
  #writer = false;
  readonly #queue: Waiter[] = [];

  get idle(): boolean {
    return this.#readers === 0 && !this.#writer && this.#queue.length === 0;
  }

  /** Acquire; resolves to a release function (idempotent). */
  acquire(mode: LockMode): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        if (mode === 'exclusive') this.#writer = true;
        else this.#readers++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          if (mode === 'exclusive') this.#writer = false;
          else this.#readers--;
          this.#drain();
        });
      };
      if (this.#queue.length === 0 && this.#compatible(mode)) grant();
      else this.#queue.push({ mode, grant });
    });
  }

  #compatible(mode: LockMode): boolean {
    return mode === 'exclusive' ? !this.#writer && this.#readers === 0 : !this.#writer;
  }

  #drain(): void {
    while (this.#queue.length > 0 && this.#compatible(this.#queue[0]!.mode)) {
      const w = this.#queue.shift()!;
      w.grant();
      if (w.mode === 'exclusive') return;
    }
  }
}

export interface TabLockOptions {
  /** How long a new holder waits for a leftover (orphaned) operation to finish. */
  orphanWaitMs: number;
}

/** What the caller is doing with the tab. 'dialog' = answering a JS dialog (see file comment). */
export type TabAccess = 'read' | 'write' | 'dialog';

export class TabLocks {
  readonly #locks = new Map<TabId, RwLock>();
  readonly #orphans = new Map<TabId, Set<Promise<unknown>>>();
  readonly #opts: TabLockOptions;

  constructor(opts: Partial<TabLockOptions> = {}) {
    this.#opts = { orphanWaitMs: 15_000, ...opts };
  }

  /**
   * Run `fn` holding the tab. `dialogPending` tells whether a JS dialog is blocking the tab
   * (then waiting for an orphan is pointless: it cannot finish until the dialog is answered,
   * and the caller will report the dialog instead).
   */
  async run<T>(tab: TabId, access: TabAccess, fn: () => Promise<T>, dialogPending: () => boolean = () => false): Promise<T> {
    const lock = this.#lock(tab);
    const release = await lock.acquire(access === 'read' ? 'shared' : 'exclusive');
    try {
      if (access !== 'dialog' && !dialogPending()) await this.#awaitOrphans(tab, dialogPending);
      const out = await fn();
      if (access === 'dialog') await this.#awaitOrphans(tab, () => false, false);
      return out;
    } finally {
      release();
      if (lock.idle && !this.#orphans.has(tab)) this.#locks.delete(tab);
    }
  }

  /** Record a page operation that is still running after its tool call gave up waiting for it. */
  orphan(tab: TabId, op: Promise<unknown>): void {
    const set = this.#orphans.get(tab) ?? new Set();
    set.add(op);
    this.#orphans.set(tab, set);
    const done = (): void => {
      set.delete(op);
      if (set.size === 0 && this.#orphans.get(tab) === set) this.#orphans.delete(tab);
    };
    op.then(done, done);
  }

  /** True while an orphaned operation is still running on the tab. */
  busy(tab: TabId): boolean {
    return (this.#orphans.get(tab)?.size ?? 0) > 0;
  }

  /** Forget a closed tab. */
  forget(tab: TabId): void {
    this.#orphans.delete(tab);
  }

  #lock(tab: TabId): RwLock {
    let l = this.#locks.get(tab);
    if (!l) {
      l = new RwLock();
      this.#locks.set(tab, l);
    }
    return l;
  }

  async #awaitOrphans(tab: TabId, dialogPending: () => boolean, fail = true): Promise<void> {
    const set = this.#orphans.get(tab);
    if (!set || set.size === 0) return;
    const deadline = Date.now() + this.#opts.orphanWaitMs;
    while ((this.#orphans.get(tab)?.size ?? 0) > 0) {
      if (dialogPending()) return;
      const left = deadline - Date.now();
      if (left <= 0) break;
      const pending = [...(this.#orphans.get(tab) ?? [])];
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((r) => {
          timer = setTimeout(r, Math.min(left, 250)); // re-check dialogPending periodically
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    if (fail && this.busy(tab) && !dialogPending()) {
      throw new HubError(
        'TIMEOUT',
        `An earlier action on ${tab} is still running (it timed out). Nothing new was done. Wait a little and retry, or take a snapshot to see the page state.`,
      );
    }
  }
}
