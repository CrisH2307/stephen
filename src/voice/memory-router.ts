/**
 * Memory commands handled before Claude (docs/PLAN-1.9-MEMORY-DASHBOARD.md sections 4 and 12.3).
 *
 * The Assistant asks route() first with the user's own words (the listener's normalized transcript, or typed text).
 * A memory command ("remember …", "forget …", "forget that", "forget everything", "what do you remember") is done
 * here and never reaches `claude -p`; anything else returns null and goes to Claude as before. Claude's replies are
 * never parsed here, so nothing Claude reads or says can change memory.
 *
 * Trust by channel: push-to-talk ('voice-ptt'), the Stephen app ('app') and `listen --text` ('cli') save directly.
 * A wake-word "remember …" ('voice-wake') asks in a macOS dialog first when memory.confirmWakeWord is on (a video
 * can say "Hey Stephen, remember …"). "Forget everything" always asks. From the phone ('phone', docs/ADR-005) nobody is
 * at the Mac to answer a dialog and the phone may not be in the owner's hands: every change is refused (a saved
 * memory goes out with every later command), and listing gives the count only.
 *
 * "Remember X and play Y" (12.3): X is saved here and the route carries `rest` ("play Y") for the Assistant to run
 * as a normal Claude command in the same handle.
 */
import type { Confirmer } from '../types.js';
import { matchForget, newestWithin, parseDetailed, rawTail, type MemoryIntent } from '../memory/intent.js';
import { MEMORY_MESSAGES, MemoryStoreError, type MemoryItem, type MemorySource, type MemoryStore } from '../memory/store.js';

export const PHONE_MEMORY_REPLY = "I can't change my memory from your phone. Do that at the Mac (hold F5, or the Stephen app).";

/** Where a command came from: push-to-talk, wake word, the Stephen app (typed), or `stephen listen --text`. */
export type CommandSource = MemorySource;

export interface MemoryRoute {
  /** What to say / show. With `rest`, Claude's reply is appended to it. */
  reply: string;
  /** Memory changed (add / forget / clear): the follow-up conversation must end (section 3). */
  changed: boolean;
  /** Split command: run this as a normal Claude command after the reply prefix. */
  rest?: string;
  /** Store this instead of what was said in history (a refused secret must not be kept; review 5, R5-3). */
  said?: string;
}

/** What history keeps for a refused secret memory command. */
export const REFUSED_SECRET_SAID = 'remember [refused: looks like a secret]';

export interface MemoryRouterOptions {
  store: MemoryStore;
  /** memory.confirmWakeWord: a wake-word "remember …" asks in a dialog first. */
  confirmWakeWord: boolean;
  /** Asks the user (a DialogConfirmer in `stephen listen`: Deny default, 120 s). */
  confirmer: Confirmer;
  now?: () => Date;
  log?: (line: string) => void;
}

/** How many items a spoken list or tie reply names before "and N more". */
const SPOKEN_ITEMS = 10;

function quoteList(items: readonly MemoryItem[]): string {
  const shown = items.slice(0, SPOKEN_ITEMS).map((i) => i.text);
  const more = items.length - shown.length;
  return shown.join('; ') + (more > 0 ? `; and ${more} more` : '');
}

export class MemoryRouter {
  constructor(private readonly o: MemoryRouterOptions) {}

  /**
   * Handle `text` if it is a memory command; null = not one (send it to Claude). `raw` is the original-case text
   * (the ASR transcript, or the typed text) used to keep "Dr. Patel" as said. Never throws.
   */
  async route(text: string, opts: { source: CommandSource; raw?: string }): Promise<MemoryRoute | null> {
    const parsed = parseDetailed(text, { source: opts.source, ...(opts.raw !== undefined ? { raw: opts.raw } : {}) });
    if (!parsed) return null;
    try {
      return await this.handle(parsed.intent, opts.source, opts.raw ?? text, parsed.opener);
    } catch (e) {
      this.o.log?.(`memory: ${(e as Error).message}`);
      return { reply: e instanceof MemoryStoreError ? MEMORY_MESSAGES.unreadable : 'Something went wrong with my memory.', changed: false };
    }
  }

  private async handle(intent: MemoryIntent, source: CommandSource, raw: string, opener?: string): Promise<MemoryRoute> {
    if (source === 'phone' && intent.kind !== 'list') return { reply: PHONE_MEMORY_REPLY, changed: false };
    switch (intent.kind) {
      case 'remember':
        return this.remember(rawTail(raw, intent.text), source, intent.rest !== undefined ? rawTail(raw, intent.rest) : undefined, opener);
      case 'remember-code':
        return { reply: MEMORY_MESSAGES.secret, changed: false, said: REFUSED_SECRET_SAID };
      case 'list':
        return this.list(source);
      case 'forget':
        return this.forget(intent.query, source);
      case 'forget-last':
        return this.forgetLast(source);
      case 'forget-all':
        return this.forgetAll();
    }
  }

