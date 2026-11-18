import { afterEach } from 'vitest';
import { takePlayed } from './helpers/no-sound.js';

// Vitest setupFile: a test that played sound fails, by name (see test/helpers/no-sound.ts).
afterEach(() => {
  const played = takePlayed();
  if (played.length) {
    throw new Error(`This test played sound on the Mac: ${played.join(' | ')}. Pass a fake speaker and chimes (RecordingSpeaker, RecordingChimes).`);
  }
});
