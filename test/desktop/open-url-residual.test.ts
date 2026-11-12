/**
 * Plan review item 17 (A4), Q3: a site's own HTTP 302 after open_url cannot be seen by any URL check. What
 * still protects the owner: after a private read, a first-seen host that gets a path, sub-domain, query or
 * fragment asks first. With no private read it does not ask (the residual the owner accepted on 2026-11-12).
 */
import { describe, expect, it } from 'vitest';
import { setupDesktop, textOf } from './fakes.js';

const intent = 'user asked';
const url = 'https://redirector-site.example/go/42';

describe('open_url and a site that redirects by itself (accepted residual, plan review Q3)', () => {
  it('after a private read, a first-seen host asks first, and a decline opens nothing', async () => {
    const h = await setupDesktop();
    h.gate.notePrivateData('gmail');
    h.confirmer.answer = 'declined';
    const r = await h.call('open_url', { url, browser: 'chrome', intent });
    expect(r.isError).toBe(true);
    expect(h.confirmer.prompts).toHaveLength(1);
    expect(h.confirmer.prompts[0]!.body).toContain('redirector-site.example');
    expect(h.mac.opens()).toEqual([]);
    expect(textOf(r)).toBeTruthy();
  });

  it('after a private read, approving the first-seen host opens it, and the host is not asked about again', async () => {
    const h = await setupDesktop();
    h.gate.notePrivateData('gmail');
    expect((await h.call('open_url', { url, browser: 'chrome', intent })).isError).toBeFalsy();
    expect(h.confirmer.prompts).toHaveLength(1);
    expect((await h.call('open_url', { url: `${url}/again`, browser: 'chrome', intent })).isError).toBeFalsy();
    expect(h.confirmer.prompts).toHaveLength(1);
    expect(h.mac.opens()).toHaveLength(2);
  });

  it('with no private read, the same URL does not ask (the accepted residual)', async () => {
    const h = await setupDesktop();
    const r = await h.call('open_url', { url, browser: 'chrome', intent });
    expect(r.isError).toBeFalsy();
    expect(h.confirmer.prompts).toEqual([]);
    expect(h.mac.opens()).toHaveLength(1);
  });
});
