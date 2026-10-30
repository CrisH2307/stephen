import type { Dialog, Page } from 'puppeteer-core';
import type { TabId } from '../types.js';

export interface PendingDialog {
  type: string; // 'confirm' | 'prompt' | 'beforeunload'
  message: string;
  /** URL of the page when the dialog opened. */
  url: string;
  dialog: Dialog;
}

export interface SeenAlert {
  message: string;
  url: string;
}

/**
 * Tracks JavaScript dialogs per tab.
 * - alert → auto-accepted; its message is remembered and reported in the next result for that tab.
 * - confirm / prompt / beforeunload → kept pending until handle_dialog; other actions on the tab are refused meanwhile.
 */
export class DialogTracker {
  private readonly attached = new WeakSet<Page>();
  private readonly pending = new Map<TabId, PendingDialog>();
  private readonly alerts = new Map<TabId, SeenAlert[]>();
  private readonly waiters = new Map<TabId, Set<(d: PendingDialog) => void>>();

  /** Attach the 'dialog' listener once per Page. */
  attach(page: Page, tab: TabId): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    page.on('dialog', (dialog: Dialog) => this.onDialog(tab, page, dialog));
  }

  private onDialog(tab: TabId, page: Page, dialog: Dialog): void {
    let type = 'dialog';
    let message = '';
    let url = '';
    try {
      type = dialog.type();
      message = dialog.message();
      url = page.url();
    } catch {
      /* keep defaults */
    }
    if (type === 'alert') {
      const list = this.alerts.get(tab) ?? [];
      list.push({ message, url });
      this.alerts.set(tab, list.slice(-5));
      dialog.accept().catch(() => {});
      return;
    }
    const p: PendingDialog = { type, message, url, dialog };
    this.pending.set(tab, p);
    for (const w of this.waiters.get(tab) ?? []) w(p);
  }

  get(tab: TabId): PendingDialog | undefined {
    return this.pending.get(tab);
  }

  clear(tab: TabId): void {
    this.pending.delete(tab);
  }

  forgetTab(tab: TabId): void {
    this.pending.delete(tab);
    this.alerts.delete(tab);
  }

  /** Alerts seen since the last call (auto-accepted). */
  drainAlerts(tab: TabId): SeenAlert[] {
    const list = this.alerts.get(tab) ?? [];
    this.alerts.delete(tab);
    return list;
  }

  /** Resolves when a non-alert dialog opens on `tab`. Call cancel() when done waiting. */
  waitForDialog(tab: TabId): { promise: Promise<PendingDialog>; cancel: () => void } {
    let fn: ((d: PendingDialog) => void) | undefined;
    const promise = new Promise<PendingDialog>((resolve) => {
      fn = resolve;
    });
    const set = this.waiters.get(tab) ?? new Set();
    set.add(fn!);
    this.waiters.set(tab, set);
    return {
      promise,
      cancel: () => {
        set.delete(fn!);
        if (set.size === 0) this.waiters.delete(tab);
      },
    };
  }
}
