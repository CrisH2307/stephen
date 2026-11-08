/** app.sock protocol v1 request validation (src/app/protocol.ts). */
import { describe, expect, it } from 'vitest';
import {
  APP_CHAT_MAX_CHARS,
  APP_REQUEST_TYPES,
  encodeAppMessage,
  parseAppRequest,
  userCharCount,
  type ParsedRequest,
} from '../../src/app/protocol.js';

const line = (o: unknown) => JSON.stringify(o);

describe('parseAppRequest', () => {
  const valid: [string, unknown, unknown][] = [
    ['hello', { id: 'a1', type: 'hello', version: '1' }, { id: 'a1', type: 'hello', version: '1' }],
    ['chat.send', { id: 'a2', type: 'chat.send', text: 'open youtube' }, { id: 'a2', type: 'chat.send', text: 'open youtube' }],
    ['chat.send at the cap', { id: 'a', type: 'chat.send', text: 'x'.repeat(APP_CHAT_MAX_CHARS) }, expect.objectContaining({ type: 'chat.send' })],
    ['chat.send: 2000 emoji (grapheme count)', { id: 'a', type: 'chat.send', text: '👍🏽'.repeat(2000) }, expect.objectContaining({ type: 'chat.send' })],
    ['chat.stop', { id: 'a', type: 'chat.stop' }, { id: 'a', type: 'chat.stop' }],
    ['history.list bare', { id: 'a', type: 'history.list' }, { id: 'a', type: 'history.list' }],
    ['history.list nulls dropped', { id: 'a', type: 'history.list', before: null, limit: null }, { id: 'a', type: 'history.list' }],
    [
      'history.list full',
      { id: 'a', type: 'history.list', before: '2026-11-01T09:12:05.000Z', limit: 100 },
      { id: 'a', type: 'history.list', before: '2026-11-01T09:12:05.000Z', limit: 100 },
    ],
    ['history.clear', { id: 'a', type: 'history.clear' }, { id: 'a', type: 'history.clear' }],
    ['memory.list', { id: 'a', type: 'memory.list' }, { id: 'a', type: 'memory.list' }],
    ['memory.add', { id: 'a', type: 'memory.add', text: 'my gym is goodlife' }, { id: 'a', type: 'memory.add', text: 'my gym is goodlife' }],
    ['memory.update', { id: 'a', type: 'memory.update', memId: 'm3', text: 'x' }, { id: 'a', type: 'memory.update', memId: 'm3', text: 'x' }],
    ['memory.forget', { id: 'a', type: 'memory.forget', memId: 'm3' }, { id: 'a', type: 'memory.forget', memId: 'm3' }],
    ['memory.clear', { id: 'a', type: 'memory.clear' }, { id: 'a', type: 'memory.clear' }],
    ['settings.get', { id: 'a', type: 'settings.get' }, { id: 'a', type: 'settings.get' }],
    ['audit.recent', { id: 'a', type: 'audit.recent', limit: 200 }, { id: 'a', type: 'audit.recent', limit: 200 }],
    ['accounts.status', { id: 'a', type: 'accounts.status', x: 1 }, { id: 'a', type: 'accounts.status' }],
    ['jobs.list', { id: 'a', type: 'jobs.list', x: 1 }, { id: 'a', type: 'jobs.list' }],
    ['jobs.stop', { id: 'a', type: 'jobs.stop', jobId: '2026-11-05-write-my-report', x: 1 }, { id: 'a', type: 'jobs.stop', jobId: '2026-11-05-write-my-report' }],
    ['window.open', { id: 'a', type: 'window.open' }, { id: 'a', type: 'window.open' }],
    ['extra fields are dropped', { id: 'a', type: 'chat.stop', text: 'ignored', evil: true }, { id: 'a', type: 'chat.stop' }],
  ];
  it.each(valid)('accepts %s', (_name, msg, req) => {
    expect(parseAppRequest(line(msg))).toEqual({ kind: 'request', req });
  });

  const invalid: [string, string, ParsedRequest][] = [
    ['not JSON', '{oops', { kind: 'invalid', message: 'not JSON' }],
    ['an array', '[1]', { kind: 'invalid', message: 'not a JSON object' }],
    ['null', 'null', { kind: 'invalid', message: 'not a JSON object' }],
    ['no type', line({ id: 'a' }), { kind: 'invalid', id: 'a', message: 'missing "type"' }],
    ['no id', line({ type: 'hello', version: '1' }), { kind: 'invalid', message: expect.stringContaining('needs an "id"') as unknown as string }],
    ['numeric id', line({ id: 7, type: 'chat.stop' }), { kind: 'invalid', message: expect.stringContaining('needs an "id"') as unknown as string }],
    ['over-long id', line({ id: 'x'.repeat(65), type: 'chat.stop' }), { kind: 'invalid', message: expect.stringContaining('needs an "id"') as unknown as string }],
    ['hello without version', line({ id: 'a', type: 'hello' }), { kind: 'invalid', id: 'a', message: 'version must be a string' }],
    ['chat.send without text', line({ id: 'a', type: 'chat.send' }), { kind: 'invalid', id: 'a', message: 'text must be a string' }],
    ['chat.send too long', line({ id: 'a', type: 'chat.send', text: 'x'.repeat(2001) }), { kind: 'invalid', id: 'a', message: 'text is too long (2000 characters at most)' }],
    ['history.list limit 101', line({ id: 'a', type: 'history.list', limit: 101 }), { kind: 'invalid', id: 'a', message: 'limit must be a whole number from 1 to 100' }],
    ['history.list limit 0', line({ id: 'a', type: 'history.list', limit: 0 }), { kind: 'invalid', id: 'a', message: 'limit must be a whole number from 1 to 100' }],
    ['history.list limit 1.5', line({ id: 'a', type: 'history.list', limit: 1.5 }), { kind: 'invalid', id: 'a', message: 'limit must be a whole number from 1 to 100' }],
    ['history.list bad before', line({ id: 'a', type: 'history.list', before: 'yesterday' }), { kind: 'invalid', id: 'a', message: 'before must be an ISO date/time' }],
    ['audit.recent limit 201', line({ id: 'a', type: 'audit.recent', limit: 201 }), { kind: 'invalid', id: 'a', message: 'limit must be a whole number from 1 to 200' }],
    ['audit.recent limit "5"', line({ id: 'a', type: 'audit.recent', limit: '5' }), { kind: 'invalid', id: 'a', message: 'limit must be a whole number from 1 to 200' }],
    ['memory.update without memId', line({ id: 'a', type: 'memory.update', text: 'x' }), { kind: 'invalid', id: 'a', message: 'memId must be a memory id like "m7"' }],
    ['memory.update without text', line({ id: 'a', type: 'memory.update', memId: 'm1' }), { kind: 'invalid', id: 'a', message: 'text must be a string' }],
    ['memory.forget numeric memId', line({ id: 'a', type: 'memory.forget', memId: 7 }), { kind: 'invalid', id: 'a', message: 'memId must be a memory id like "m7"' }],
    ['jobs.stop without jobId', line({ id: 'a', type: 'jobs.stop' }), { kind: 'invalid', id: 'a', message: 'jobId must be a job folder name like 2026-11-05-write-my-report' }],
    ['jobs.stop with a path', line({ id: 'a', type: 'jobs.stop', jobId: '../../etc/passwd' }), { kind: 'invalid', id: 'a', message: 'jobId must be a job folder name like 2026-11-05-write-my-report' }],
    ['memory.add huge text', line({ id: 'a', type: 'memory.add', text: 'x'.repeat(5000) }), { kind: 'invalid', id: 'a', message: 'text is too long (2000 characters at most)' }],
  ];
  it.each(invalid)('refuses %s', (_name, raw, expected) => {
    expect(parseAppRequest(raw)).toEqual(expected);
  });

  it('unknown types are ignored, with or without an id', () => {
    expect(parseAppRequest(line({ id: 'a', type: 'shell.exec', cmd: 'rm' }))).toEqual({ kind: 'unknown', type: 'shell.exec' });
    expect(parseAppRequest(line({ type: 'future.thing' }))).toEqual({ kind: 'unknown', type: 'future.thing' });
  });

  it('knows every request type of the table plus window.open, the confirm pair and the P2 control requests', () => {
    expect([...APP_REQUEST_TYPES].sort()).toEqual(
      ['audit.recent', 'chat.send', 'chat.stop', 'accounts.status', 'hello', 'history.clear', 'history.list', 'jobs.list', 'jobs.stop', 'memory.add', 'memory.clear', 'memory.forget', 'memory.list', 'memory.update', 'settings.get', 'window.open', 'confirm.ask', 'confirm.answer', 'phone.on', 'phone.off', 'zen.open', 'doctor.run', 'usage.get', 'personal.summary', 'memory.graph', 'memory.suggestions', 'memory.propose', 'memory.keep', 'memory.skip', 'memory.usage'].sort(),
    );
  });

  it('confirm.ask / confirm.answer / hello confirms: shapes and caps', () => {
    const id = '0b6f3c1e-7a2d-4c55-9f10-2b8e4d6a9c01';
    expect(parseAppRequest(JSON.stringify({ id: 'h', type: 'hello', version: '1', confirms: true }))).toEqual({ kind: 'request', req: { id: 'h', type: 'hello', version: '1', confirms: true } });
    expect(parseAppRequest(JSON.stringify({ id: 'h', type: 'hello', version: '1', confirms: 'yes' }))).toEqual({ kind: 'request', req: { id: 'h', type: 'hello', version: '1' } });
    expect(parseAppRequest(JSON.stringify({ id: 'g1', type: 'confirm.ask', title: 't', body: 'b', timeoutMs: 120000, extra: 1 }))).toEqual({
      kind: 'request',
      req: { id: 'g1', type: 'confirm.ask', title: 't', body: 'b', timeoutMs: 120000 },
    });
    expect(parseAppRequest(JSON.stringify({ id: 'g1', type: 'confirm.ask', title: 'x'.repeat(201), body: 'b', timeoutMs: 1000 })).kind).toBe('invalid');
    expect(parseAppRequest(JSON.stringify({ id: 'g1', type: 'confirm.ask', title: 't', body: 'x'.repeat(4001), timeoutMs: 1000 })).kind).toBe('invalid');
    expect(parseAppRequest(JSON.stringify({ id: 'g1', type: 'confirm.ask', title: 't', body: 'b', timeoutMs: 999 })).kind).toBe('invalid');
    expect(parseAppRequest(JSON.stringify({ id: 'g1', type: 'confirm.ask', title: 't', body: 'b', timeoutMs: 3600001 })).kind).toBe('invalid');
    expect(parseAppRequest(JSON.stringify({ id: 'a', type: 'confirm.answer', confirmId: id, approve: true }))).toEqual({ kind: 'request', req: { id: 'a', type: 'confirm.answer', confirmId: id, approve: true } });
    expect(parseAppRequest(JSON.stringify({ id: 'a', type: 'confirm.answer', confirmId: id, approve: 'yes' })).kind).toBe('invalid');
    expect(parseAppRequest(JSON.stringify({ id: 'a', type: 'confirm.answer', confirmId: 'c1', approve: true })).kind).toBe('invalid');
  });

  it('control requests take only an id; extra fields are dropped', () => {
    for (const type of ['phone.on', 'phone.off', 'zen.open', 'doctor.run', 'usage.get', 'personal.summary', 'memory.graph', 'memory.suggestions', 'memory.usage']) {
      expect(parseAppRequest(line({ id: 'c', type, cmd: 'rm -rf /' }))).toEqual({ kind: 'request', req: { id: 'c', type } });
      expect(parseAppRequest(line({ type }))).toMatchObject({ kind: 'invalid' });
    }
  });
});

