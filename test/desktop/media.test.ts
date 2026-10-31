/** play_media's resolver (src/desktop/media.ts): fetch rules, size cap, timeout, ytInitialData parsing and picking. */
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_UA,
  extractInitialData,
  isAllowedFetchUrl,
  MEDIA_MAX_BYTES,
  pickVideo,
  ResolveError,
  resolveYouTube,
  searchPageUrl,
  searchUrl,
  watchUrl,
} from '../../src/desktop/media.js';
import { AD, CHANNEL, FakeFetch, initialData, ONE_CALL_AWAY, page, PLAYLIST, shortsShelf, video } from './media-fixtures.js';

describe('the one URL play_media fetches', () => {
  it('is www.youtube.com/results with only search_query, GET, no cookies, no redirects, a desktop UA', async () => {
    const f = new FakeFetch();
    const hit = await resolveYouTube('One Call Away Charlie Puth', f.fn);
    expect(hit).toEqual({ videoId: 'BxuY9FET9Y4', title: 'Charlie Puth - One Call Away [Official Video]', channel: 'Charlie Puth', duration: '3:15', kind: 'video' });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe('https://www.youtube.com/results?search_query=One+Call+Away+Charlie+Puth');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
    expect(init.headers['User-Agent']).toBe(DESKTOP_UA);
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain('cookie');
  });

  it('query text cannot change the host or path (it is one encoded parameter)', () => {
    for (const q of ['https://evil.example/x', '../../account?x=1#frag', 'a&search_query=b&next=https://evil.example', '@evil.example']) {
      const u = new URL(searchUrl(q));
      expect(u.host).toBe('www.youtube.com');
      expect(u.pathname).toBe('/results');
      expect([...u.searchParams.keys()]).toEqual(['search_query']);
      expect(u.searchParams.get('search_query')).toBe(q);
      expect(isAllowedFetchUrl(u.href)).toBe(true);
    }
    expect(isAllowedFetchUrl('https://www.youtube.com/watch?v=BxuY9FET9Y4')).toBe(false);
    expect(isAllowedFetchUrl('https://music.youtube.com/results?search_query=x')).toBe(false);
    expect(isAllowedFetchUrl('http://www.youtube.com/results?search_query=x')).toBe(false);
    expect(isAllowedFetchUrl('https://www.youtube.com/results?search_query=x&sp=y')).toBe(false);
  });

  it('a redirect (e.g. to consent.youtube.com) is not followed', async () => {
    const f = new FakeFetch();
    f.status = 302;
    f.headers.location = 'https://consent.youtube.com/m?continue=…';
    await expect(resolveYouTube('x', f.fn)).rejects.toMatchObject({ reason: 'redirect' });
    expect(f.calls).toHaveLength(1);
  });

  it('a non-200 answer or a network failure is a ResolveError', async () => {
    const f = new FakeFetch();
    f.status = 429;
    await expect(resolveYouTube('x', f.fn)).rejects.toMatchObject({ reason: 'http' });
    f.status = 200;
    f.fails = new Error('ECONNRESET');
    await expect(resolveYouTube('x', f.fn)).rejects.toMatchObject({ reason: 'network' });
  });

  it('times out (and aborts the request)', async () => {
    const f = new FakeFetch();
    f.hang = true;
    const t = Date.now();
    await expect(resolveYouTube('x', f.fn, { timeoutMs: 50 })).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(f.calls[0]!.init.signal.aborted).toBe(true);
  });

  it('an oversized page is refused: by content-length up front, or while streaming (stops reading)', async () => {
    const f = new FakeFetch();
    f.headers['content-length'] = String(MEDIA_MAX_BYTES + 1);
    await expect(resolveYouTube('x', f.fn)).rejects.toMatchObject({ reason: 'too-large' });
    expect(f.pulled).toBeLessThan(2000); // at most the stream's first eager chunk, never the body

    const g = new FakeFetch();
    const chunk = 'x'.repeat(1024 * 1024);
    g.body = Array.from({ length: 10 }, () => chunk);
    await expect(resolveYouTube('x', g.fn)).rejects.toMatchObject({ reason: 'too-large' });
    expect(g.pulled).toBeLessThanOrEqual(5 * 1024 * 1024); // stopped after ~3 MB (+ one prefetched chunk), not all 10 MB
  });
});

