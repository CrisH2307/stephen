/**
 * media_control on a browser tab (PLAN-1.9 section 12.5: "YouTube Music first, then expand").
 *
 *  - findMediaTabs: the YouTube Music tabs (music.youtube.com, any page: its player bar stays on every page),
 *    then the YouTube watch tabs (youtube.com/watch), of the browsers Stephen is attached to. Same ordering and
 *    exclusions as tab reuse (src/server/tab-reuse.ts): the current / most recently used tab first, never a tab
 *    with a pending dialog, only https pages.
 *  - TabMediaControl.run: reads the player's Play/Pause button with the page engine (a gated read, like
 *    play_media's ensurePlaying), then acts through hub.action (gate check, identity / focus re-check, audit):
 *    play / pause / toggle click the player's own Play or Pause button when exactly one is found, else press the
 *    site's shortcut; next / previous press the shortcut, or click the Next / Previous button when focus is in a
 *    text field (where the key would type). The tab is not brought to the front.
 *
 * Keyboard shortcuts:
 *  - youtube.com: k = play/pause, Shift+N = next video, Shift+P = previous video (in a playlist). Source: Google's
 *    "Keyboard shortcuts for YouTube" help page (support.google.com/youtube/answer/7631406). High confidence.
 *  - music.youtube.com: Space = play/pause, j = next song, k = previous song (NOT play/pause as on YouTube).
 *    Source: YouTube Music's own shortcut list (press "?" on music.youtube.com) as reported by third-party write-ups
 *    (e.g. blog.chaitanyashahare.com, "YouTube Music with Vim-like keybindings"); Google has no help page for it.
 *    Medium confidence: check on the real Mac (docs/DESKTOP.md). Space is only pressed when no element has focus,
 *    because Space on a focused button or link activates THAT element instead.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'puppeteer-core';
import { clean } from '../safety/text.js';
import type { Hub } from '../server/hub.js';
import { siteKey } from '../server/tab-reuse.js';
import { NoticeError } from '../server/util.js';
import type { BrowserName, FindMatch, IBrowserManager, TabId, TabInfo } from '../types.js';
import { PAUSE_RE, PLAY_RE } from './play.js';
import type { MediaAction } from './sound.js';

const TOOL = 'media_control';

export type MediaSite = 'youtube_music' | 'youtube';
export const MEDIA_SITE_LABEL: Record<MediaSite, string> = { youtube_music: 'YouTube Music', youtube: 'YouTube' };

/** The site's keyboard shortcuts (sources and confidence in the header comment). */
export const MEDIA_KEYS: Record<MediaSite, Record<'toggle' | 'next' | 'previous', string>> = {
  youtube_music: { toggle: 'Space', next: 'j', previous: 'k' },
  youtube: { toggle: 'k', next: 'Shift+N', previous: 'Shift+P' },
};

/**
 * Player-bar button names. YouTube Music: "Next" / "Previous" (maybe "Next song"); YouTube: "Next (SHIFT+n)" or
 * "Next keyboard shortcut SHIFT+n", "Previous (SHIFT+p)". Exact matches only, so shelf arrows and "Play all" don't count.
 */
const NEXT_RE = /^next(?:\s+(?:song|track|video))?(?:\s*\(shift\s*\+\s*n\)|\s+keyboard shortcut shift\s*\+\s*n)?$/i;
const PREVIOUS_RE = /^previous(?:\s+(?:song|track|video))?(?:\s*\(shift\s*\+\s*p\)|\s+keyboard shortcut shift\s*\+\s*p)?$/i;

export interface MediaTab {
  tab: TabInfo;
  site: MediaSite;
}

/** youtube_music for any music.youtube.com page, youtube for a youtube.com watch page, else null. */
export function mediaSiteOf(url: string): MediaSite | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const key = siteKey(url);
  if (key === 'music.youtube.com') return 'youtube_music';
  if (key === 'youtube.com' && u.pathname === '/watch') return 'youtube';
  return null;
}