describe('Memory page requests (UI-PLAN v3.1 section 7a)', () => {
  it('memory.propose takes text (capped like memory.add); extra fields such as origin are dropped', () => {
    expect(parseAppRequest(line({ id: 'p', type: 'memory.propose', text: 'I moved to Fit4Less', origin: 'canvas' }))).toEqual({
      kind: 'request',
      req: { id: 'p', type: 'memory.propose', text: 'I moved to Fit4Less' },
    });
    expect(parseAppRequest(line({ id: 'p', type: 'memory.propose' })).kind).toBe('invalid');
    expect(parseAppRequest(line({ id: 'p', type: 'memory.propose', text: 'x'.repeat(2001) })).kind).toBe('invalid');
  });

  it('memory.keep takes a proposal id and optional edited text; memory.skip an id', () => {
    expect(parseAppRequest(line({ id: 'k', type: 'memory.keep', propId: 'p3' }))).toEqual({ kind: 'request', req: { id: 'k', type: 'memory.keep', propId: 'p3' } });
    expect(parseAppRequest(line({ id: 'k', type: 'memory.keep', propId: 'p3', text: 'I moved to GoodLife' }))).toEqual({
      kind: 'request',
      req: { id: 'k', type: 'memory.keep', propId: 'p3', text: 'I moved to GoodLife' },
    });
    expect(parseAppRequest(line({ id: 'k', type: 'memory.keep', propId: 'p3', text: null }))).toEqual({ kind: 'request', req: { id: 'k', type: 'memory.keep', propId: 'p3' } });
    expect(parseAppRequest(line({ id: 'k', type: 'memory.keep', propId: 'p3', text: 7 })).kind).toBe('invalid');
    expect(parseAppRequest(line({ id: 'k', type: 'memory.keep', propId: 'm3' })).kind).toBe('invalid');
    expect(parseAppRequest(line({ id: 'k', type: 'memory.keep' })).kind).toBe('invalid');
    expect(parseAppRequest(line({ id: 's', type: 'memory.skip', propId: 'p3', text: 'x' }))).toEqual({ kind: 'request', req: { id: 's', type: 'memory.skip', propId: 'p3' } });
    expect(parseAppRequest(line({ id: 's', type: 'memory.skip', propId: 'p0' })).kind).toBe('invalid');
  });
});

describe('helpers', () => {
  it('userCharCount counts grapheme clusters and stops early past the cap', () => {
    expect(userCharCount('abc')).toBe(3);
    expect(userCharCount('👍🏽👍🏽')).toBe(2);
    expect(userCharCount('x'.repeat(10_000), 5)).toBe(6);
  });

  it('encodeAppMessage writes one line', () => {
    const l = encodeAppMessage({ type: 'heard', text: 'a\nb', source: 'voice-ptt' });
    expect(l.endsWith('\n')).toBe(true);
    expect(l.slice(0, -1)).not.toContain('\n');
  });
});
