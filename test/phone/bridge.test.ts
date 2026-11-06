import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPhoneBridge, phoneRequest } from '../../src/phone/bridge.js';
import { PHONE_JOBS_OFF, PhoneServer } from '../../src/phone/server.js';
import { PHONE_TOOLS, phoneSocketPath } from '../../src/phone/setup.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'spb-')));
const asked: string[] = [];
let server: PhoneServer;

beforeAll(async () => {
  server = new PhoneServer({
    home: tmp,
    isOn: () => true,
    ask: (t) => (asked.push(t), Promise.resolve(`Stephen: ${t}`)),
    jobStatus: async () => 'No jobs.',
    audit: null,
    notify: () => undefined,
  });
  await server.start();
});
afterAll(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function client(socketPath = phoneSocketPath(tmp)) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildPhoneBridge(socketPath, 5_000).connect(a);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(b);
  return c;
}
const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text: string }[])[0]!.text;

describe('stephen phone-bridge', () => {
  it('exactly the three tools the phone folder allows; only start_job requires the owner every time', async () => {
    const { tools } = await (await client()).listTools();
    expect(tools.map((t) => `mcp__stephen_phone__${t.name}`).sort()).toEqual([...PHONE_TOOLS].sort());
    const meta = Object.fromEntries(tools.map((t) => [t.name, t._meta ?? {}]));
    expect(meta).toEqual({ ask: {}, job_status: {}, start_job: { 'anthropic/requiresUserInteraction': true } });
  });

  it('calls go through phone.sock: replies, refusals as tool errors', async () => {
    const c = await client();
    const ask = await c.callTool({ name: 'ask', arguments: { text: "what's my day" } });
    expect(ask.isError).toBeFalsy();
    expect(text(ask)).toBe("Stephen: what's my day");
    expect(asked).toEqual(["what's my day"]);
    expect(text(await c.callTool({ name: 'job_status', arguments: {} }))).toBe('No jobs.');
    const job = await c.callTool({ name: 'start_job', arguments: { task: 'write a poem' } });
    expect(job.isError).toBe(true);
    expect(text(job)).toBe(PHONE_JOBS_OFF);
  });

  it('the listener not running: a clear tool error, nothing else tried', async () => {
    const r = await (await client(join(tmp, 'run', 'nobody.sock'))).callTool({ name: 'ask', arguments: { text: 'hi' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/isn't running on the Mac/);
  });

  it('phoneRequest times out instead of hanging', async () => {
    const slow = new PhoneServer({ home: join(tmp, 'slow'), isOn: () => true, ask: () => new Promise(() => undefined), audit: null, notify: () => undefined });
    await slow.start();
    try {
      expect(await phoneRequest(phoneSocketPath(join(tmp, 'slow')), { id: '1', type: 'ask', text: 'hi' }, 200)).toEqual({ type: 'error', message: 'Stephen took too long to answer.' });
    } finally {
      await slow.close();
    }
  });
});