describe('picking the video', () => {
  const pick = (items: unknown[]) => pickVideo(extractInitialData(page(initialData(items))));

  it('normal result', () => {
    expect(pick([ONE_CALL_AWAY, video({ id: 'zzzzzzzzzzz', title: 'cover' })]).videoId).toBe('BxuY9FET9Y4');
  });

  it('skips an ad, a shorts shelf, a playlist and a channel before the first real video', () => {
    expect(pick([AD, shortsShelf(['ShortShort1', 'ShortShort2']), PLAYLIST, CHANNEL, ONE_CALL_AWAY]).videoId).toBe('BxuY9FET9Y4');
  });

  it('skips shorts and live streams listed as plain videoRenderers', () => {
    const items = [video({ id: 'ShortShort1', title: 's', short: true }), video({ id: 'LiveLiveLiv', title: 'live', live: true }), ONE_CALL_AWAY];
    expect(pick(items).videoId).toBe('BxuY9FET9Y4');
  });

  it('falls back to a live stream, then a short, when nothing else matches', () => {
    expect(pick([video({ id: 'ShortShort1', title: 's', short: true }), video({ id: 'LiveLiveLiv', title: 'live', live: true })])).toMatchObject({ videoId: 'LiveLiveLiv', kind: 'live' });
    expect(pick([shortsShelf(['ShortShort1'])])).toMatchObject({ videoId: 'ShortShort1', kind: 'short' });
  });

  it('a video inside a shelf is used only when there is no top-level video', () => {
    const shelf = { shelfRenderer: { content: { verticalListRenderer: { items: [video({ id: 'ShelfVideo1', title: 'in shelf' })] } } } };
    expect(pick([shelf, ONE_CALL_AWAY]).videoId).toBe('BxuY9FET9Y4');
    expect(pick([shelf]).videoId).toBe('ShelfVideo1');
  });

  it('never picks the video inside an ad slot', () => {
    expect(() => pick([AD])).toThrow(ResolveError);
  });

  it('no results', () => {
    expect(() => pick([])).toThrow(/no playable video/);
  });

  it('a video id that is not 11 safe characters is skipped', () => {
    const bad = [
      video({ id: 'short', title: 'too short' }),
      video({ id: 'BxuY9FET9Y4X', title: 'too long' }),
      video({ id: 'abc/../x?y=', title: 'path chars' }),
      video({ id: 'abc def ghi', title: 'spaces' }),
    ];
    expect(() => pick(bad)).toThrow(/no playable video/);
    expect(pick([...bad, ONE_CALL_AWAY]).videoId).toBe('BxuY9FET9Y4');
    expect(() => watchUrl('abc/../x?y=', 'youtube')).toThrow();
  });

  it('malformed pages', () => {
    expect(() => extractInitialData('<html>no data here</html>')).toThrow(expect.objectContaining({ reason: 'no-data' }));
    expect(() => extractInitialData('<script>var ytInitialData = {"contents": {"a": [1, 2</script>')).toThrow(expect.objectContaining({ reason: 'malformed' }));
    expect(() => extractInitialData('<script>var ytInitialData = {"a": nope};</script>')).toThrow(expect.objectContaining({ reason: 'malformed' }));
    expect(() => extractInitialData("<script>var ytInitialData = '\\x7b\\x22a';</script>")).toThrow(expect.objectContaining({ reason: 'no-data' }));
    expect(() => pickVideo([1, 2])).toThrow(ResolveError);
  });

  it('braces and quotes inside strings do not end the JSON early; window["ytInitialData"] works too', () => {
    const tricky = video({ id: 'BxuY9FET9Y4', title: 'a } b { "c" \\ d </script>' });
    const html = page(initialData([tricky]), 'window["ytInitialData"] = ');
    expect(pickVideo(extractInitialData(html)).title).toBe('a } b { "c" \\ d </script>');
  });

  it('end to end through the fake fetch (fixtures: ad first, no results, malformed)', async () => {
    const f = new FakeFetch();
    f.body = page(initialData([AD, ONE_CALL_AWAY]));
    expect((await resolveYouTube('q', f.fn)).videoId).toBe('BxuY9FET9Y4');
    f.body = page(initialData([]));
    await expect(resolveYouTube('q', f.fn)).rejects.toMatchObject({ reason: 'no-results' });
    f.body = '<html><body>Before you continue to YouTube</body></html>';
    await expect(resolveYouTube('q', f.fn)).rejects.toMatchObject({ reason: 'no-data' });
  });
});

describe('URLs opened', () => {
  it('watch and search URLs for both services', () => {
    expect(watchUrl('BxuY9FET9Y4', 'youtube')).toBe('https://www.youtube.com/watch?v=BxuY9FET9Y4');
    expect(watchUrl('BxuY9FET9Y4', 'youtube_music')).toBe('https://music.youtube.com/watch?v=BxuY9FET9Y4');
    expect(searchPageUrl('one call away', 'youtube')).toBe('https://www.youtube.com/results?search_query=one+call+away');
    expect(searchPageUrl('one call away', 'youtube_music')).toBe('https://music.youtube.com/search?q=one+call+away');
  });
});
