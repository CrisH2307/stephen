/**
 * #202 H1 and H3: one phrase table for the "remember" guard, typed and voice. Each row runs through
 * MemoryRouter.route (the function every real path calls) with the text each caller really passes:
 * - app: cleanTypedCommand(raw) and the raw text (src/app/server.ts);
 * - cli: cleanTypedCommand(raw) as text and raw (`stephen listen --text`, src/voice/index.ts);
 * - voice-ptt and voice-wake: normalizeTranscript(raw) and the raw transcript (src/voice/listener.ts).
 * S = saved, N = nothing saved (goes to Claude), C = refused as a code.
 * A row where typed and voice differ is on purpose today (voice-only refusals). Change a row only with a dev-lane decision.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryStore, type MemorySource } from '../../src/memory/store.js';
import type { ConfirmPrompt, Confirmer } from '../../src/types.js';
import { MemoryRouter } from '../../src/voice/memory-router.js';
import { cleanTypedCommand, normalizeTranscript } from '../../src/voice/transcript.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-remember-table-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const approve: Confirmer = { kind: 'fake', confirm: async (_p: ConfirmPrompt) => 'approved' };

type Want = 'S' | 'N' | 'C';

/** [phrase, typed (app and cli), voice-ptt, voice-wake] */
const TABLE: [string, Want, Want, Want][] = [
  // real facts
  ['Remember that my sister is called Anna', 'S', 'S', 'S'],
  ['Remember my gym is Goodlife', 'S', 'S', 'S'],
  ["Remember I'm vegan", 'S', 'S', 'S'],
  ['Can you remember that my sister is called Anna', 'S', 'S', 'S'],
  ['Hey Stephen remember my cat is Tom', 'S', 'S', 'S'],
  ['Remember my gym is Goodlife and play lofi', 'S', 'S', 'S'],
  // question marks (#114, #122)
  ['Remember my gym?', 'N', 'N', 'N'],
  ["Can you remember my sister's name?", 'N', 'N', 'N'],
  ['Remember that I moved to Toronto?', 'N', 'N', 'N'],
  ['Remember that? That was crazy', 'N', 'N', 'N'],
  ['Remember my gym？', 'N', 'N', 'N'],
  // "can you remember" without "that" (#122 second layer)
  ["Can you remember my sister's name", 'N', 'N', 'N'],
  ['Will you remember my birthday', 'N', 'N', 'N'],
  ['Could you please remember my bike is blue', 'S', 'N', 'N'],
  // to-dos and bare nouns (#90, #137)
  ['Remember the milk', 'S', 'N', 'N'],
  ['Remember my keys', 'S', 'N', 'N'],
  ['Remember last summer', 'S', 'N', 'N'],
  ['Remember I need to pay the rent', 'S', 'N', 'N'],
  ['Can you remember that song from Titanic', 'S', 'N', 'N'],
  ['Remember goodlife', 'N', 'N', 'N'],
  ['Remember to call mom', 'N', 'N', 'N'],
  ['Remember when we went to the lake', 'N', 'N', 'N'],
  ['Do you remember the song from Titanic', 'N', 'N', 'N'],
  ['Play Remember Me', 'N', 'N', 'N'],
  // codes (R5-4)
  ['Remember 4417', 'C', 'C', 'C'],
  // openers without "remember" (R10b-3, R10b-4)
  ["Don't forget my keys", 'N', 'N', 'N'],
  ["Don't forget that my sister is called Anna", 'S', 'S', 'N'],
  ['Note that I am allergic to nuts', 'S', 'S', 'N'],
  ['Note my keys', 'N', 'N', 'N'],
  ['Keep in mind that my flight is at nine', 'S', 'S', 'N'],
  ['Keep in mind my keys', 'N', 'N', 'N'],
];

/** What the real caller of `source` passes to MemoryRouter.route for `phrase`. */
function input(phrase: string, source: MemorySource): { text: string; raw: string } {
  if (source === 'app') return { text: cleanTypedCommand(phrase), raw: phrase.trim() };
  if (source === 'cli') return { text: cleanTypedCommand(phrase), raw: cleanTypedCommand(phrase) };
  const raw = source === 'voice-wake' ? `Hey Stephen, ${phrase}` : phrase;
  return { text: normalizeTranscript(raw, ['hey stephen']).text, raw };
}

async function outcome(phrase: string, source: MemorySource): Promise<Want> {
  const store = new MemoryStore({ home: join(tmp, `h${++n}`) });
  const router = new MemoryRouter({ store, confirmWakeWord: true, confirmer: approve });
  const r = await router.route(input(phrase, source).text, { source, raw: input(phrase, source).raw });
  const saved = (await store.list()).length;
  if (r?.changed && saved === 1) return 'S';
  expect(saved).toBe(0);
  return r?.said?.startsWith('remember [refused') ? 'C' : 'N';
}

describe('#202 H3 one remember guard: the same table for typed and voice', () => {
  it.each(TABLE)('%j: typed %s, voice-ptt %s, voice-wake %s', async (phrase, typed, ptt, wake) => {
    expect({
      app: await outcome(phrase, 'app'),
      cli: await outcome(phrase, 'cli'),
      'voice-ptt': await outcome(phrase, 'voice-ptt'),
      'voice-wake': await outcome(phrase, 'voice-wake'),
    }).toEqual({ app: typed, cli: typed, 'voice-ptt': ptt, 'voice-wake': wake });
  });
});
