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
    ['memory.add huge text', line({ id: 'a', type: 'memory.add', text: 'x'.repeat(5000) }), { kind: 'invalid', id: 'a', message: 'text is too long (2000 characters at most)' }],
  ];
  it.each(invalid)('refuses %s', (_name, raw, expected) => {
    expect(parseAppRequest(raw)).toEqual(expected);
  });

  it('unknown types are ignored, with or without an id', () => {
    expect(parseAppRequest(line({ id: 'a', type: 'shell.exec', cmd: 'rm' }))).toEqual({ kind: 'unknown', type: 'shell.exec' });
    expect(parseAppRequest(line({ type: 'future.thing' }))).toEqual({ kind: 'unknown', type: 'future.thing' });
  });

  it('knows every request type of the table plus window.open', () => {
    expect([...APP_REQUEST_TYPES].sort()).toEqual(
      ['audit.recent', 'chat.send', 'chat.stop', 'accounts.status', 'hello', 'history.clear', 'history.list', 'memory.add', 'memory.clear', 'memory.forget', 'memory.list', 'memory.update', 'settings.get', 'window.open'].sort(),
    );
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
