import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_WAKE_PHRASES } from '../../src/voice/config.js';
import { stopStartsWithBareWake, writeKeywordsFile } from '../../src/voice/engine.js';
import { describe, expect, it } from 'vitest';
import {
  buildKeywordsFile,
  createEncoder,
  parseTokens,
  phraseVariants,
  readSentencePieceModel,
  type PieceEncoder,
} from '../../src/voice/keywords.js';
import { KWS_MODEL, modelPaths } from '../../src/voice/models.js';
import { FIXTURES, prepareKwsModel } from './helpers.js';

describe('keyword file generation (no model)', () => {
  const fakeEncoder: PieceEncoder = {
    encode: (t) => t.split(' ').flatMap((w) => [`▁${w.slice(0, 2)}`, ...(w.length > 2 ? [w.slice(2)] : [])]),
  };
  const tokens = new Set(['▁HE', 'Y', '▁ST', 'EPHEN', 'EVEN', 'OP']);

  it('adds same-sounding spellings', () => {
    expect(phraseVariants('hey stephen')).toEqual(['hey stephen', 'hey steven']);
    expect(phraseVariants('stephen stop')).toEqual(['stephen stop', 'steven stop']);
    expect(phraseVariants('hey computer')).toEqual(['hey computer']);
    expect(phraseVariants('stephen')).toEqual(['stephen', 'steven']);
    expect(phraseVariants('ok stephen')).toEqual(['ok stephen', 'ok steven', 'okay stephen', 'okay steven']);
  });

  it('writes one line per spelling with boost, threshold and id', () => {
    const text = buildKeywordsFile(
      [
        { id: 'WAKE', phrase: 'hey stephen', threshold: 0.3, score: 1 },
        { id: 'STOP', phrase: 'stephen stop', threshold: 0.25, score: 1.5 },
      ],
      fakeEncoder,
      tokens,
    );
    expect(text).toBe(
      ['▁HE Y ▁ST EPHEN :1 #0.3 @WAKE', '▁HE Y ▁ST EVEN :1 #0.3 @WAKE', '▁ST EPHEN ▁ST OP :1.5 #0.25 @STOP', '▁ST EVEN ▁ST OP :1.5 #0.25 @STOP', ''].join('\n'),
    );
  });

  it('drops a spelling another phrase already produced (first one wins)', () => {
    const text = buildKeywordsFile(
      [
        { id: 'WAKE', phrase: 'hey stephen', threshold: 0.3, score: 1 },
        { id: 'WAKE', phrase: 'hey steven', threshold: 0.4, score: 1 },
      ],
      fakeEncoder,
      tokens,
    );
    expect(text).toBe(['▁HE Y ▁ST EPHEN :1 #0.3 @WAKE', '▁HE Y ▁ST EVEN :1 #0.3 @WAKE', ''].join('\n'));
  });

  it('refuses a phrase the model has no units for', () => {
    expect(() => buildKeywordsFile([{ id: 'WAKE', phrase: 'hey jarvis', threshold: 0.3, score: 1 }], fakeEncoder, tokens)).toThrow(
      /"hey jarvis" can't be used as a keyword: the wake-word model has no unit for "▁JA"/,
    );
  });

  it('knows when the stop phrase starts with a bare wake word (the spotter then double-checks for it)', () => {
    expect(stopStartsWithBareWake(['hey stephen', 'stephen'], 'stephen stop')).toBe(true);
    expect(stopStartsWithBareWake(['stephen'], 'steven stop')).toBe(true);
    expect(stopStartsWithBareWake(['hey stephen', 'yo stephen'], 'stephen stop')).toBe(false);
    expect(stopStartsWithBareWake(['computer'], 'stephen stop')).toBe(false);
  });

  it('parses tokens.txt', () => {
    expect(parseTokens('<blk> 0\n▁HE 1\nY 2\n\n')).toEqual(new Set(['<blk>', '▁HE', 'Y']));
  });
});

const models = await prepareKwsModel();

describe.skipIf(!models.ok)('keyword tokenizer vs Python sentencepiece (needs the KWS model)', () => {
  const root = models.ok ? models.root : '';
  const dir = join(root, KWS_MODEL.dir);

  it('reads the model (icefall "bpe.model" is a unigram sentencepiece model)', () => {
    const m = readSentencePieceModel(readFileSync(join(dir, 'bpe.model')));
    expect(m.type).toBe('unigram');
    expect(m.pieces.length).toBe(500);
  });

  it('matches sentencepiece on ~340 phrases (reference generated with Python sentencepiece)', () => {
    const enc = createEncoder(readSentencePieceModel(readFileSync(join(dir, 'bpe.model'))));
    const ref = JSON.parse(readFileSync(join(FIXTURES, 'bpe-reference.json'), 'utf8')) as Record<string, string[]>;
    const mismatches = Object.entries(ref).filter(([text, want]) => enc.encode(text).join(' ') !== want.join(' '));
    expect(Object.keys(ref).length).toBeGreaterThan(300);
    expect(mismatches).toEqual([]);
    expect(enc.encode('HEY STEPHEN')).toEqual(['▁HE', 'Y', '▁ST', 'E', 'PH', 'EN']);
  });

  it('builds the default keywords file (matches the model’s own keywords.txt format)', () => {
    const enc = createEncoder(readSentencePieceModel(readFileSync(join(dir, 'bpe.model'))));
    const tokens = parseTokens(readFileSync(join(dir, 'tokens.txt'), 'utf8'));
    const text = buildKeywordsFile(
      [
        { id: 'WAKE', phrase: 'hey stephen', threshold: 0.3, score: 1 },
        { id: 'STOP', phrase: 'stephen stop', threshold: 0.3, score: 1 },
      ],
      enc,
      tokens,
    );
    expect(text.trim().split('\n')).toEqual([
      '▁HE Y ▁ST E PH EN :1 #0.3 @WAKE',
      '▁HE Y ▁ST E VE N :1 #0.3 @WAKE',
      '▁ST E PH EN ▁ST O P :1 #0.3 @STOP',
      '▁ST E VE N ▁ST O P :1 #0.3 @STOP',
    ]);
  });

  it('builds the keywords for the default wake variants (bare "stephen" gets its own id and threshold)', () => {
    const paths = modelPaths(root, 'whisper-tiny.en');
    const workDir = mkdtempSync(join(tmpdir(), 'stephen-kw-'));
    try {
      const { text } = writeKeywordsFile(paths, {
        wakePhrases: [...DEFAULT_WAKE_PHRASES],
        stopPhrase: 'stephen stop',
        threshold: 0.3,
        bareThreshold: 0.45,
        score: 1,
        workDir,
      });
      expect(text.trim().split('\n')).toEqual([
        '▁ST E PH EN ▁ST O P :1 #0.3 @STOP',
        '▁ST E VE N ▁ST O P :1 #0.3 @STOP',
        '▁HE Y ▁ST E PH EN :1 #0.3 @WAKE',
        '▁HE Y ▁ST E VE N :1 #0.3 @WAKE',
        '▁ Y O ▁ST E PH EN :1 #0.3 @WAKE',
        '▁ Y O ▁ST E VE N :1 #0.3 @WAKE',
        '▁O K ▁ST E PH EN :1 #0.3 @WAKE',
        '▁O K ▁ST E VE N :1 #0.3 @WAKE',
        '▁OKAY ▁ST E PH EN :1 #0.3 @WAKE',
        '▁OKAY ▁ST E VE N :1 #0.3 @WAKE',
        '▁ST E PH EN :1 #0.45 @WAKE_BARE',
        '▁ST E VE N :1 #0.45 @WAKE_BARE',
      ]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
