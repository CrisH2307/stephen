/**
 * Helper protocol logic: the push-to-talk specification (model + scenarios shared with the Swift test), line
 * framing and event validation.
 */
import { describe, expect, it } from 'vitest';
import { LineFramer, MAX_LINE_BYTES, encodeCommand, parseHelperLine } from '../../src/helper/framing.js';
import { PTT_MAX_HOLD_MS, PTT_MIN_HOLD_MS } from '../../src/helper/protocol.js';
import { PttModel, SCENARIOS, runModel } from './ptt-model.js';

describe('push-to-talk model (spec for helper/Core.swift PushToTalk)', () => {
  for (const s of SCENARIOS) {
    it(s.name, () => {
      expect(runModel(s).map((e) => e.type)).toEqual(s.expect);
    });
  }

  it('heldMs is the time both keys were held; short taps are still reported (Node filters < PTT_MIN_HOLD_MS)', () => {
    const m = new PttModel(PTT_MAX_HOLD_MS);
    expect(m.flags({ fn: true, opt: true }, 100)).toEqual([{ type: 'ptt_down', at: 100 }]);
    expect(m.flags({ fn: true }, 180)).toEqual([{ type: 'ptt_up', at: 180, heldMs: 80 }]);
    expect(80).toBeLessThan(PTT_MIN_HOLD_MS);
  });

  it('max hold cuts the press at PTT_MAX_HOLD_MS exactly once', () => {
    const m = new PttModel(PTT_MAX_HOLD_MS);
    m.flags({ fn: true, opt: true }, 0);
    expect(m.tick(PTT_MAX_HOLD_MS - 1)).toEqual([]);
    expect(m.tick(PTT_MAX_HOLD_MS)).toEqual([{ type: 'ptt_up', at: PTT_MAX_HOLD_MS, heldMs: PTT_MAX_HOLD_MS }]);
    expect(m.tick(PTT_MAX_HOLD_MS + 5_000)).toEqual([]);
    expect(m.isDown).toBe(false);
  });
});

describe('LineFramer', () => {
  it('splits lines across chunks, accepts CRLF, skips empty lines', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(f.push(Buffer.from(':2}\r\n\n\n'))).toEqual(['{"b":2}']);
    expect(f.push(Buffer.from('x'))).toEqual([]);
    expect(f.push(Buffer.from('y\n'))).toEqual(['xy']);
  });

  it('drops an over-long line up to its newline and keeps going', () => {
    const f = new LineFramer(10);
    expect(f.push(Buffer.from('0123456789\n'))).toEqual(['0123456789']); // exactly the limit is fine
    expect(f.push(Buffer.from('0123456'))).toEqual([]);
    expect(f.push(Buffer.from('789AB'))).toEqual([]);
    expect(f.push(Buffer.from('CDEF\nok\n'))).toEqual(['ok']);
    expect(f.dropped).toBe(1);
  });

  it('defaults to the protocol limit (4 KiB) and keeps multi-byte UTF-8 split across chunks intact', () => {
    expect(new LineFramer().maxBytes).toBe(MAX_LINE_BYTES);
    const f = new LineFramer();
    const bytes = Buffer.from('{"message":"é🔈"}\n');
    expect([...f.push(bytes.subarray(0, 14)), ...f.push(bytes.subarray(14))]).toEqual(['{"message":"é🔈"}']);
  });
});

describe('parseHelperLine', () => {
  it('accepts every protocol event', () => {
    const lines = [
      { type: 'hello', version: '1', inputMonitoring: true },
      { type: 'ptt_down', at: 1 },
      { type: 'ptt_up', at: 2, heldMs: 300 },
      { type: 'esc', at: 3 },
      { type: 'audio', playing: false, at: 4 },
      { type: 'error', message: 'x' },
    ];
    for (const l of lines) expect(parseHelperLine(JSON.stringify(l))).toEqual({ kind: 'event', event: l });
  });

  it('strips unknown fields, ignores unknown types, rejects malformed events', () => {
    expect(parseHelperLine('{"type":"esc","at":5,"extra":true}')).toEqual({ kind: 'event', event: { type: 'esc', at: 5 } });
    expect(parseHelperLine('{"type":"future_thing"}')).toEqual({ kind: 'unknown', type: 'future_thing' });
    for (const bad of ['nope', '[]', 'null', '{"at":1}', '{"type":"ptt_up","at":1}', '{"type":"ptt_up","at":1,"heldMs":-5}', '{"type":"audio","playing":"yes","at":1}', '{"type":"hello","version":1,"inputMonitoring":true}']) {
      expect(parseHelperLine(bad).kind, bad).toBe('invalid');
    }
  });

  it('encodes commands as one JSON line', () => {
    expect(encodeCommand({ type: 'state', state: 'recording' })).toBe('{"type":"state","state":"recording"}\n');
    expect(encodeCommand({ type: 'query_audio' })).toBe('{"type":"query_audio"}\n');
    expect(encodeCommand({ type: 'open_window' })).toBe('{"type":"open_window"}\n');
    expect(encodeCommand({ type: 'press_over' })).toBe('{"type":"press_over"}\n');
  });
});
