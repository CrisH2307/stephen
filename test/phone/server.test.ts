import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PHONE_ASKS_PER_MIN,
  PHONE_BUSY_MESSAGE,
  PHONE_JOBS_OFF,
  PHONE_OFF_MESSAGE,
  PhoneServer,
  phoneSocketPath,
  type PhoneServerOptions,
} from '../../src/phone/server.js';
import { phoneOnPath } from '../../src/phone/setup.js';
import { FakeAudit } from '../jobs/helpers.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sph-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function setup(o: Partial<PhoneServerOptions> = {}) {
  let on = true;
  const asked: string[] = [];
  const notes: string[] = [];
  const audit = new FakeAudit();
  const clock = { t: 1_000_000 };
  const server = new PhoneServer({
    home: tmp,
    isOn: () => on,
    ask: (text) => {
      asked.push(text);
      return Promise.resolve(`reply to ${text}`);
    },
    audit,
    notify: (_t, b) => notes.push(b),
    now: () => clock.t,
    ...o,
  });
  const req = (r: object) => server.handle(JSON.stringify(r));
  return { server, req, asked, notes, audit, clock, setOn: (v: boolean) => (on = v) };
}

describe('PhoneServer requests', () => {
  it('ask runs the cleaned text and returns the reply; audited by size only; a notice on the Mac', async () => {
    const t = setup();
    expect(await t.req({ id: '1', type: 'ask', text: '  what\u0007s my   day ' })).toEqual({ id: '1', type: 'reply', text: 'reply to what s my day' });
    expect(t.asked).toEqual(['what s my day']);
    expect(t.notes).toEqual(['From your phone: "what s my day"']);
    expect(t.audit.entries).toEqual([{ tool: 'phone.ask', args: { chars: '  what\u0007s my   day '.length }, outcome: 'ok', intent: 'request from the phone (Remote Control)' }]);
    expect(JSON.stringify(t.audit.entries)).not.toContain('day');
  });

  it('the kill switch: off refuses everything, nothing runs', async () => {
    const t = setup();
    t.setOn(false);
    for (const r of [{ id: 'a', type: 'ask', text: 'hi' }, { id: 'b', type: 'job_status' }, { id: 'c', type: 'start_job', task: 'x' }]) {
      expect(await t.req(r)).toEqual({ id: r.id, type: 'error', message: PHONE_OFF_MESSAGE });
    }
    expect(t.asked).toEqual([]);
    expect(t.audit.entries.map((e) => e.outcome)).toEqual(['denied', 'denied', 'denied']);
  });

  it('busy: refused, not queued', async () => {
    const t = setup({ ask: () => null });
    expect(await t.req({ id: '1', type: 'ask', text: 'hi' })).toEqual({ id: '1', type: 'error', message: PHONE_BUSY_MESSAGE });
  });

  it(`at most ${PHONE_ASKS_PER_MIN} asks a minute`, async () => {
    const t = setup();
    for (let i = 0; i < PHONE_ASKS_PER_MIN; i++) expect((await t.req({ id: `${i}`, type: 'ask', text: 'hi' })).type).toBe('reply');
    expect(await t.req({ id: 'x', type: 'ask', text: 'hi' })).toMatchObject({ type: 'error', message: expect.stringMatching(/Too many requests/) });
    t.clock.t += 60_001;
    expect((await t.req({ id: 'y', type: 'ask', text: 'hi' })).type).toBe('reply');
  });

  it('start_job passes the task and the web flag through; a notice on the Mac', async () => {
    const started: [string, boolean][] = [];
    const t = setup({ startJob: async (task, web) => (started.push([task, web]), { ok: true, text: 'Job started.' }) });
    expect(await t.req({ id: '1', type: 'start_job', task: 'write a poem about rivers' })).toEqual({ id: '1', type: 'reply', text: 'Job started.' });
    expect(await t.req({ id: '2', type: 'start_job', task: 'research rivers', web: true })).toMatchObject({ type: 'reply' });
    expect(started).toEqual([['write a poem about rivers', false], ['research rivers', true]]);
    expect(t.notes[0]).toBe('Job requested from your phone: "write a poem about rivers"');
  });

  it('R8-4: a refused start_job is an error to the phone and audited denied, never ok; ask is audited after it ran', async () => {
    const t = setup({ startJob: async () => ({ ok: false, text: '2 jobs are already running.' }), ask: () => Promise.reject(new Error('boom')) });
    expect(await t.req({ id: '1', type: 'start_job', task: 'write a poem' })).toEqual({ id: '1', type: 'error', message: '2 jobs are already running.' });
    expect(await t.req({ id: '2', type: 'ask', text: 'hi' })).toMatchObject({ type: 'error', message: expect.stringMatching(/boom/) });
    expect(t.audit.entries.map((e) => [e.tool, e.outcome])).toEqual([['phone.start_job', 'denied'], ['phone.ask', 'error']]);
    expect(await t.req({ id: '3', type: 'start_job', task: 'x'.repeat(501) })).toEqual({ id: '3', type: 'error', message: 'bad request' });
  });

  it('job_status and start_job when jobs are off', async () => {
    expect(await setup().req({ id: '1', type: 'job_status' })).toMatchObject({ type: 'error', message: expect.stringMatching(/jobs are off/) });
    expect(await setup({ jobStatus: async () => 'No jobs.' }).req({ id: '1', type: 'job_status' })).toEqual({ id: '1', type: 'reply', text: 'No jobs.' });
    expect(await setup().req({ id: '1', type: 'start_job', task: 'write a poem' })).toEqual({ id: '1', type: 'error', message: PHONE_JOBS_OFF });
  });

  it('anything else is a bad request: unknown types, extra fields, oversize text, not JSON', async () => {
    const t = setup();
    expect(await t.req({ id: '1', type: 'memory.add', text: 'x' })).toEqual({ id: '1', type: 'error', message: 'bad request' });
    expect(await t.req({ id: '2', type: 'ask', text: 'x', source: 'voice-ptt' })).toEqual({ id: '2', type: 'error', message: 'bad request' });
    expect(await t.req({ id: '3', type: 'ask', text: 'x'.repeat(2001) })).toEqual({ id: '3', type: 'error', message: 'bad request' });
    expect(await t.server.handle('nope')).toEqual({ type: 'error', message: 'not JSON' });
    expect(t.asked).toEqual([]);
  });
});