  private async remember(text: string, source: CommandSource, rest: string | undefined, opener = 'remember'): Promise<MemoryRoute> {
    const withRest = (r: MemoryRoute): MemoryRoute => (rest ? { ...r, rest } : r);
    if (source === 'voice-wake' && this.o.confirmWakeWord) {
      const answer = await this.o.confirmer.confirm({
        title: 'Stephen: remember this?',
        body:
          `Remember this? "${text}"` +
          (rest ? `\n\nAllow also runs: "${rest}"` : '') +
          `\n\nYou said "${opener} …" after the wake word. Allow saves it (it is sent to Claude with every command, and read out through your voice service). Hold F5 to save without this question.`,
      });
      // Denied or unanswered: nothing is saved and the rest of the line is not run either (it may not have been you).
      if (answer === 'unavailable') return { reply: "I couldn't ask you to confirm, so I didn't save it. Hold F5 and say it again.", changed: false };
      if (answer !== 'approved') return { reply: "Okay, didn't save it.", changed: false };
    }
    const r = await this.o.store.add(text, source);
    if (!r.ok) return withRest({ reply: r.message, changed: false, ...(r.reason === 'secret' ? { said: REFUSED_SECRET_SAID } : {}) });
    if (r.duplicate) return withRest({ reply: `Already got that one: ${r.item!.text}.`, changed: false });
    return withRest({ reply: `Bet, saved: ${r.item!.text}.`, changed: true });
  }

  /** Wake word with confirmWakeWord on: anyone in the room (or a video) could have said it (review 5, R5-5). */
  private untrusted(source: CommandSource): boolean {
    return source === 'phone' || (source === 'voice-wake' && this.o.confirmWakeWord);
  }

  private async list(source: CommandSource): Promise<MemoryRoute> {
    const items = await this.o.store.list();
    if (!items.length) return { reply: "I don't have anything saved yet. Say \"remember\" and the thing.", changed: false };
    const n = items.length === 1 ? '1 thing' : `${items.length} things`;
    // After the wake word, say only the count: reading them out would tell whoever is in the room.
    if (this.untrusted(source)) return { reply: `I remember ${n}. Hold F5 and ask again, or open the Stephen app, to hear them.`, changed: false };
    return { reply: `I remember ${n}: ${quoteList(items)}.`, changed: false };
  }

  private async forget(query: string, source: CommandSource): Promise<MemoryRoute> {
    const items = await this.o.store.list();
    const m = matchForget(items, query);
    if ('none' in m) return { reply: `I don't have anything about ${query}.`, changed: false };
    if ('tie' in m) {
      if (this.untrusted(source)) return { reply: `I have ${m.tie.length} things about ${query}. Hold F5 and say it more exactly, or use the Stephen app.`, changed: false };
      return { reply: `I have ${m.tie.length} things about ${query}: ${quoteList(m.tie)}. Say it more exactly, or use the Stephen app.`, changed: false };
    }
    return this.forgetItem(m.match, source);
  }

  private async forgetLast(source: CommandSource): Promise<MemoryRoute> {
    const items = await this.o.store.list();
    const newest = newestWithin(items, (this.o.now ?? (() => new Date()))());
    if (!newest) return { reply: "Nothing new to forget from the last 10 minutes. Say \"forget\" and what it was about.", changed: false };
    return this.forgetItem(newest, source);
  }

  private async forgetItem(item: MemoryItem, source: CommandSource): Promise<MemoryRoute> {
    if (this.untrusted(source)) {
      const answer = await this.o.confirmer.confirm({
        title: 'Stephen: forget this?',
        body: `Forget this? "${item.text}"\n\nYou said "forget …" after the wake word. Hold F5 to forget without this question.`,
      });
      if (answer === 'unavailable') return { reply: "I couldn't ask you to confirm, so I kept it. Hold F5 and say it again.", changed: false };
      if (answer !== 'approved') return { reply: 'Okay, kept it.', changed: false };
    }
    const r = await this.o.store.forget(item.id);
    if (!r.ok) return { reply: r.message, changed: false };
    return { reply: `Done, forgot: ${item.text}.`, changed: true };
  }

  private async forgetAll(): Promise<MemoryRoute> {
    const items = await this.o.store.list();
    if (!items.length) return { reply: "I don't have anything saved.", changed: false };
    const n = items.length === 1 ? '1 thing' : `all ${items.length} things`;
    const answer = await this.o.confirmer.confirm({
      title: 'Stephen: forget everything?',
      body: `Forget ${n} you asked me to remember? This can't be undone.`,
    });
    if (answer !== 'approved') return { reply: 'Okay, kept everything.', changed: false };
    const r = await this.o.store.clear();
    if (!r.ok) return { reply: r.message, changed: false };
    return { reply: `Done, wiped ${n}. Fresh start.`, changed: true };
  }
}
