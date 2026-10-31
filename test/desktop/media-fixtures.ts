/**
 * Synthetic YouTube search pages, shaped like the real `ytInitialData` of www.youtube.com/results (2026):
 * contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[].itemSectionRenderer.contents[]
 * holding videoRenderer / adSlotRenderer / reelShelfRenderer / playlistRenderer / channelRenderer… items.
 * (The cloud sandbox cannot reach YouTube, so these are hand-built from the real shape, not recorded.)
 */
import type { FetchFn, MediaFetchInit, MediaResponse } from '../../src/desktop/media.js';

export interface VideoOpts {
  id: string;
  title: string;
  channel?: string;
  length?: string | null;
  live?: boolean;
  short?: boolean;
}

export function video(o: VideoOpts): Record<string, unknown> {
  return {
    videoRenderer: {
      videoId: o.id,
      title: { runs: [{ text: o.title }], accessibility: { accessibilityData: { label: o.title } } },
      ownerText: { runs: [{ text: o.channel ?? 'Some Channel', navigationEndpoint: { browseEndpoint: { browseId: 'UC123' } } }] },
      longBylineText: { runs: [{ text: o.channel ?? 'Some Channel' }] },
      ...(o.length === null || o.live ? {} : { lengthText: { simpleText: o.length ?? '3:15' } }),
      ...(o.live ? { badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW', label: 'LIVE' } }] } : {}),
      navigationEndpoint: o.short
        ? { commandMetadata: { webCommandMetadata: { url: `/shorts/${o.id}` } }, reelWatchEndpoint: { videoId: o.id } }
        : { commandMetadata: { webCommandMetadata: { url: `/watch?v=${o.id}` } }, watchEndpoint: { videoId: o.id } },
      thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: o.live ? 'LIVE' : o.short ? 'SHORTS' : 'DEFAULT' } }],
    },
  };
}

export const AD = {
  adSlotRenderer: {
    fulfillmentContent: {
      fulfilledLayout: { inFeedAdLayoutRenderer: { renderingContent: { videoRenderer: { videoId: 'AdAdAdAdAd1', title: { simpleText: 'Buy now' }, lengthText: { simpleText: '0:30' } } } } },
    },
  },
};

export function shortsShelf(ids: string[]): Record<string, unknown> {
  return { reelShelfRenderer: { title: { simpleText: 'Shorts' }, items: ids.map((id) => video({ id, title: `short ${id}`, short: true })) } };
}

export const PLAYLIST = { playlistRenderer: { playlistId: 'PL123', title: { simpleText: 'Best of' }, videos: [{ childVideoRenderer: { videoId: 'PlPlPlPlPl1' } }] } };
export const CHANNEL = { channelRenderer: { channelId: 'UC999', title: { simpleText: 'Charlie Puth' } } };

export function initialData(items: unknown[]): Record<string, unknown> {
  return {
    responseContext: {},
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [{ itemSectionRenderer: { contents: items } }, { continuationItemRenderer: { trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN' } }],
          },
        },
      },
    },
  };
}

export function page(data: unknown, marker = 'var ytInitialData = '): string {
  return `<!DOCTYPE html><html><head><title>One Call Away - YouTube</title></head><body><script nonce="x">${marker}${JSON.stringify(data)};</script><script>var ytInitialPlayerResponse = {"a":"}"};</script></body></html>`;
}

export const ONE_CALL_AWAY = video({ id: 'BxuY9FET9Y4', title: 'Charlie Puth - One Call Away [Official Video]', channel: 'Charlie Puth', length: '3:15' });

/** A fake fetch: records every call and answers with `body` (string or a chunk list) / `status` / headers. */
export class FakeFetch {
  calls: { url: string; init: MediaFetchInit }[] = [];
  status = 200;
  headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
  body: string | string[] = page(initialData([ONE_CALL_AWAY]));
  /** Never answers (timeout test). */
  hang = false;
  fails: Error | null = null;
  /** Bytes the consumer actually pulled from the stream. */
  pulled = 0;

  fn: FetchFn = async (url, init) => {
    this.calls.push({ url, init });
    if (this.fails) throw this.fails;
    if (this.hang) {
      return new Promise<MediaResponse>((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    const chunks = (Array.isArray(this.body) ? this.body : [this.body]).map((c) => new TextEncoder().encode(c));
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (ctrl) => {
        if (i < chunks.length) {
          this.pulled += chunks[i]!.byteLength;
          ctrl.enqueue(chunks[i++]!);
        } else ctrl.close();
      },
    });
    const headers = this.headers;
    return { status: this.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, body };
  };
}
