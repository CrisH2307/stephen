/** Review 5 fixes (docs/REVIEW-5.md), one describe per finding. R5-1 is in transcripts.test.ts. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/memory/store.js';
import type { ConfirmOutcome, ConfirmPrompt, Confirmer } from '../../src/types.js';
import { Assistant, type CommandReport } from '../../src/voice/assistant.js';
import { Conversation, ConversationRunner, memoryKey } from '../../src/voice/conversation.js';
import { MemoryRouter, REFUSED_SECRET_SAID } from '../../src/voice/memory-router.js';
import { FakeRunner } from './fakes.js';
import { RecordingChimes, RecordingSpeaker } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-review5-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(tmp, `d${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const A = 'aaaaaaaa-1111-2222-3333-444444444444';

class FakeConfirmer implements Confirmer {
  readonly kind = 'fake';
  readonly prompts: ConfirmPrompt[] = [];
  constructor(public answer: ConfirmOutcome = 'approved') {}
  async confirm(p: ConfirmPrompt): Promise<ConfirmOutcome> {
    this.prompts.push(p);
    return this.answer;
  }
}

/** Memory router + Assistant with a fake runner (never claude). */
function harness() {
  const home = fresh();
  const store = new MemoryStore({ home });
  const confirmer = new FakeConfirmer();
  const runner = new FakeRunner();
  const speaker = new RecordingSpeaker();
  const reports: CommandReport[] = [];
  const router = new MemoryRouter({ store, confirmWakeWord: true, confirmer });
  const assistant = new Assistant({ runner, speaker, chimes: new RecordingChimes(), speak: true, status: () => {}, memory: router, onDone: (r) => reports.push(r) });
  const say = async (text: string, source: 'voice-ptt' | 'voice-wake' | 'cli' | 'app' = 'voice-ptt') => {
    await assistant.handle(text, { source });
    return speaker.said.at(-1);
  };
  return { home, store, confirmer, runner, speaker, reports, say };
}

describe('R5-2: a memory change made anywhere ends the follow-up conversation', () => {
  it('memoryKey is stable and changes with the list', () => {
    expect(memoryKey(['gym is goodlife'])).toBe(memoryKey(['gym is goodlife']));
    expect(memoryKey(['gym is goodlife'])).not.toBe(memoryKey([]));
    expect(memoryKey(['a', 'b'])).not.toBe(memoryKey(['ab']));
  });

  it('the next run resumes only while memory is unchanged', async () => {
    let memory = ['gym is goodlife'];
    const conversation = new Conversation({ dir: fresh(), windowSec: 180, memoryKey: () => memoryKey(memory) });
    const resumes: (string | undefined)[] = [];
    const inner = {
      run: async (_p: string, r?: { resume?: string }) => {
        resumes.push(r?.resume);
        return { kind: 'ok', reply: 'ok', sessionId: A } as never;
      },
      cancel: () => false,
    };
    const runner = new ConversationRunner(inner, conversation);
    await runner.run('one');
    await runner.run('two');
    memory = []; // e.g. `stephen memory clear` from another terminal
    await runner.run('three');
    expect(resumes).toEqual([undefined, A, undefined]);
  });

  it('an unreadable memory list never resumes', async () => {
    let fail = false;
    const conversation = new Conversation({
      dir: fresh(),
      windowSec: 180,
      memoryKey: () => {
        if (fail) throw new Error('locked');
        return memoryKey([]);
      },
    });
    conversation.finish({ kind: 'ok', reply: 'x', sessionId: A } as never);
    fail = true;
    expect(conversation.begin()).toBeNull();
  });

  it('an old conversation.json without a memory key is not resumed once keys are on', () => {
    const dir = fresh();
    new Conversation({ dir, windowSec: 180 }).finish({ kind: 'ok', reply: 'x', sessionId: A } as never);
    expect(new Conversation({ dir, windowSec: 180 }).begin()).toBe(A);
    expect(new Conversation({ dir, windowSec: 180, memoryKey: () => memoryKey([]) }).begin()).toBeNull();
  });
});

describe('R5-3: a refused secret is not kept in history', () => {
  it('history gets a placeholder, not the digits', async () => {
    const h = harness();
    expect(await h.say('remember my door code is 1 2 3 4 5 6')).toBe("I don't save passwords, codes or card numbers.");
    expect(h.reports.at(-1)!.said).toBe(REFUSED_SECRET_SAID);
    expect(await h.say('remember my gym is goodlife')).toBe('Bet, saved: my gym is goodlife.');
    expect(h.reports.at(-1)!.said).toBe('remember my gym is goodlife');
  });
});

describe('R5-4: secret refusal covers the common speech-to-text shapes', () => {
  it('refuses commas, full-width digits, "pin\'s", "pass word", reversed lock words', async () => {
    const { memoryTextLooksSecret } = await import('../../src/memory/store.js');
    for (const t of [
      'my visa is 4512, 3456, 7890, 1234',
      'code for the door: 1, 2, 3, 4, 5, 6',
      'code for the door is 1, 2, 3, 4',
      'visa ４５１２３４５６７８９０',
      "my pin's 4417",
      'my pin’s 4417',
      'my pass word is hunter2',
      'the garage opens with 4417',
      'my wifi passwords are on the fridge',
    ]) expect(memoryTextLooksSecret(t), t).toBe(true);
    for (const t of ['my prof for sofe 3980 is dr patel', 'class at 9', 'i graduate in 2026', 'my exam is nov 12, 2026', 'room 1, 2 or 3', 'my gym is goodlife on king st'])
      expect(memoryTextLooksSecret(t), t).toBe(false);
  });

  it('"remember 4417" / "remember hunter2" are refused locally (Claude never sees them); "remember goodlife" still goes to Claude', async () => {
    const h = harness();
    expect(await h.say('remember 4417')).toBe("I don't save passwords, codes or card numbers.");
    expect(h.reports.at(-1)!.said).toBe(REFUSED_SECRET_SAID);
    expect(await h.say('remember hunter2')).toBe("I don't save passwords, codes or card numbers.");
    expect(h.runner.prompts).toEqual([]);
    await h.say('remember goodlife');
    expect(h.runner.prompts).toEqual(['remember goodlife']);
    expect(await h.store.list()).toEqual([]);
  });
});

