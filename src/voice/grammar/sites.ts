/**
 * Code-owned site list for the command-grammar classifier (src/voice/grammar/classify.ts).
 *
 * Until the owner can write aliases, the classifier needs the few sites Stephen's own tools already know, or it
 * labels every "open youtube" and "play ... on youtube" Tier 2 (Review 10b, R10b-6). These names are fixed in code:
 * they are not read from a page, a tab title or memory, so a page cannot name itself into the list.
 * Only the media sites play_media and media_control handle (src/desktop/play.ts, media-tab.ts) are here.
 * ponytail: two entries by hand; when owner aliases exist, merge them over this list (the owner's entry wins).
 */
import type { OwnerLists } from './classify.js';

export const BUILTIN_SITES: Readonly<Record<string, string>> = {
  youtube: 'https://www.youtube.com',
  'youtube music': 'https://music.youtube.com',
};

/** "play <query>" with no site named goes to YouTube Music (owner constraint 3: YouTube Music first). */
export const BUILTIN_DEFAULT_MEDIA = 'youtube music';

/** The lists to hand to classify(): installed apps from the Mac, plus the built-in sites. */
export function builtinLists(apps: readonly string[]): OwnerLists {
  return { apps, sites: BUILTIN_SITES, defaultMedia: BUILTIN_DEFAULT_MEDIA };
}