/**
 * Media tabs of `browsers` (already attached; listed in this order), YouTube Music before YouTube; within each,
 * the current / most recently used tab first. Never throws: a browser that can't list its tabs has none.
 */
export async function findMediaTabs(
  manager: Pick<IBrowserManager, 'listTabs'>,
  browsers: BrowserName[],
  hasDialog: (tab: TabId) => boolean = () => false,
): Promise<MediaTab[]> {
  const found: MediaTab[] = [];
  for (const browser of browsers) {
    let tabs: TabInfo[];
    try {
      tabs = await manager.listTabs(browser, false);
    } catch {
      continue;
    }
    const ordered = tabs
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.browser === browser && !hasDialog(t.id))
      .sort((a, b) => Number(b.t.current) - Number(a.t.current) || (b.t.lastUsed ?? 0) - (a.t.lastUsed ?? 0) || b.i - a.i);
    for (const { t } of ordered) {
      const site = mediaSiteOf(t.url);
      if (site) found.push({ tab: t, site });
    }
  }
  const rank: Record<MediaSite, number> = { youtube_music: 0, youtube: 1 };
  return found.sort((a, b) => rank[a.site] - rank[b.site]); // stable: browser and recency order kept
}

type PlayState = 'playing' | 'paused' | 'unknown';

interface PlayerRead {
  state: PlayState;
  /** The one exact Play / Pause / Next / Previous button, when there is exactly one. */
  pauseRef?: string;
  playRef?: string;
  nextRef?: string;
  previousRef?: string;
}

/** The single match for `re` among buttons, or undefined when there is none or more than one (ambiguous). */
function onlyButton(matches: FindMatch[], re: RegExp): string | undefined {
  const hits = matches.filter((m) => m.role === 'button' && re.test(m.name.trim()));
  return hits.length === 1 ? hits[0]!.ref : undefined;
}

/** What run() did, for the tool result. `skipped` = pause on a tab that is not playing (nothing done there). */
export type TabOutcome = { done: true; result: CallToolResult; tab: TabId; site: MediaSite } | { done: false; skipped: 'not playing'; tab: TabId; site: MediaSite };

export class TabMediaControl {
  constructor(
    private readonly hub: Hub,
    private readonly pollMs: number,
  ) {}

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** The player's buttons (a gated read through the page engine; never a click). */
  async read(tab: TabId, page: Page, action: MediaAction): Promise<PlayerRead> {
    const hub = this.hub;
    return hub.withTab(tab, 'read', async () => {
      hub.assertNoDialog(tab);
      const ticket = await hub.gateRead(TOOL, tab, page);
      const find = (q: string) => hub.guarded(tab, () => hub.engine.find(page, tab, q, 10), 'find');
      const pauseRef = onlyButton(await find('pause'), PAUSE_RE);
      const playRef = pauseRef ? undefined : onlyButton(await find('play'), PLAY_RE);
      const out: PlayerRead = { state: pauseRef ? 'playing' : playRef ? 'paused' : 'unknown', pauseRef, playRef };
      if (action === 'next') out.nextRef = onlyButton(await find('next'), NEXT_RE);
      if (action === 'previous') out.previousRef = onlyButton(await find('previous'), PREVIOUS_RE);
      await hub.noteReads(tab, page, ticket);
      return out;
    });
  }

