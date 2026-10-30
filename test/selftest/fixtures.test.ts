import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../src/selftest/fixtures.js';

function http(url: string, opts: { method?: string; host?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers: { host: opts.host ?? u.host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('selftest fixture server', () => {
  let fx: FixtureServer | undefined;
  afterEach(async () => {
    await fx?.close();
    fx = undefined;
  });

  it('serves two loopback origins and records submissions and page hits', async () => {
    fx = await startFixtureServer();
    expect(fx.a).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(fx.b).toMatch(/^http:\/\/localhost:\d+$/);
    const form = await http(`${fx.a}/form`);
    expect(form.status).toBe(200);
    expect(form.body).toContain('<button type="submit">Send</button>');
    const frames = await http(`${fx.a}/frames`);
    expect(frames.body).toContain(`src="${fx.b}/frame-child"`);
    expect((await http(`${fx.b}/frame-child`)).body).toContain('Frame button');

    const waiting = fx.waitForHit('frame-button', 2000);
    expect((await http(`${fx.b}/hit?what=frame-button`, { method: 'POST' })).status).toBe(204);
    expect(await waiting).toBe(true);
    expect(await fx.waitForHit('never', 20)).toBe(false);

    await http(`${fx.a}/submit`, { method: 'POST', body: 'fullname=Ada' });
    expect(fx.submissions()).toEqual(['fullname=Ada']);
    expect(fx.hits()).toEqual(['frame-button']);
  });

  it('only answers requests addressed to its own origins', async () => {
    fx = await startFixtureServer();
    expect((await http(`${fx.a}/form`, { host: 'evil.example' })).status).toBe(421);
    expect((await http(`${fx.a}/nope`)).status).toBe(404);
  });
});