describe('phone.sock', () => {
  it('serves one JSON line each way over a 0600 socket; isOn follows the marker file', async () => {
    const after: (() => void)[] = [];
    const home = join(tmp, 'h');
    const { isPhoneOn } = await import('../../src/phone/setup.js');
    const server = new PhoneServer({ home, isOn: () => isPhoneOn(home), ask: (t) => Promise.resolve(`ok: ${t}`), audit: null, notify: () => undefined });
    await server.start();
    try {
      expect(statSync(phoneSocketPath(home)).mode & 0o777).toBe(0o600);
      const send = (line: string) =>
        new Promise<string>((resolve, reject) => {
          const s = createConnection(phoneSocketPath(home));
          let buf = '';
          s.on('data', (d) => {
            buf += String(d);
            if (buf.includes('\n')) {
              s.end();
              resolve(buf.trim());
            }
          });
          s.on('error', reject);
          s.write(line + '\n');
        });
      expect(JSON.parse(await send('{"id":"1","type":"ask","text":"hi"}'))).toEqual({ id: '1', type: 'error', message: PHONE_OFF_MESSAGE });
      mkdirSync(join(home, 'phone'), { recursive: true });
      // A live process whose command line reads like Remote Control (isPhoneOn checks it, REVIEW-8 R8-5).
      const rc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'claude', 'remote-control'], { stdio: 'ignore' });
      writeFileSync(phoneOnPath(home), JSON.stringify({ pid: process.pid, rc: rc.pid }));
      after.push(() => rc.kill());
      expect(JSON.parse(await send('{"id":"2","type":"ask","text":"hi"}'))).toEqual({ id: '2', type: 'reply', text: 'ok: hi' });
    } finally {
      for (const f of after) f();
      await server.close();
    }
  });
});