  /**
   * Run `action` on the media tab. Returns skipped for pause on a tab that is not playing (the caller tries the
   * next tab or app). Throws NoticeError (gate denials, nothing to press) with an honest message.
   */
  async run(mt: MediaTab, page: Page, action: MediaAction, intent: string): Promise<TabOutcome> {
    const { site } = mt;
    const tab = mt.tab.id;
    const label = MEDIA_SITE_LABEL[site];
    const before = await this.read(tab, page, action);

    if (action === 'pause' && before.state === 'paused') return { done: false, skipped: 'not playing', tab, site };
    if (action === 'play' && before.state === 'playing') {
      await this.hub.audit({ tool: TOOL, tab, args: { action, site, state: 'playing' }, outcome: 'ok', intent: clean(intent, 200) });
      return { done: true, tab, site, result: { content: [{ type: 'text', text: `${label} is already playing (tab ${tab}); nothing pressed.` }] } };
    }

    // play/pause/toggle: the player's own button (whichever exists says the state); next/previous: the shortcut.
    const isSkip = action === 'next' || action === 'previous';
    const ref = isSkip ? (action === 'next' ? before.nextRef : before.previousRef) : (before.pauseRef ?? before.playRef);
    const key = MEDIA_KEYS[site][isSkip ? action : 'toggle'];
    await this.press(tab, page, intent, { ref, key, preferClick: !isSkip, keyNeedsNoFocus: key === 'Space', action, site });

    let text: string;
    if (isSkip) {
      text = action === 'next' ? `Skipped to the next track on ${label}` : `Went back to the previous track on ${label}`;
    } else {
      await this.sleep(this.pollMs);
      const after = await this.read(tab, page, action).catch((): PlayerRead => ({ state: 'unknown' }));
      if (after.state === 'paused') text = `Paused ${label}`;
      else if (after.state === 'playing') text = before.state === 'playing' ? `Pressed pause on ${label}, but it still looks like it is playing` : `Playing ${label}`;
      else text = `Pressed play/pause on ${label} (Stephen couldn't see the player's button to confirm)`;
    }
    return { done: true, tab, site, result: { content: [{ type: 'text', text: `${text} (tab ${tab}).` }] } };
  }

  /** Click `ref` or press `key` through hub.action: never types into a text field, never Space onto a focused control. */
  private async press(
    tab: TabId,
    page: Page,
    intent: string,
    o: { ref?: string; key: string; preferClick: boolean; keyNeedsNoFocus: boolean; action: MediaAction; site: MediaSite },
  ): Promise<void> {
    const hub = this.hub;
    const res = await hub.withTab(tab, 'write', async () => {
      hub.assertNoDialog(tab);
      const focus = await hub.focusState(tab, page);
      const typing = focus.focus === 'unknown' || (focus.focus === 'element' && focus.element?.isEditable === true);
      const keyOk = !typing && (!o.keyNeedsNoFocus || focus.focus === 'none');
      if (o.ref && (o.preferClick || !keyOk)) {
        const ref = o.ref;
        const el = await hub.describe(tab, page, ref);
        return hub.action({
          tool: TOOL,
          kind: 'click',
          tab,
          page,
          intent,
          ref,
          element: el,
          auditArgs: { action: o.action, site: o.site, via: 'player button' },
          run: () => hub.engine.click(page, ref),
          done: `Clicked the player's ${o.action} button (${ref})`,
        });
      }
      if (!keyOk) {
        throw new NoticeError(
          `Nothing pressed on ${MEDIA_SITE_LABEL[o.site]} (tab ${tab}): ${typing ? 'keyboard focus is in a text field, where the shortcut would type' : 'an element on the page has keyboard focus, and Space would activate it'}, ` +
            "and Stephen couldn't find the player's button. Ask the user to click the player, or use the browser tools (find, then click).",
        );
      }
      return hub.action({
        tool: TOOL,
        kind: 'press',
        tab,
        page,
        intent,
        key: o.key,
        focus: focus.focus,
        ...(focus.element ? { element: focus.element } : {}),
        auditArgs: { key: o.key, action: o.action, site: o.site },
        verify: () => hub.recheckFocus(tab, page, focus),
        run: () => hub.engine.pressKey(page, o.key),
        done: `Pressed ${o.key} (${o.action})`,
      });
    });
    if (res.isError) throw new NoticeError(`Couldn't ${o.action} ${MEDIA_SITE_LABEL[o.site]} in tab ${tab}: the ${o.ref ? 'click' : 'key press'} did not go through.`);
  }
}