describe('R5-5: wake-word forget asks first; wake-word list says only the count', () => {
  it('forget after the wake word: declined or unavailable keeps it, approved forgets; Fn+Option forgets without asking', async () => {
    const h = harness();
    await h.store.add('my gym is goodlife', 'cli');
    await h.store.add('my prof for math is dr chen', 'cli');
    h.confirmer.answer = 'declined';
    expect(await h.say('forget my gym', 'voice-wake')).toBe('Okay, kept it.');
    h.confirmer.answer = 'unavailable';
    expect(await h.say('forget that', 'voice-wake')).toContain('kept it');
    expect((await h.store.list()).length).toBe(2);
    expect(h.runner.conversationEnds).toBe(0);
    expect(h.confirmer.prompts[0]!.title).toBe('Stephen: forget this?');
    h.confirmer.answer = 'approved';
    expect(await h.say('forget my gym', 'voice-wake')).toBe('Done, forgot: my gym is goodlife.');
    const asked = h.confirmer.prompts.length;
    expect(await h.say('forget my prof', 'voice-ptt')).toBe('Done, forgot: my prof for math is dr chen.');
    expect(h.confirmer.prompts.length).toBe(asked);
  });

  it('list and tie replies after the wake word name no items', async () => {
    const h = harness();
    await h.store.add('my prof for sofe 3980 is dr patel', 'cli');
    await h.store.add('my prof for math is dr chen', 'cli');
    const list = await h.say('what do you remember', 'voice-wake');
    expect(list).toBe('I remember 2 things. Hold F5 and ask again, or open the Stephen app, to hear them.');
    const tie = await h.say('forget my prof', 'voice-wake');
    expect(tie).not.toContain('patel');
    expect(tie).not.toContain('chen');
    expect(await h.say('what do you remember', 'voice-ptt')).toContain('dr patel');
  });
});

describe('R5-6: history retention is a rolling window, purged at start and on list', () => {
  it('"1 day" keeps exactly since the same time yesterday; list() purges; 0 + list() deletes everything', async () => {
    const { HistoryStore } = await import('../../src/history/store.js');
    const { readdirSync, readFileSync } = await import('node:fs');
    const home = fresh();
    let t = new Date(2026, 9, 30, 20, 0);
    const now = () => new Date(t);
    const e = (said: string) => ({ source: 'voice-ptt' as const, said, reply: 'ok', outcome: 'ok' as const, tools: [], followUp: false, ms: 1, turns: 1 });
    const s30 = new HistoryStore({ home, retentionDays: 30, now });
    s30.append(e('oct 30 evening'));
    t = new Date(2026, 9, 31, 9, 0);
    s30.append(e('oct 31 morning'));
    t = new Date(2026, 9, 31, 22, 0);
    s30.append(e('oct 31 night'));
    t = new Date(2026, 10, 1, 12, 0); // Nov 1 noon: the last 24 h start Oct 31 noon
    const s1 = new HistoryStore({ home, retentionDays: 1, now });
    expect(s1.list().map((x) => x.said)).toEqual(['oct 31 night']);
    const dir = join(home, 'history');
    expect(readdirSync(dir).sort()).toEqual(['2026-10-31.jsonl']); // oct 30 deleted, oct 31 trimmed (no temp files)
    expect(readFileSync(join(dir, '2026-10-31.jsonl'), 'utf8')).not.toContain('morning');
    const off = new HistoryStore({ home, retentionDays: 0, now });
    expect(off.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('history purge passes the exact rolling cutoff to the transcript hook (null when off)', async () => {
    const { HistoryStore } = await import('../../src/history/store.js');
    const calls: (number | null)[] = [];
    const t = new Date(2026, 10, 1, 12, 0);
    new HistoryStore({ home: fresh(), retentionDays: 1, now: () => t, onPurge: (c) => calls.push(c) }).purge();
    new HistoryStore({ home: fresh(), retentionDays: 0, now: () => t, onPurge: (c) => calls.push(c) }).purge();
    expect(calls).toEqual([new Date(2026, 9, 31, 12, 0).getTime(), null]);
  });
});

describe('R5-9 / R5-10: the wake-word remember dialog shows everything Allow does', () => {
  it('names the split command and the voice service', async () => {
    const h = harness();
    await h.say('remember my gym is goodlife and play lofi', 'voice-wake');
    const body = h.confirmer.prompts[0]!.body;
    expect(body).toContain('"my gym is goodlife"');
    expect(body).toContain('Allow also runs: "play lofi"');
    expect(body).toContain('voice service');
    expect(h.runner.prompts).toEqual(['play lofi']);
  });
});
