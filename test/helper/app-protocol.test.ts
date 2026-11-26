/**
 * app.sock protocol v1 (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 13): the shared fixture
 * test/fixtures/app-protocol-v1.jsonl, which the Node server (src/app) tests run against too, is well formed and
 * covers every message in the table. Plus cheap source checks on the Swift window, which can only be compiled on the
 * Mac: it sends every request type, handles every response and push type, shows untrusted text verbatim, and is
 * reachable from the menu, `--open-window` and the helper.sock `open_window` command.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELPER_SOURCES, helperSourceDir } from '../../src/helper/install.js';
import { EDIT_REQUEST_MAX } from '../../src/jobs/spec.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'app-protocol-v1.jsonl');
const MAX_LINE_BYTES = 256 * 1024;

/** Request type → the response types it may get. */
const RESPONSES: Record<string, string[]> = {
  hello: ['hello', 'error'],
  'chat.send': ['chat.accepted', 'error'],
  'chat.stop': ['ok', 'error'],
  'history.list': ['history', 'error'],
  'history.clear': ['ok', 'error'],
  'memory.list': ['memory', 'error'],
  'memory.add': ['memory', 'error'],
  'memory.update': ['memory', 'error'],
  'memory.forget': ['memory', 'error'],
  'memory.clear': ['memory', 'error'],
  'settings.get': ['settings', 'error'],
  // Settings > How Stephen talks: length, tone, speak, explain, voice; answers with the new settings snapshot.
  'settings.set': ['settings', 'error'],
  'model.set': ['settings', 'error'],
  'audit.recent': ['audit', 'error'],
  'accounts.status': ['accounts', 'error'],
  'jobs.list': ['jobs', 'error'],
  'jobs.stop': ['job', 'error'],
  // Sent by `stephen app` (src/app/cli.ts), not by the window: the listener forwards open_window to the helper.
  'window.open': ['ok', 'error'],
  // Sent by the safety gate (src/safety/app-confirm.ts), not by the window; answered by the Ask box's click.
  'confirm.ask': ['confirm.result', 'error'],
  'confirm.answer': ['ok', 'error'],
  // ROADMAP P2 control (src/app/control.ts).
  'phone.on': ['phone', 'error'],
  'phone.off': ['phone', 'error'],
  'zen.open': ['zen', 'error'],
  'doctor.run': ['doctor', 'error'],
  'usage.get': ['usage', 'error'],
  // Settings > Speed (src/telemetry/cli.ts): the latency report as text.
  'latency.get': ['latency', 'error'],
  // Personal page (src/app/personal.ts), read-only.
  'personal.summary': ['personal', 'error'],
  // Memory page (UI-PLAN v3.1 section 7a): proposals are kept or skipped only by the owner's click.
  'memory.graph': ['graph', 'error'],
  'memory.suggestions': ['suggestions', 'error'],
  'memory.propose': ['suggestions', 'error'],
  'memory.keep': ['memory', 'error'],
  'memory.skip': ['suggestions', 'error'],
  'memory.usage': ['memory.usage', 'error'],
  // Settings > Privacy and permissions (issue #48 PR 2): the replay recorder switch and its Delete; only the owner's click.
  'replay.set': ['settings', 'error'],
  'replay.delete': ['ok', 'error'],
  // ADR-007 v2 resume: Open in chat on a Conversations row arms; Cancel on Home and New chat drop it. Window only.
  'chat.resume': ['ok', 'error'],
  'chat.resume.cancel': ['ok', 'error'],
  // ADR-010 edit and resend: Send in a row's inline editor; the versions switch (read only); Delete this version. Window only.
  'chat.edit': ['chat.accepted', 'error'],
  'history.versions': ['versions', 'error'],
  'history.deleteVersion': ['ok', 'error'],
};
const REQUEST_TYPES = Object.keys(RESPONSES);
/** Request types only the CLI sends. */
const CLI_ONLY_REQUESTS = ['window.open', 'confirm.ask'];
/** Requests the listener accepts but the window never sends (fewer memory write paths); pinned absent below. */
const WINDOW_NEVER_SENDS = ['memory.add'];
/** Responses only the gate reads. */
const GATE_ONLY_RESPONSES = ['confirm.result'];
const RESPONSE_TYPES = [...new Set(Object.values(RESPONSES).flat())];
// replay (#208): the "Recording on" sign follows the listener's push, not a cached settings answer.
// resume (ADR-007 v2): the "Continuing an earlier chat" line follows the listener's arm.
const PUSH_TYPES = ['state', 'heard', 'chat.done', 'confirm', 'confirm.end', 'replay', 'resume'];
const STATES = ['idle', 'listening', 'recording', 'working', 'speaking'];
/** Where a proposal (and a kept item) came from; email, canvas and web are third-party text. */
const ORIGINS = ['you', 'chat', 'email', 'canvas', 'web'];
const KINDS = ['people', 'school', 'places', 'habits', 'projects', 'other'];

type Msg = Record<string, unknown> & { type: string; id?: string };
interface Line {
  from: 'app' | 'node';
  kind: 'request' | 'response' | 'push';
  msg: Msg;
}

function readFixture(): Line[] {
  const text = readFileSync(FIXTURE, 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((raw, i) => {
      expect(Buffer.byteLength(raw), `line ${i + 1} size`).toBeLessThanOrEqual(MAX_LINE_BYTES);
      let parsed: unknown;
      expect(() => (parsed = JSON.parse(raw)), `line ${i + 1} is JSON`).not.toThrow();
      const l = parsed as Line;
      expect(l && typeof l === 'object' && !Array.isArray(l), `line ${i + 1} is an object`).toBe(true);
      expect(Object.keys(l).sort(), `line ${i + 1} keys`).toEqual(['from', 'kind', 'msg']);
      expect(typeof l.msg.type, `line ${i + 1} msg.type`).toBe('string');
      // The wire line itself is one JSON object without raw newlines.
      expect(JSON.stringify(l.msg)).not.toContain('\n');
      return l;
    });
}

describe('app.sock protocol v1 fixture', () => {
  const lines = readFixture();
  const requests = lines.filter((l) => l.kind === 'request');
  const responses = lines.filter((l) => l.kind === 'response');
  const pushes = lines.filter((l) => l.kind === 'push');

  it('every line is a request from the app, or a response / push from node', () => {
    expect(lines.length).toBe(requests.length + responses.length + pushes.length);
    for (const l of requests) expect(l.from).toBe('app');
    for (const l of [...responses, ...pushes]) expect(l.from).toBe('node');
  });

  it('requests have unique client ids and known types; responses echo an earlier id with an allowed type', () => {
    const seen = new Map<string, string>();
    for (const l of lines) {
      if (l.kind === 'request') {
        expect(typeof l.msg.id).toBe('string');
        expect(seen.has(l.msg.id!), `duplicate id ${l.msg.id}`).toBe(false);
        expect(REQUEST_TYPES).toContain(l.msg.type);
        seen.set(l.msg.id!, l.msg.type);
      } else if (l.kind === 'response') {
        const reqType = seen.get(l.msg.id ?? '');
        expect(reqType, `response ${JSON.stringify(l.msg)} answers no earlier request`).toBeDefined();
        expect(RESPONSES[reqType!]).toContain(l.msg.type);
      } else {
        expect(l.msg.id, 'pushes carry no id').toBeUndefined();
        expect(PUSH_TYPES).toContain(l.msg.type);
      }
    }
  });

  it('covers every type in the table, every state, and an error for a request', () => {
    expect(new Set(requests.map((l) => l.msg.type))).toEqual(new Set(REQUEST_TYPES));
    expect(new Set(responses.map((l) => l.msg.type))).toEqual(new Set(RESPONSE_TYPES));
    expect(new Set(pushes.map((l) => l.msg.type))).toEqual(new Set(PUSH_TYPES));
    expect(new Set(pushes.filter((l) => l.msg.type === 'state').map((l) => l.msg.state))).toEqual(new Set(STATES));
    expect(responses.some((l) => l.msg.type === 'error' && l.msg.message === 'busy')).toBe(true);
  });

  it('fields match the table: caps, shapes of history entries, memory items, chat.done, settings', () => {
    for (const { msg } of requests) {
      if (msg.type === 'hello') expect(msg.version).toBe('1');
      if (msg.type === 'chat.send' || msg.type === 'memory.add' || msg.type === 'memory.update') {
        expect(typeof msg.text).toBe('string');
        expect((msg.text as string).length).toBeLessThanOrEqual(2000);
      }
      if (msg.type === 'memory.update' || msg.type === 'memory.forget') expect(typeof msg.memId).toBe('string');
      if (msg.type === 'history.list') {
        if (msg.limit !== undefined) expect(msg.limit).toBeLessThanOrEqual(100);
        if (msg.before !== undefined) expect(Number.isNaN(Date.parse(msg.before as string))).toBe(false);
      }
      if (msg.type === 'audit.recent' && msg.limit !== undefined) expect(msg.limit).toBeLessThanOrEqual(200);
    }
    for (const { msg } of [...responses, ...pushes]) {
      switch (msg.type) {
        case 'hello':
          expect(msg).toMatchObject({ version: '1' });
          expect(typeof msg.listening).toBe('boolean');
          expect(typeof msg.model).toBe('string');
          break;
        case 'chat.accepted':
          expect(typeof msg.entryId).toBe('string');
          break;
        case 'chat.done':
          expect(typeof msg.entryId).toBe('string');
          expect(typeof msg.reply).toBe('string');
          expect(['ok', 'error', 'cancelled', 'memory']).toContain(msg.outcome);
          expect((msg.tools as unknown[]).every((t) => typeof t === 'string')).toBe(true);
          expect(typeof msg.ms).toBe('number');
          if (msg.steps !== undefined) {
            for (const st of msg.steps as Record<string, unknown>[]) {
              expect(Object.keys(st).sort()).toEqual(['status', 'text']);
              expect(['ok', 'refused', 'failed']).toContain(st.status);
              expect((st.text as string).length).toBeLessThanOrEqual(160);
            }
          }
          break;
        case 'error':
          expect(typeof msg.message).toBe('string');
          break;
        case 'history':
          for (const e of msg.entries as Record<string, unknown>[]) {
            // conv and steps (ADR-007) are optional: an older line has neither.
            expect(Object.keys(e).filter((k) => k !== 'conv' && k !== 'steps').sort()).toEqual(['followUp', 'id', 'ms', 'outcome', 'reply', 'said', 'source', 'tools', 'ts', 'turns']);
            if (e.conv !== undefined) expect(e.conv).toMatch(/^c_[0-9a-f]{16}$/);
            for (const st of (e.steps ?? []) as Record<string, unknown>[]) expect(Object.keys(st).sort()).toEqual(['status', 'text']);
            expect(['voice-ptt', 'voice-wake', 'app', 'cli']).toContain(e.source);
            for (const t of e.tools as Record<string, unknown>[]) expect(Object.keys(t).sort()).toEqual(['isError', 'ms', 'tool']);
          }
          break;
        case 'memory':
          for (const m of msg.items as Record<string, unknown>[]) {
            expect(Object.keys(m).filter((k) => k !== 'origin').sort()).toEqual(['createdAt', 'id', 'source', 'text', 'updatedAt']);
            if (m.origin !== undefined) expect(ORIGINS).toContain(m.origin);
            expect((m.text as string).length).toBeLessThanOrEqual(200);
          }
          expect((msg.items as unknown[]).length).toBeLessThanOrEqual(30);
          break;
        case 'settings':
          expect(typeof msg.config).toBe('object');
          expect(typeof msg.configPath).toBe('string');
          break;
        case 'accounts':
          for (const a of msg.accounts as Record<string, unknown>[]) {
            expect(['connected', 'not_set', 'off']).toContain(a.state);
            expect([null, 'keychain', '.env']).toContain(a.source);
            expect(typeof a.name).toBe('string');
            expect(typeof a.hint).toBe('string');
          }
          break;
        case 'jobs':
          for (const j of msg.jobs as Record<string, unknown>[]) {
            expect(Object.keys(j).sort()).toEqual(['costUsd', 'createdAt', 'endedAt', 'error', 'folder', 'id', 'startedAt', 'status', 'summary', 'task', 'turns']);
            expect(['queued', 'running', 'done', 'failed', 'stopped', 'timeout']).toContain(j.status);
            expect((j.summary as string).length).toBeLessThanOrEqual(1500);
            expect((j.task as string).length).toBeLessThanOrEqual(120);
          }
          break;
        case 'job':
          expect(typeof (msg.job as Record<string, unknown>).id).toBe('string');
          break;
        case 'audit':
          for (const a of msg.entries as Record<string, unknown>[]) {
            expect(typeof a.ts).toBe('string');
            expect(typeof a.tool).toBe('string');
            expect(['ok', 'denied', 'error']).toContain(a.outcome);
          }
          break;
        case 'phone':
          expect(typeof msg.on).toBe('boolean');
          expect((msg.lines as unknown[]).every((l) => typeof l === 'string')).toBe(true);
          break;
        case 'zen':
          expect(typeof msg.ok).toBe('boolean');
          expect(typeof msg.message).toBe('string');
          break;
        case 'doctor':
          for (const c of msg.checks as Record<string, unknown>[]) {
            expect(typeof c.ok).toBe('boolean');
            expect(typeof c.label).toBe('string');
          }
          expect(typeof msg.problems).toBe('number');
          expect(typeof msg.blocking).toBe('number');
          break;
        case 'usage': {
          const m = msg.memory as Record<string, unknown>;
          expect(Object.keys(m).sort()).toEqual(['budget', 'bytes', 'percent', 'warn']);
          expect(m.budget).toBe(8192);
          if (msg.context !== null) expect(Object.keys(msg.context as object).sort()).toEqual(['percent', 'tokens', 'warn', 'window']);
          break;
        }
        case 'latency':
          expect(Object.keys(msg).sort()).toEqual(['days', 'id', 'text', 'triggers', 'type']);
          expect([1, 7, 30]).toContain(msg.days);
          expect(typeof msg.triggers).toBe('number');
          expect(typeof msg.text).toBe('string');
          break;
        case 'memory.usage': {
          const m = msg.memory as Record<string, unknown>;
          expect(Object.keys(m).sort()).toEqual(['budget', 'bytes', 'percent', 'warn']);
          break;
        }
        case 'suggestions':
          for (const p of msg.suggestions as Record<string, unknown>[]) {
            expect(Object.keys(p).sort()).toEqual(['createdAt', 'id', 'origin', 'text', 'untrusted']);
            expect(p.id).toMatch(/^p[1-9]\d*$/);
            expect(ORIGINS).toContain(p.origin);
            expect(p.untrusted).toBe(['email', 'canvas', 'web'].includes(p.origin as string));
            expect((p.text as string).length).toBeLessThanOrEqual(200);
          }
          expect((msg.suggestions as unknown[]).length).toBeLessThanOrEqual(20);
          break;
        case 'graph': {
          const ids = new Set<string>();
          for (const n of msg.nodes as Record<string, unknown>[]) {
            expect(Object.keys(n).sort()).toEqual(['id', 'kind', 'new', 'text']);
            expect(KINDS).toContain(n.kind);
            expect(n.new).toBe((n.id as string).startsWith('p'));
            ids.add(n.id as string);
          }
          for (const l of msg.links as Record<string, unknown>[]) {
            expect(Object.keys(l).sort()).toEqual(['a', 'b']);
            expect(ids.has(l.a as string) && ids.has(l.b as string)).toBe(true);
          }
          break;
        }
        case 'heard':
          expect(typeof msg.text).toBe('string');
          expect(typeof msg.source).toBe('string');
          break;
        case 'state':
          expect(STATES).toContain(msg.state);
          break;
        case 'confirm.result':
          expect(['approved', 'declined', 'unavailable']).toContain(msg.outcome);
          break;
        case 'confirm':
          expect(msg.confirmId).toMatch(/^[0-9a-f-]{36}$/);
          expect((msg.title as string).length).toBeLessThanOrEqual(200);
          expect((msg.body as string).length).toBeLessThanOrEqual(4000);
          break;
        case 'confirm.end':
          expect(typeof msg.confirmId).toBe('string');
          break;
      }
    }
  });
});

describe('Stephen window Swift sources (compiled only on the Mac)', () => {
  const read = (f: string) => readFileSync(join(helperSourceDir(), f), 'utf8');
  // The app.sock client, split into five files (no behaviour change): types, transport, model, Allow / Deny, control.
  const CLIENT_FILES = ['AppProtocol.swift', 'AppConnection.swift', 'AppClient.swift', 'AppConfirm.swift', 'StephenControl.swift'];
  const client = CLIENT_FILES.map(read).join('\n');
  // The window's sources: frame and router, Home, the palette, Settings (Personal's parts since UI v4) and Memory.
  const window = ['AppWindow.swift', 'MainWindow.swift', 'HomeView.swift', 'Palette.swift', 'SettingsPage.swift', 'MemoryPage.swift'].map(read).join('\n');

  it('AppClient sends every request type and handles every response and push type', () => {
    const windowRequests = REQUEST_TYPES.filter((t) => !CLI_ONLY_REQUESTS.includes(t) && !WINDOW_NEVER_SENDS.includes(t));
    const windowResponses = RESPONSE_TYPES.filter((t) => !GATE_ONLY_RESPONSES.includes(t));
    for (const t of [...windowRequests, ...windowResponses, ...PUSH_TYPES]) expect(client, t).toContain(`"${t}"`);
    expect(client).toContain('APP_MAX_LINE_BYTES = 256 * 1024');
    expect(client).toContain('APP_CHAT_MAX_CHARS = 2000');
    expect(read('main.swift')).toContain('home + "/run/app.sock"');
  });

  it('Settings > About > Speed (UI v4 step c: an accordion): sends latency.get and shows the report text verbatim', () => {
    expect(client).toContain('type: "latency.get"');
    expect(client).toContain('msg.type == "latency"');
    const settings = read('SettingsPage.swift');
    expect(settings).toContain('Accordion("Speed, last 7 days", key: "acc.settings.about.speed") { SpeedSection(control: control) }');
    expect(settings).toMatch(/struct SpeedSection[\s\S]*control\.latency \{ report = latencyText\(\$0\) \}/);
    expect(settings).toMatch(/struct SpeedSection[\s\S]*Text\(verbatim: report\)/);
  });

  it('Ask box usage lines: sends usage.get and decodes the P2 shape (PR #18) without importing it', () => {
    // {id,type:"usage",context:{percent,warn,tokens,window}|null,memory:{percent,warn,bytes,budget}}
    expect(client).toContain('type: "usage.get"');
    expect(client).toContain('msg.type == "usage"');
    // P2's UsageBar (percent is a rounded whole number in src/app/usage.ts).
    expect(client).toMatch(/struct UsageBar: Decodable[\s\S]*let percent: Int[\s\S]*let warn: Bool/);
    expect(client).toContain('decodeIfPresent(UsageBar.self, forKey: .context)');
    expect(client).toContain('decodeIfPresent(UsageBar.self, forKey: .memory)');
    const box = read('AskBox.swift');
    expect(box).toContain('if let m = model.usage?.context');
    // The ⋯ menu is a pop-up menu over the chat (2026-11-09); "almost full" is said in words, not color.
    expect(box).toMatch(/Menu \{[\s\S]*usageLine\("This chat"/);
    expect(box).toContain('", almost full"');
  });

  // R7: loading, error and empty in words. A failed read never reads as "Nothing saved yet", and never shows raw "error".
  it('Memory shows loading, error with Try again, and empty only after a good read', () => {
    const mem = read('MemoryPage.swift');
    expect(client).toContain('@Published private(set) var graphListOk: Bool? = nil');
    const refresh = client.slice(client.indexOf('func refreshMemoryPage()'), client.indexOf('refreshSuggestions()', client.indexOf('func refreshMemoryPage()')));
    expect(refresh).toContain('self.assign(\\.graphListOk, true)');
    expect(refresh).toContain('self.assign(\\.graphListOk, false)');
    expect(refresh).not.toContain('msg.message');
    // memory.list failing is not a raw notice either; a failed change still says why.
    expect(client).toContain('self.assign(\\.memoryNotice, isChange ? plainFailure(msg.message, MEMORY_CHANGE_FAILED) : nil)');
    expect(mem).toContain('if model.graphNodes.isEmpty && model.graphListOk == nil {');
    expect(mem).toMatch(/graphListOk == false \{[\s\S]*MEMORY_LIST_FAILED[\s\S]*QuietButton\("Try again"[^\n]*model\.refreshMemoryPage\(\)/);
    expect(mem).toContain('let MEMORY_LIST_FAILED = "Couldn\'t load your memory right now."');
    // Both empty lines (graph and list) go through memoryEmptyLine; no other "Nothing saved yet".
    expect(mem.match(/memoryEmptyLine\(total: model\.graphNodes\.count, listOk: model\.graphListOk/g)).toHaveLength(2);
    expect(mem.match(/"Nothing saved yet/g)).toHaveLength(2);
    const fn = mem.match(/func memoryEmptyLine\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('if total > 0 { return "Nothing matches." }');
    expect(fn).toContain('guard listOk == true else { return nil }');
  });

  // R7: loading, error and empty in words. A failed list never reads as "Nothing yet", and never shows raw "error".
  it('Conversations shows loading, error with Refresh, and empty only after a good list', () => {
    const conv = read('ConversationsPage.swift');
    expect(client).toContain('@Published private(set) var historyListOk: Bool? = nil');
    const refresh = client.slice(client.indexOf('func refreshHistory()'), client.indexOf('func loadOlderHistory('));
    expect(refresh).toContain('self.assign(\\.historyListOk, true)');
    expect(refresh).toContain('self.assign(\\.historyListOk, false)');
    expect(refresh).not.toContain('msg.message ?? "error"');
    // Clearing the history is a good empty list, not a failed one.
    const clear = client.slice(client.indexOf('func clearHistory()'), client.indexOf('var historyDays'));
    expect(clear).toContain('self.historyListOk = true');
    // Loading only before the first answer with no rows; error with Refresh (ADR-007: no "Try again" on this page, it
    // could read as re-running a command); empty only after a good list.
    expect(conv).toContain('if model.history.isEmpty && model.historyListOk == nil {');
    expect(conv).toMatch(/historyListOk == false \{[\s\S]*CONVERSATIONS_LIST_FAILED[\s\S]*QuietButton\("Refresh"[^\n]*model\.refreshHistory\(\)/);
    expect(conv).toMatch(/if model\.historyListOk == true \{\s*Text\(verbatim: CONVERSATIONS_EMPTY\)/);
    expect(conv).toContain('let CONVERSATIONS_LIST_FAILED = "Couldn\'t load your conversations right now."');
    expect(conv).not.toMatch(/if model\.history\.isEmpty \{\s*Text\(verbatim: CONVERSATIONS_EMPTY\)/);
  });

  // R7 follow-up: every other failed Conversations action says what failed in a plain sentence, never a raw "error".
  // The listener's own sentence ("This conversation changed. Open it again.") is kept; the rows stay.
  describe('Conversations failures in plain words', () => {
    const fnBody = (name: string) => client.match(new RegExp(`func ${name}\\([\\s\\S]*?\\n  \\}`))?.[0] ?? '';
    const conv = read('ConversationsPage.swift');
    it.each([
      ['editMessage', 'CONVERSATIONS_EDIT_FAILED', "Couldn't send your edit right now."],
      ['loadOlderHistory', 'CONVERSATIONS_OLDER_FAILED', "Couldn't load older conversations right now."],
      ['clearHistory', 'CONVERSATIONS_CLEAR_FAILED', "Couldn't clear your history right now."],
      ['deleteVersion', 'CONVERSATIONS_DELETE_FAILED', "Couldn't delete that version right now."],
      ['refreshAudit', 'RECENT_ACTIONS_FAILED', "Couldn't load recent actions right now."],
    ])('%s says %s, never raw "error"', (fn, name, text) => {
      const body = fnBody(fn);
      expect(body).toContain(`plainFailure(msg.message, ${name})`);
      expect(body).not.toContain('?? "error"');
      expect(body).not.toMatch(/Notice\s*=\s*msg\.message|Notice, msg\.message\)/);
      expect(conv).toContain(`let ${name} = "${text}"`);
    });
    it('the rows stay when load older or clear fails', () => {
      for (const fn of ['loadOlderHistory', 'clearHistory']) {
        const failed = fnBody(fn).split('} else {')[1] ?? '';
        expect(failed).toContain('plainFailure(');
        expect(failed).not.toMatch(/self\.history\s*=|historyListOk/);
      }
    });
    it('a failed edit says it in the chat bubble and the notice; busy keeps its own line', () => {
      const body = fnBody('editMessage');
      expect(body).toContain('if msg.message == "busy" {');
      expect(body).toMatch(/let m = plainFailure\(msg\.message, CONVERSATIONS_EDIT_FAILED\)\s*self\.addBubble\(\.problem, m, detail: ""\)\s*self\.historyNotice = m/);
    });
    it('a failed Home chat send says CHAT_SEND_FAILED, never raw "error"; busy keeps its own line', () => {
      const body = fnBody('sendChat');
      expect(body).toContain('if msg.message == "busy" {');
      expect(body).toContain('self.addBubble(.problem, plainFailure(msg.message, CHAT_SEND_FAILED), detail: "")');
      expect(body).not.toContain('?? "error"');
      expect(body).not.toMatch(/addBubble\(\.problem, (m|msg\.message)\b/);
      expect(client).toContain(`let CHAT_SEND_FAILED = "Couldn't send that right now."`);
    });
    // R7: the other pages too. No raw "error" fallback is left anywhere in AppClient.swift.
    it('AppClient.swift has no raw "error" fallback left', () => {
      expect(read('AppClient.swift')).not.toMatch(/\?\?\s*"error"/);
    });
    it.each([
      ['memoryRequest', 'MEMORY_CHANGE_FAILED', "Couldn't change your memory right now."],
      ['keepProposal', 'MEMORY_KEEP_FAILED', "Couldn't keep that memory right now."],
      ['takeSuggestions', 'MEMORY_SUGGESTIONS_FAILED', "Couldn't update your memory suggestions right now."],
      ['refreshSettings', 'SETTINGS_LOAD_FAILED', "Couldn't load your settings right now."],
      ['saveTalk', 'SETTINGS_SAVE_FAILED', "Couldn't save your settings right now."],
      ['saveModel', 'SETTINGS_SAVE_FAILED', "Couldn't save your settings right now."],
      ['saveReplay', 'SETTINGS_SAVE_FAILED', "Couldn't save your settings right now."],
      ['deleteRecordings', 'RECORDINGS_DELETE_FAILED', "Couldn't delete your recordings right now."],
      ['refreshAccounts', 'ACCOUNTS_FAILED', "Couldn't check your accounts right now."],
      ['stopJob', 'JOBS_STOP_FAILED', "Couldn't stop that job right now."],
      ['editJob', 'JOBS_EDIT_FAILED', "Couldn't start the edited job right now."],
    ])('%s says %s, never raw "error"', (fn, name, text) => {
      const body = fnBody(fn);
      expect(body).toContain(`plainFailure(msg.message, ${name})`);
      expect(body).not.toMatch(/msg\.message \?\?/);
      expect(client).toContain(`let ${name} = "${text}"`);
    });
    it('plainFailure keeps only a sentence, else the fallback', () => {
      const fn = client.match(/func plainFailure\([\s\S]*?\n\}/)?.[0] ?? '';
      expect(fn).toContain('m.first?.isUppercase == true, m.hasSuffix(".") else { return fallback }');
    });
  });

  it('R10a-2 (#94): Try again re-sends only a typed bubble, by its source field, never its text or detail', () => {
    const chat = read('Components/ChatThread.swift');
    // The one guard: the last said bubble, and only when its source is .typed. No fallback to an older typed one.
    expect(chat).toContain(
      'guard let last = thread.last(where: { $0.kind == .said }), last.source == .typed else { return nil }',
    );
    const retry = chat.match(/func retryableText\([^)]*\) -> String\? \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(retry).not.toContain('detail');
    // retry() reaches sendChat only through that guard; it is the file's only sendChat.
    expect(chat).toContain('if let typed = retryableText(model.thread) { model.sendChat(typed) }');
    expect(chat.match(/sendChat\(/g)).toHaveLength(1);
    // The button exists only when the guard passes (nil retry, no button).
    expect(chat).toContain('retry: canRetry ? { retry() } : nil');
    expect(chat).toContain('let canRetry = retryableText(thread) != nil');
    expect(chat).toContain('if isLast, let retry = retry { QuietButton("Try again", action: retry) }');
  });

  it('R10a-2 siblings: spoken, wake word, phone, cli and unknown bubbles are never typed; typed and edited ones are', () => {
    // Every .said bubble names its source. Typed paths (sendChat, editMessage) are .typed; nothing else is.
    const said = [...client.matchAll(/addBubble\(\.said, [^\n]*/g)].map((m) => m[0]);
    expect(said).toHaveLength(3);
    expect(said.filter((l) => l.endsWith('source: .typed)'))).toHaveLength(2);
    expect(said).toContain('addBubble(.said, text, detail: "", source: heardSource(msg.source))');
    // Heard sources map to their own case; unknown or missing maps to .other. No path returns .typed.
    const map = client.match(/func heardSource\(_ source: String\?\) -> ChatBubble\.Source \{([\s\S]*?)\n\}/)?.[1] ?? '';
    for (const [s, c] of [['voice-ptt', 'spoken'], ['voice-wake', 'wakeWord'], ['phone', 'phone'], ['cli', 'cli']]) {
      expect(map).toContain(`case "${s}": return .${c}`);
    }
    expect(map).toContain('default: return .other');
    expect(map).not.toContain('.typed');
    // The source is optional: Stephen's bubbles (reply, problem, info) are nil, which is never .typed.
    expect(client).toContain('var source: Source? = nil');
    expect(client).toContain('case typed, spoken, wakeWord, phone, cli');
  });

  it('owner 2026-11-26: no source label under a said bubble ("From: F5" is gone), typed or spoken', () => {
    const chat = read('Components/ChatThread.swift');
    const said = chat.match(/case \.said:([\s\S]*?)case \.reply:/)?.[1] ?? '';
    expect(said).toContain('Text(verbatim: bubble.text)');
    expect(said).not.toContain('bubble.detail');
    expect(said).not.toContain('bubble.source');
    expect(said).toContain('.accessibilityLabel("You: \\(bubble.text)")');
    expect(client).not.toContain('heardLabel');
    expect(client).not.toContain('From: F5');
  });

  it('R10a-5: Esc with a waiting question denies the first one (Ask box panel, Ask box view, main window Home)', () => {
    // One shared function: first question, approve false, nothing else.
    const deny = client.match(/func denyFirstConfirm\(\) -> Bool \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(deny).toContain('guard let q = confirms.first else { return false }');
    expect(deny).toContain('answerConfirm(q.id, approve: false)');
    expect(deny).not.toContain('approve: true');
    const box = read('AskBox.swift');
    // Panel path (cancelOperation -> onEscape): the question before the recording and close.
    const onEscape = box.match(/p\.onEscape = \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    expect(onEscape.indexOf('if self.model.denyFirstConfirm() { return }')).toBeGreaterThan(-1);
    expect(onEscape.indexOf('denyFirstConfirm')).toBeLessThan(onEscape.indexOf('cancelTalk'));
    expect(onEscape.indexOf('denyFirstConfirm')).toBeLessThan(onEscape.indexOf('close()'));
    expect(box).toContain('override func cancelOperation(_ sender: Any?) { onEscape() }');
    // SwiftUI path: question, then recording, then running chat, then close.
    const esc = box.match(/private func escape\(_ mode: AskBoxMode\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    const order = ['model.denyFirstConfirm()', 'actions.micCancel()', 'model.stopChat()', 'actions.close()'].map((s) => esc.indexOf(s));
    expect(order.every((i) => i >= 0), esc).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The question card (Ask box and Home both show ChatThreadView): Esc is a key equivalent on it, so it works while
    // the text field has focus. It only denies, and it sits outside the delayed Allow/Deny buttons.
    const chat = read('Components/ChatThread.swift');
    expect(chat).toMatch(/if let q = model\.confirms\.first \{[\s\S]*?Button\(""\) \{ model\.denyFirstConfirm\(\) \}\.keyboardShortcut\(\.cancelAction\)/);
    expect(chat.match(/\.cancelAction/g)).toHaveLength(1);
    // Same thread view in both (UI v4 step b adds navigation-only links after the model: ChatLinks).
    expect(read('HomeView.swift')).toMatch(/ChatThreadView\(model: model(, links: ChatLinks\(|\))/);
    expect(box).toMatch(/ChatThreadView\(model: model(, links: ChatLinks\(|\))/);
    // Nothing on the keyboard approves: Allow is only a click.
    for (const src of [chat, box, read('HomeView.swift')]) expect(src).not.toMatch(/approve: true|answer\(true\)[^\n]*keyboardShortcut/);
  });

  it('#88: Return in the ask field sends or adds a line, never answers a waiting question', () => {
    const controls = read('Components/Controls.swift');
    const field = controls.match(/struct AskField: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(field).toContain('axis: .vertical).lineLimit(1...5)');
    // Shift+Return: a new line in the field. Plain Return: falls through to onSubmit.
    expect(field).toMatch(/onKeyPress\(keys: \[\.return\][\s\S]*?modifiers\.contains\(\.shift\) else \{ return \.ignored \}[\s\S]*?insertNewlineIgnoringFieldEditor/);
    expect(field).toContain('.onSubmit(onSubmit)');
    expect(field).not.toMatch(/confirm|approve|answer|Allow/i);
    // What Return calls in the Ask box and on Home only sends the draft.
    for (const file of ['AskBox.swift', 'HomeView.swift']) {
      const src = read(file);
      expect(src).toMatch(/AskField\([^\n]*onSubmit: send\)/);
      const send = src.match(/private func send\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
      expect(send.trim()).toMatch(/^if model\.sendChat\((box\.)?draft\) \{ (box\.)?draft = "" \}/);
    }
  });

  it('#144: offline view uses the theme, says it in words, and has Start in the window and the Ask box', () => {
    const offline = read('AppWindow.swift').match(/struct OfflineView: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(offline).toContain('@Environment(\\.stephenTheme) var t');
    expect(offline).not.toMatch(/foregroundColor\(\.secondary\)|\.title3|`|Button\("Retry"\)/);
    expect(offline).toContain('case .stopped: return "Stephen is not running"');
    expect(offline).toContain('PrimaryButton("Start") { problem = nil; control.start { problem = $0 } }');
    expect(offline).toMatch(/DisclosureGroup \{[\s\S]*?model\.offlineReason|offlineReason[\s\S]*?DisclosureGroup/);
    // Settings keeps Appearance while offline.
    expect(window).toMatch(/if model\.connection != \.online \{\s*if nav\.page == \.settings \{[\s\S]*?AppearanceSettings\(\)/);
    // The Ask box: the same Start, wired to StephenControl.start in main.swift.
    const box = read('AskBox.swift');
    expect(box).toContain('PrimaryButton("Start") { box.startProblem = nil; actions.start { box.startProblem = $0 } }');
    expect(box).toContain('start: { [weak self] done in self?.start(done) }');
    expect(read('main.swift')).toContain('box.start = { done in stephenControl.start(done) }');
  });

  it('#138: a waiting question shows a banner on every page that only opens the card, and a badge on Home', () => {
    const main = read('MainWindow.swift');
    // Above the page switch, so every page (and the offline view) gets it.
    expect(main).toMatch(/if !model\.confirms\.isEmpty \{ questionBanner \}\s*detail\.frame/);
    const banner = main.match(/private var questionBanner: some View \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(banner).toContain('"Stephen is waiting for your OK"');
    // Safety: the one action opens the Ask box. No Allow, no answer, no keyboard shortcut, no third-party text.
    expect(banner.match(/\{ [^{}]*\(\) \}/g)).toEqual(['{ actions.ask() }']);
    expect(banner).not.toMatch(/Allow|approve|answer|denyFirstConfirm|keyboardShortcut|onSubmit|\.prompt|\.text\b|\.title\b/);
    // Badge: Home's row counts the waiting questions; the sidebar row says it in words for VoiceOver.
    expect(main).toContain('badge: p == .home ? model.confirms.count : 0');
    expect(read('Components/Sidebar.swift')).toContain('"1 question waiting"');
    // The dead Home branch is gone (a waiting question makes the chat non-empty, so the line never showed).
    expect(read('HomeView.swift')).not.toContain('"Answer"');
  });

  it('#147: Cmd+comma opens Settings on the last pane, one large title, captions over the choices', () => {
    const settings = read('SettingsPage.swift');
    expect(settings).toContain('@AppStorage("settingsPane") private var item: SettingsItem = .voice');
    // The toolbar and the palette read the same key, so all three agree on the pane.
    for (const f of ['MainWindow.swift', 'Palette.swift']) expect(read(f)).toContain('@AppStorage("settingsPane") private var pane: SettingsItem = .voice');
    // A pane stored before step c opens its new home (not the default).
    const init = settings.match(/init\?\(rawValue: String\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(init).toContain('case "connected", "phone", "accounts", "browsers": self = .connected');
    expect(init).toContain('case "voice", "talk", "wake": self = .voice');
    expect(init).toContain('case "about", "speed": self = .about');
    for (const c of ['aboutYou', 'privacy', 'routines', 'model', 'appearance']) expect(init).toContain(`case "${c}": self = .${c}`);
    expect(init).toContain('default: return nil');
    // UI v4 step c: the sub-list's labels are its group names (You, Stephen, App), not a second "Settings".
    expect(settings).toContain('Text(verbatim: g.title).sectionLabelStyle(t)');
    expect(settings).not.toContain('Text(verbatim: "Settings")');
    expect(settings).not.toMatch(/"Settings"\)\.font\(TypeScale\.pageTitle\)/);
    // #189: the choices are system Pickers with the label above them (Caption), segmented for 2 to 3, menu for more.
    for (const label of ['Length', 'Tone']) {
      expect(settings).toMatch(new RegExp(`Caption\\("${label}"\\)[\\s\\S]*?Picker\\("${label}", selection: bind[^\\n]*\\n[\\s\\S]*?\\.pickerStyle\\(\\.segmented\\)`));
    }
    for (const label of ['Model', 'Effort']) {
      expect(settings).toMatch(new RegExp(`Caption\\("${label}"\\)[\\s\\S]*?Picker\\("${label}", selection:[\\s\\S]*?\\.pickerStyle\\(\\.menu\\)`));
    }
    expect(settings).not.toContain('Segmented(');
    expect(settings).toContain('private struct Caption: View');
    const app = read('AppWindow.swift');
    expect(app).toContain('NSMenuItem(title: "Settings…", action: #selector(settingsClicked(_:)), keyEquivalent: ",")');
    expect(app).toContain('@objc func settingsClicked(_ sender: Any?) { show(page: .settings) }');
    // ⌘, only opens Settings: nothing on that path picks a pane, so the last one used shows (#147).
    expect(app).not.toMatch(/settingsClicked[^\n]*(selectSettingsPane|settingsPane)/);
    expect(settings.match(/selectSettingsPane\(/g)).toHaveLength(1);  // only its definition
  });

  it('#145 (now part): job and voice rows are real buttons; small controls have 24 pt targets', () => {
    const jobs = read('JobsPage.swift'), lists = read('Components/Lists.swift');
    // Tab (Full Keyboard Access) reaches buttons, not tap gestures.
    for (const src of [jobs, lists]) expect(src).not.toContain('onTapGesture');
    expect(jobs).toContain('Button(action: toggle) {');
    expect(jobs).toMatch(/Image\(systemName: "chevron\.right"\)[\s\S]*?frame\(width: 24, height: 24\)/);
    expect(lists).toContain('Button(action: onSelect) {');
    expect(lists).toMatch(/"play\.circle"[\s\S]*?frame\(width: 24, height: 24\)/);
    expect(read('Components/Controls.swift')).toMatch(/Image\(systemName: "mic"\)[^\n]*\n\s*\.frame\(width: 24, height: 24\)/);
    expect(read('Components/ChatThread.swift')).toContain('.foregroundColor(t.ink2).frame(minHeight: 24)');
    const memory = read('MemoryPage.swift');
    // The ⋯ menu and the Related links (the "‹ Personal" back link, the third one, went in UI v4 step d).
    expect(memory).toContain('.menuStyle(.borderlessButton).fixedSize().frame(minWidth: 24, minHeight: 24)');
    expect(memory).toMatch(/Text\(verbatim: r\.text\)[^\n]*\n\s*\.frame\(minHeight: 24\)/);
  });

  // Any write to the questions list: =, +=, subscript, or a mutating method. Any confirm.answer request, with or
  // without the AppRequest. prefix.
  const CONFIRMS_WRITE = /\bconfirms\s*(=[^=]|\+=|\[|\.(append|insert|remove\w*|popLast|swapAt|sort|reverse|shuffle)\b)/;
  const CONFIRM_ANSWER = /\.confirmAnswer\(/;

  it('the confirm guard catches each kind of write it is meant to catch', () => {
    for (const bad of [
      'model.confirms = []', 'confirms += [q]', 'confirms[0] = q', 'confirms.swapAt(0, 1)', 'confirms.append(q)',
      'confirms.removeAll { _ in true }', 'confirms.removeFirst()',
    ]) expect(bad, bad).toMatch(CONFIRMS_WRITE);
    for (const ok of ['if confirms == [] {}', 'confirms.isEmpty', 'confirms.first', 'confirms.count']) expect(ok, ok).not.toMatch(CONFIRMS_WRITE);
    for (const bad of ['request(AppRequest.confirmAnswer(id, confirmId: c, approve: true))', 'model.request(.confirmAnswer(a, confirmId: b, approve: true))'])
      expect(bad, bad).toMatch(CONFIRM_ANSWER);
  });

  it('AppClient split: Allow / Deny live in AppConfirm.swift, and only the model and that file change the questions', () => {
    const confirm = read('AppConfirm.swift');
    expect(confirm).toContain('func answerConfirm(_ confirmId: String, approve: Bool) {');
    expect(confirm).toContain('func denyFirstConfirm() -> Bool {');
    // confirms is no longer private(set) (the extension needs it), so check the writers by hand: no other helper file
    // assigns it or changes it in place, and only AppConfirm.swift sends confirm.answer.
    const others = readdirSync(helperSourceDir(), { recursive: true }).map(String)
      .filter((f) => f.endsWith('.swift') && f !== 'AppClient.swift' && f !== 'AppConfirm.swift');
    expect(others.length).toBeGreaterThan(10);
    for (const f of others) {
      const src = read(f);
      expect(src, f).not.toMatch(CONFIRMS_WRITE);
      expect(src, f).not.toMatch(CONFIRM_ANSWER);
    }
    expect(read('AppClient.swift')).not.toMatch(CONFIRM_ANSWER);
  });

  it('untrusted text is never rendered as Markdown: every Text(...) with a non-literal is Text(verbatim:)', () => {
    for (const src of [window, client, read('AskBox.swift'), read('Components/ChatThread.swift')]) {
      const bad = src.match(/\bText\((?!verbatim:|")[^)]*\)/g) ?? [];
      expect(bad).toEqual([]);
    }
  });

  it('Personal is gone (UI v4): its parts (personal.summary, accounts) are read-only Settings panes; Home\'s Next up line', () => {
    expect(window).not.toContain('PersonalView');
    const settings = read('SettingsPage.swift');
    expect(settings).toContain('model.refreshPersonal()');
    expect(settings).toContain('case .aboutYou: AboutYouSettingsPane(model: model)');
    expect(settings).toContain('case .routines: RoutinesSettingsPane(model: model)');
    expect(settings).toContain('case .connected: ConnectedSettingsPane(model: model, control: control)');
    expect(settings).toMatch(/struct PrivacySettingsPane[\s\S]*?PermissionsSection\(model: model\)/);
    expect(client).toContain('AppRequest.personalSummary(newId())');
    expect(client).toContain('if type == "personal" { personal = try? PersonalSummary(from: decoder) }');
    // View only: the moved parts never write.
    const moved = settings.slice(settings.indexOf('// MARK: From Personal'));
    expect(moved.length).toBeGreaterThan(100);
    expect(moved).not.toMatch(/model\.(add|update|clear|forget|stop|send|save|delete)\w*\(/);
    expect(moved).toContain('PermissionTable(');
    expect(window).toContain('model.refreshAccounts()');
    // Home's Next up line (plan 6.1, R8) has no "What's my day?" link: Home sends only from its composer's Send.
    const home = read('HomeView.swift');
    expect(home).not.toContain('APP_TODAY_PROMPT');
    expect(home.match(/sendChat\(/g)).toHaveLength(1);
    expect(home).toContain('if model.sendChat(draft) { draft = "" }');
    // "Next up:" only before a running job; with nothing running Home just says "Nothing waiting".
    expect(home).toMatch(/if running > 0 \{\s*Text\(verbatim: "Next up:"\)/);
    expect(home).toContain('Button { nav.page = .jobs }');
    expect(client).toContain('AppRequest.accountsStatus(newId())');
    // Only system colours.
    expect(window).not.toMatch(/Color\((red|green|blue|white|black):/);
  });

  it('Memory page (UI-V4-IA-PLAN 6.3): intro, graph, list alternative, inspector, proposals, Tell Stephen', () => {
    const page = read('MemoryPage.swift');
    expect(window).toContain('case .memory: MemoryPage(model: model)');
    expect(page).toContain('model.refreshMemoryPage()');
    expect(page).toContain('Text(verbatim: "Things Stephen remembers about you. It only saves what you tell it or keep.")');
    // Keep and Skip happen only on a click; Tell Stephen only proposes. The page never calls memory.add.
    expect(page).not.toContain('addMemory');
    // No Swift file can build a memory.add request at all (the unused builder was removed): fewer memory write paths.
    for (const f of HELPER_SOURCES) for (const t of WINDOW_NEVER_SENDS) expect(read(f)).not.toContain(`"${t}"`);
    expect(page).toContain('model.proposeMemory(text)');
    expect(page).toMatch(/PrimaryButton\("Keep"\) \{ model\.keepProposal\(/);
    expect(page).toContain('model.skipProposal(');
    // Search (⌘F), the usage chip only over 80% (R10: no usage line in the ⋯ menu), ⋯ with Forget all….
    expect(page).toContain('if let u = model.memoryUsage, u.warn');
    expect(page).not.toContain('% of 8 KB per chat")');
    expect(page).toContain('Button("Forget all…") { confirmClear = true }');
    expect(page).toContain('.keyboardShortcut("f", modifiers: .command)');
    expect(page).toContain('Segmented("Show memory as"');
    expect(page).toContain('.accessibilityLabel(nodeLabel(n))');
    // Third-party proposals say so.
    expect(page).toContain('third-party text');
    expect(client).toContain('func originLabel(_ origin: String) -> String');
    expect(client).toContain('if let o = item.origin');
  });

  it('Memory step d [DEV REVIEW]: New from your chats comes first, verbatim, Keep/Edit/Skip only on a click', () => {
    const page = read('MemoryPage.swift');
    const body = page.match(/struct MemoryPage: View \{[\s\S]*?\n  var body: some View \{([\s\S]*?)\n  \}\n/)?.[1] ?? '';
    const order = ['if !model.suggestions.isEmpty { proposals }', 'header', 'chips', 'Segmented("Show memory as"', 'graphOrList', 'tellBox', 'aboutMemory'];
    const at = order.map((s) => body.indexOf(s));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    // Selected beside the graph (wide) or under it (narrow, #148).
    expect(body).toMatch(/ViewThatFits\(in: \.horizontal\) \{\s*HStack[\s\S]*?graphOrList\s*inspector[\s\S]*?VStack[\s\S]*?graphOrList\s*inspector/);
    const block = page.slice(page.indexOf('  private var proposals: some View {'), page.indexOf('  // MARK: about'));
    expect(block).toContain('Text(verbatim: p.text)');
    expect(block).toContain('" · third-party text, check it"');
    expect(block).toMatch(/PrimaryButton\("Keep"\) \{ model\.keepProposal\(p\.id\) \}/);
    expect(block).toContain('QuietButton("Edit")');
    expect(block).toContain('QuietButton("Skip") { model.skipProposal(p.id) }');
    // Nothing saves on its own: no Return, appear or timer path in the block.
    expect(block).not.toMatch(/onSubmit|onAppear|\.task|onChange|onReceive/);
    // The inspector's edit field: Return never keeps a suggestion (n.new); Keep stays a click.
    const mem = read('MemoryPage.swift');
    expect(mem).toContain('.onSubmit { if !n.new { saveEdit(n) } }');
    expect(mem.match(/\.onSubmit/g)).toHaveLength(1);
    // Keep on an empty edit says so and keeps the field open; it never closes silently.
    const keepEdited = mem.match(/private func keepEdited\(_ p: MemoryProposal\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(keepEdited).toContain('if text.isEmpty { emptyNote = "Empty, nothing kept."; return }');
    expect(keepEdited.indexOf('if text.isEmpty')).toBeLessThan(keepEdited.indexOf('editingProposal = nil'));
    expect(block).toContain('if let e = emptyNote { Text(verbatim: e)');
    // The old place under the graph is gone: one proposals block, no "Nothing new" row.
    expect(page.match(/GroupedList\("New from your chats"\)/g)).toHaveLength(1);
    expect(page).not.toContain('"Nothing new"');
    // About memory: closed accordion with what counts toward the 8 KB.
    expect(page).toContain('Accordion("About memory", key: "acc.memory.about")');
    expect(page).toMatch(/Accordion\("About memory"[\s\S]*?up to 8 KB/);
  });

  it('Personal routes are gone (UI v4 step d, [DEV REVIEW]): no back link, no Page.personal, Esc stays on Memory', () => {
    const all = readdirSync(helperSourceDir(), { recursive: true }).map(String).filter((f) => f.endsWith('.swift')).map(read).join('\n');
    expect(all).not.toMatch(/[\s(=,\[]\.personal\b/);  // a page value; model.personal (Settings data) stays
    expect(all).not.toContain('‹ Personal');
    expect(all).not.toContain('Back to Personal');
    const main = read('MainWindow.swift');
    expect(main).toContain('case home, conversations, activity, jobs, memory, settings\n');
    const page = read('MemoryPage.swift');
    expect(page).not.toContain('nav.');
    expect(page).toContain('.onExitCommand { editing = false; editingProposal = nil }');
    // An old stored "personal" page can't route anywhere: the window stores no page, and any future restore must fall
    // back with `Page(rawValue:) ?? .<page>`.
    expect(all).not.toMatch(/@AppStorage\("(page|lastPage|windowPage)"\)/);
    for (const m of all.matchAll(/Page\(rawValue:[^\n]*/g)) expect(m[0]).toMatch(/\?\? \.\w+/);
  });

  it('Jobs page is wired to the protocol, shows job text verbatim', () => {
    const jobs = read('JobsPage.swift');
    expect(window).toContain('case .jobs: JobsView(model: model)');
    expect(jobs).toContain('model.refreshJobs()');
    expect(jobs).toContain('model.stopJob(');
    expect(client).toContain('AppRequest.jobsList(newId())');
    expect(client).toContain('AppRequest.jobsStop(newId(), jobId:');
    expect(jobs).toContain('NSWorkspace.shared.activateFileViewerSelecting');
    // Refresh on appear, then every 5 s only while a job runs (#202): no always-on timer.
    expect(jobs).not.toContain('Timer.publish');
    expect(jobs).toContain('.task(id: !running.isEmpty)');
    expect(jobs).toMatch(/while !Task\.isCancelled && model\.jobs\.contains\(where: \{ \$0\.isRunning \}\)/);
    expect(jobs).toContain('Task.sleep(nanoseconds: 5_000_000_000)');
    // Stop only for a job that has not ended; status is a word (not color alone).
    expect(jobs).toMatch(/if job\.isRunning \{ QuietButton\("Stop"/);
    // Facts line: "Started 2:10 PM · 3 min · $0.12 spent".
    expect(jobs).toContain('parts.append("Started " + ');
    expect(jobs).toContain('return parts.joined(separator: " · ")');
  });

  // R7d: loading, error and empty in words. A failed list never reads as "No jobs yet", and never shows raw "error".
  it('Jobs page shows loading, error with Try again, and empty only after a good list', () => {
    const jobs = read('JobsPage.swift');
    expect(client).toContain('@Published private(set) var jobsListOk: Bool? = nil');
    const refresh = client.slice(client.indexOf('func refreshJobs()'), client.indexOf('func refreshPersonal()'));
    expect(refresh).toContain('self.assign(\\.jobsListOk, true)');
    expect(refresh).toContain('self.assign(\\.jobsListOk, false)');
    expect(refresh).not.toContain('msg.message ?? "error"');
    expect(jobs).toContain('switch model.jobsListOk');
    expect(jobs).toMatch(/case nil:[\s\S]*JOBS_LOADING[\s\S]*case false\?:[\s\S]*JOBS_LIST_FAILED[\s\S]*QuietButton\("Try again"[\s\S]*model\.refreshJobs\(\)[\s\S]*case true\?:[\s\S]*JOBS_EMPTY/);
    expect(jobs).toContain('let JOBS_LIST_FAILED = "Couldn\'t load your jobs right now."');
    // Activity lists jobs too: a failed list is said there as well, never silent.
    expect(read('ActivityPage.swift')).toContain('model.jobsListOk == false ? JOBS_LIST_FAILED : nil');
  });

  // ADR-010 Edit request ([DEV REVIEW]): off while queued or running (with the line), the editor only sends the text,
  // the listener shows the job dialog; "Version N of M"; all verbatim; the palette never reaches it.
  it('ADR-010 Jobs: Edit request button and its disabled line, the editor, the version label, Text(verbatim:), not in the palette', () => {
    const jobs = read('JobsPage.swift');
    const item = jobs.match(/private struct JobItem: View \{([\s\S]*?)\n\}\n/)?.[1] ?? '';
    expect(item.length).toBeGreaterThan(1000);
    // One button, off while the job is queued or running; Stop stays next to it (running rows only).
    expect(item.match(/QuietButton\("Edit request"/g)).toHaveLength(1);
    expect(item).toMatch(/if job\.isRunning \{ QuietButton\("Stop"[^\n]*\n(\s*\/\/[^\n]*\n)?\s*QuietButton\("Edit request", symbol: "pencil"\) \{ draft = job\.request; editing = true \}\s*\.disabled\(job\.isRunning\)/);
    expect(jobs).toContain('let JOB_EDIT_STOP_FIRST = "Stop the job first to change its request."');
    expect(item).toContain('if job.isRunning { Text(verbatim: JOB_EDIT_STOP_FIRST)');
    expect(item).toContain('if editing && !job.isRunning { editor }');
    // The editor: prefilled with the old request; Continue (off while running or empty) and Cancel; it only sends.
    expect(item).toMatch(/TextField\("Edit the request", text: \$draft\)/);
    expect(item).toMatch(/QuietButton\("Continue", symbol: "arrow\.right"\) \{ sendDraft\(\) \}\s*\.disabled\(job\.isRunning \|\|/);
    expect(item).toContain('QuietButton("Cancel") { editing = false }');
    expect(item).toMatch(/private func sendDraft\(\) \{\s*guard !job\.isRunning, [^\n]*\n\s*edit\(draft\)\s*editing = false\s*\}/);
    expect(item).toContain('nothing starts until you allow it');
    // Wired once: the row's edit goes to model.editJob, which sends jobs.edit with the control timeout (the dialog).
    expect(jobs.match(/model\.editJob\(/g)).toHaveLength(1);
    expect(jobs).toContain('edit: { model.editJob(job.id, request: $0) })');
    const all = readdirSync(helperSourceDir(), { recursive: true }).map(String).filter((f) => f.endsWith('.swift'));
    const uses = (re: RegExp) => all.flatMap((f) => (read(f).match(re) ?? []).map(() => f));
    expect(uses(/"jobs\.edit"/g)).toEqual(['AppProtocol.swift']);
    expect(uses(/AppRequest\.jobsEdit\(/g)).toEqual(['AppClient.swift']);
    expect(uses(/\beditJob\(/g).sort()).toEqual(['AppClient.swift', 'JobsPage.swift']);
    expect(client).toContain('request(AppRequest.jobsEdit(newId(), jobId: jobId, text: text), timeout: APP_CONTROL_TIMEOUT_SECONDS)');
    // The edited request is capped as the listener caps it (EDIT_REQUEST_MAX), with a counter; Continue is off over it.
    expect(jobs).toContain(`let JOB_EDIT_MAX = ${EDIT_REQUEST_MAX}\n`);
    expect(item).toContain('Text(verbatim: "\\(jobEditCount(draft)) of \\(JOB_EDIT_MAX) characters")');
    expect(item).toMatch(/QuietButton\("Continue"[^\n]*\n\s*\.disabled\([^\n]*\|\| jobEditCount\(draft\) > JOB_EDIT_MAX\)/);
    expect(item).toMatch(/guard [^\n]*jobEditCount\(draft\) <= JOB_EDIT_MAX else \{ return \}/);
    // The real id (an edited job's -v<N>) shows only once the job started: the started line and the open row.
    expect(client).toContain('if msg.type == "job", let row = msg.job { self.jobsNotice = nil; self.jobStarted = "Job started: \\(row.id)" }');
    expect(jobs).toContain('if let s = model.jobStarted { Text(verbatim: s)');
    expect(item).toContain('Text(verbatim: "Job \\(job.id)")');
    // Version N of M, verbatim, only when there is more than one version.
    expect(jobs).toContain('return job.versions > 1 ? "Version \\(job.version) of \\(job.versions)" : nil');
    expect(item).toContain('if let v = jobVersionText(job) { Text(verbatim: v)');
    expect(read('AppProtocol.swift')).toContain('case id, task, status, createdAt, startedAt, endedAt, turns, costUsd, folder, summary, error, request, version, versions');
    // All text on the page stays verbatim.
    expect(jobs.match(/\bText\((?!verbatim:)[^)]*\)/g) ?? []).toEqual([]);
    // Cancel in the editor sends nothing: it only closes the editor. The row's edit (jobs.edit) runs only in sendDraft,
    // which only Continue reaches; opening the editor sends nothing either.
    expect(item.match(/\bedit\(/g)).toHaveLength(1);
    expect(item.match(/\bsendDraft\(\)/g)).toHaveLength(2); // called by Continue, defined once
    expect(item).not.toMatch(/onSubmit/);
    expect(item.match(/QuietButton\("Cancel"\) \{([^}]*)\}/)?.[1]?.trim()).toBe('editing = false');
    expect(item.match(/QuietButton\("Edit request", symbol: "pencil"\) \{([^}]*)\}/)?.[1]?.trim()).toBe('draft = job.request; editing = true');
    // The palette never reaches it.
    expect(read('Palette.swift')).not.toMatch(/editJob|jobsEdit|jobs\.edit|Edit request/);
    expect(PALETTE_MEMBERS).not.toContain('editJob');
  });

  it('Jobs step d (plan 6.4): caution intro, Running open, Failed open [DEV REVIEW], Earlier accordion, Stop on running only', () => {
    const jobs = read('JobsPage.swift');
    // R9: the caution once, in the intro; the summary keeps its label.
    expect(jobs).toContain('Each summary is written by the job: check it before you rely on it.');
    expect(jobs).not.toContain('The summary is written by the job itself');
    expect(jobs).toContain('Text(verbatim: "Summary, written by the job")');
    expect(jobs).toContain('Text(verbatim: job.task)');
    const body = jobs.match(/struct JobsView: View \{[\s\S]*?\n  var body: some View \{([\s\S]*?)\n  \}\n/)?.[1] ?? '';
    expect(body).toContain('if !running.isEmpty { GroupedList("Running") { rows(running) } }');
    // A failed job is never hidden: its group is open, and not inside any Accordion.
    const failedLine = body.split('\n').find((l) => l.includes('GroupedList("Failed")')) ?? '';
    expect(failedLine).toContain('if !failed.isEmpty { GroupedList("Failed") { rows(failed) } }');
    expect(body.match(/Accordion\(/g)).toHaveLength(1);
    const accordion = body.slice(body.indexOf('Accordion('));
    expect(accordion).not.toContain('"Failed"');
    expect(body.indexOf('GroupedList("Failed')).toBeLessThan(body.indexOf('Accordion('));
    // Every failed job, however old, is in Failed; Earlier (a closed accordion) never holds one (#254 review).
    expect(body).toContain('let failed = model.jobs.filter(jobFailed)');
    expect(body).toContain('let earlier = model.jobs.filter { !$0.isRunning && !jobFailed($0) }');
    expect(jobs).not.toContain('jobFailedRecently');
    expect(jobs).not.toMatch(/24 \* 3600/);
    expect(body).toContain('Accordion(jobsEarlierTitle(earlier), key: "acc.jobs.earlier") { GroupedList { rows(earlier) } }');
    expect(jobs).toContain('func jobsEarlierTitle(_ jobs: [JobRow]) -> String { return "Earlier (\\(jobs.count))" }');
    // Stop: exactly one, on running rows only.
    expect(jobs.match(/QuietButton\("Stop"/g)).toHaveLength(1);
    expect(jobs).toMatch(/if job\.isRunning \{ QuietButton\("Stop", destructive: true, action: stop\)/);
  });

  it('Conversations page replaces History and Audit: one list, joined by time, refusals in words, search', () => {
    const conv = read('ConversationsPage.swift');
    expect(window).toContain('case .conversations: ConversationsPage(model: model, nav: nav)');
    // Clear all moved to the toolbar's ⋯ menu (UI v4); it still asks first, on the page.
    expect(conv).toContain('.alert("Clear all conversations?", isPresented: $nav.confirmClearAll)');
    expect(read('MainWindow.swift')).toContain('Button("Clear all…", role: .destructive) { nav.confirmClearAll = true }');
    expect(window).not.toContain('AuditView');
    expect(window).not.toContain('HistoryView');
    expect(conv).toContain('model.refreshHistory(); model.refreshAudit()');
    expect(conv).toContain('Refused: ');
    expect(conv).toContain('Clear all conversations?');
    expect(conv).toContain('Text(verbatim: entry.said)');
  });

  it('T6 step 4: Activity reads only, shows every string verbatim, and never uses args, intent or error text', () => {
    const act = read('ActivityPage.swift');
    expect(read('MainWindow.swift')).toContain('case .activity: ActivityPage(model: model, nav: nav)');
    expect(act.match(/\bText\((?!verbatim:)[^)]*\)/g) ?? []).toEqual([]);
    expect(act).toContain('Text(verbatim: row.text)');
    // Only reads and refreshes, plus the versions read a Conversations row makes when it opens.
    const calls = [...new Set(act.match(/model\.\w+(?=\()/g) ?? [])].sort();
    expect(calls).toEqual(['model.loadVersions', 'model.refreshAudit', 'model.refreshHistory', 'model.refreshJobs']);
    expect(act).not.toMatch(/AppRequest|\.send\(|chatSend|stopJob/);
    // Never shown: args (not decoded at all), the model's intent, error text. URLs only through activityHost.
    expect(read('AppProtocol.swift')).not.toMatch(/struct AuditEntry[\s\S]*?\bargs\b[\s\S]*?\n\}/);
    expect(act).not.toMatch(/\.(intent|error|args)\b/);
    expect(act.match(/\.url(Before|After)\b(?!\.isEmpty)/g)?.length).toBe(act.match(/activityHost\([^)]*\.url(Before|After)\)/g)?.length);
    expect(read('AppProtocol.swift')).toContain('case ts, tool, outcome, kind, intent, element, urlBefore, urlAfter, verdict, error, confirmation, cmd, tab }');
    expect(read('AppClient.swift')).toContain('static let auditLimit = 200');
  });

  it('ADR-007 recents: history strings in Conversations are Text(verbatim:); no send or retry; v2 adds only Open in chat', () => {
    const conv = read('ConversationsPage.swift');
    // Every Text in the view is verbatim (said, reply, facts and step lines are third-party-shaped text).
    expect(conv.match(/\bText\((?!verbatim:)[^)]*\)/g) ?? []).toEqual([]);
    for (const s of ['entry.said', 'shown.said', 'shown.reply', 'facts', 'l.text']) expect(conv).toContain(`Text(verbatim: ${s})`);
    // Stored steps become the same step lines (shown by the verbatim ForEach above).
    expect(conv).toContain('if !entry.steps.isEmpty { return entry.steps.map { DoneLine(text: $0.text, status: StepStatus($0.status)) } }');
    // Only reads, Load older, Clear all and (ADR-007 v2) the resume arm: nothing sends stored text anywhere.
    const calls = [...new Set(conv.match(/model\.\w+(?=\()/g) ?? [])].sort();
    // ADR-010 adds the edit (editMessage, behind the editor's Send), the versions read and Delete this version.
    expect(calls).toEqual(['model.clearHistory', 'model.deleteVersion', 'model.editMessage', 'model.loadOlderHistory', 'model.loadVersions', 'model.refreshAudit', 'model.refreshHistory', 'model.resumeConversation', 'model.sourceLabel', 'model.timeText']);
    expect(conv).not.toMatch(/AppRequest|\.send\(|chatSend/);
    expect(conv).not.toMatch(/(Button|QuietButton)\("(Retry|Try again|Continue|Resume|Resend|Ask again)/i);
    // The one Send is the inline editor's (ADR-010, checked below).
    expect(conv.match(/(Button|QuietButton)\("Send"/g)).toHaveLength(1);
    // The protocol decodes conv, steps and (ADR-010) editOf.
    expect(read('AppProtocol.swift')).toContain('case id, ts, source, said, reply, outcome, tools, followUp, ms, conv, steps, editOf }');
  });

  // ADR-007 v2 ([DEV REVIEW]): resume has one entry point, the Open in chat button on an open Conversations row.
  it('ADR-007 v2: the helper sends chat.resume only from the Conversations row button; the palette cannot', () => {
    const all = readdirSync(helperSourceDir(), { recursive: true }).map(String).filter((f) => f.endsWith('.swift'));
    const uses = (re: RegExp) => all.flatMap((f) => (read(f).match(re) ?? []).map(() => f));
    // The wire type is built in one place, and that builder is called in one place: resumeConversation.
    expect(uses(/"chat\.resume"/g)).toEqual(['AppProtocol.swift']);
    expect(uses(/AppRequest\.chatResume\(/g)).toEqual(['AppClient.swift']);
    const app = read('AppClient.swift');
    const fn = app.match(/func resumeConversation\(_ conv: String\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(fn).toContain('request(AppRequest.chatResume(newId(), conv: conv))');
    // It only arms: no chat.send in it, and sendChat never sends chat.resume.
    expect(fn).not.toMatch(/chatSend|sendChat/);
    expect(app.match(/func sendChat\([\s\S]*?\n  \}/)?.[0] ?? '').not.toMatch(/chatResume|resume/i);
    // resumeConversation is called once in the whole helper: the page's openInChat, which the row button runs.
    expect(uses(/\bresumeConversation\(/g).sort()).toEqual(['AppClient.swift', 'ConversationsPage.swift']);
    const conv = read('ConversationsPage.swift');
    expect(conv.match(/\bresumeConversation\(/g)).toHaveLength(1);
    expect(conv).toMatch(/private func openInChat\(_ conv: String\) \{\s*model\.resumeConversation\(conv\)\s*nav\.page = \.home\s*\}/);
    expect(conv).toContain('openInChat: row.entry.conv.isEmpty ? nil : { openInChat(row.entry.conv) },');
    // ADR-010: the shown version's own conversation is the only other thing Open in chat continues.
    expect(conv).toContain('continueVersion: { openInChat($0) },');
    const item = conv.match(/private struct ConversationItem: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    // ADR-010: the row's own entry continues its conversation; another shown version continues its own branch.
    expect(item).toMatch(/if let open = openInChat, expanded \{\s*HStack\(spacing: Space\.s\) \{\s*(\/\/[^\n]*\n\s*)*QuietButton\("Open in chat", symbol: "bubble\.left", action: shown\.id == entry\.id \? open : \{ continueVersion\(shown\.conv\) \}\)/);
    expect(item.replace(/\/\/[^\n]*/g, '').match(/\bopen\b(?!InChat)/g)).toHaveLength(2); // bound once, used once: only the button runs it
    // Cancel: Home's line and New chat send chat.resume.cancel; the line is verbatim.
    expect(uses(/AppRequest\.chatResumeCancel\(/g)).toEqual(['AppClient.swift']);
    expect(app).toMatch(/func newChat\(\) \{\s*chatSince = chat\.last\?\.id \?\? 0\s*if resumeArmed \{ cancelResume\(\) \}\s*\}/);
    const home = read('HomeView.swift');
    expect(home).toContain('if model.resumeArmed { resumeLine }');
    expect(home).toContain('Text(verbatim: "Continuing an earlier chat. Your next message goes with it.")');
    expect(home).toContain('QuietButton("Cancel") { model.cancelResume() }');
    expect(read('AskBox.swift')).toContain('if model.resumeArmed { Text(verbatim: "Continuing an earlier chat")');
    // The arm follows the listener's push only.
    expect(app).toContain('case "resume":\n      resumeArmed = msg.armed ?? false');
    // The palette never reaches it: not in its source, and its allow list stays as it is (checked by the tests below).
    const pal = read('Palette.swift');
    expect(pal).not.toMatch(/resume|chatResume/i);
    expect(PALETTE_MEMBERS).not.toContain('resumeConversation');
    expect(PALETTE_MEMBERS).not.toContain('cancelResume');
  });

  // ADR-010 ([DEV REVIEW]): edit and resend has one entry point, Send (or Return) in an open Conversations row's editor.
  it('ADR-010 page: Edit only on the owner\'s messages; the voice-source lines; the plain line; the version switch; Text(verbatim:)', () => {
    const conv = read('ConversationsPage.swift');
    const item = conv.match(/private struct ConversationItem: View \{([\s\S]*?)\n\}\n?$/)?.[1] ?? '';
    expect(item.length).toBeGreaterThan(1000);
    // Edit: one button, next to what the owner said (shown.said), in the open row, with the accessibility label.
    expect(item.match(/QuietButton\("Edit"/g)).toHaveLength(1);
    expect(item).toMatch(/Text\(verbatim: shown\.said\)[\s\S]{0,400}QuietButton\("Edit", symbol: "pencil"\) \{ draft = shown\.said; editing = true \}\s*\.accessibilityLabel\("Edit this message"\)/);
    // Stephen's reply has none: nothing follows the reply's Text but the steps and the row's buttons.
    const afterReply = item.slice(item.indexOf('Text(verbatim: shown.reply)'));
    expect(afterReply).not.toContain('QuietButton("Edit"');
    // The voice-source line, word for word (ADR-010, "When the edited message was spoken by voice").
    expect(conv).toContain('case "voice-ptt": return "You said this with F5. Check the words before you send."');
    expect(conv).toContain('case "voice-wake": return "Heard by the wake word. It may not have been you. Check the words before you send."');
    expect(conv).toContain('case "phone": return "Sent from your phone. Check the words before you send."');
    expect(item).toMatch(/if let line = editSourceLine\(shown\.source\) \{\s*Text\(verbatim: line\)/);
    // The editor: prefilled, Send and Cancel, Send off while a command runs; Return in the field sends.
    expect(item).toMatch(/TextField\("Edit this message", text: \$draft\)[\s\S]*?\.onSubmit \{ sendDraft\(\) \}/);
    expect(item).toMatch(/QuietButton\("Send", symbol: "paperplane"\) \{ sendDraft\(\) \}\s*\.disabled\(busy \|\|/);
    expect(item).toContain('QuietButton("Cancel") { editing = false }');
    expect(item).toMatch(/private func sendDraft\(\) \{\s*guard !busy, [^\n]*\n\s*send\(shown, shown\.conv, draft\)/);
    expect(conv).toContain('versions: model.versions[row.entry.id], busy: model.isWorking,');
    // After Send: the Edited tag, the plain line once above the new reply, Version N of M with arrows.
    expect(item).toContain('if shown.editOf != nil { Text(verbatim: "Edited")');
    expect(item.match(/Actions from the old reply already happened\./g)).toHaveLength(1);
    expect(item.indexOf('Actions from the old reply already happened.')).toBeLessThan(item.indexOf('Text(verbatim: shown.reply)'));
    expect(item).toContain('Text(verbatim: "Version \\(i + 1) of \\(all.count)")');
    expect(item).toContain('.accessibilityLabel("Previous version")');
    expect(item).toContain('.accessibilityLabel("Next version")');
    expect(item).toContain('Text(verbatim: "The earlier part of this conversation has expired.")');
    // Only the shown version can be continued.
    expect(item).toContain('QuietButton("Open in chat", symbol: "bubble.left", action: shown.id == entry.id ? open : { continueVersion(shown.conv) })');
    // Delete this version: behind a confirm alert, and only that alert's button deletes.
    expect(item).toContain('QuietButton("Delete this version", destructive: true) { confirmDelete = true }');
    expect(item).toMatch(/\.alert\("Delete this version\?", isPresented: \$confirmDelete\) \{\s*Button\("Delete", role: \.destructive\) \{ deleteVersion\(shown\.id\)/);
    expect(item.match(/deleteVersion\(/g)).toHaveLength(1);
    // All stored text stays verbatim.
    expect(conv.match(/\bText\((?!verbatim:)[^)]*\)/g) ?? []).toEqual([]);
  });

  it('ADR-010: the helper sends chat.edit only from the editor\'s Send; opening, searching or switching never sends; the palette cannot', () => {
    const all = readdirSync(helperSourceDir(), { recursive: true }).map(String).filter((f) => f.endsWith('.swift'));
    const uses = (re: RegExp) => all.flatMap((f) => (read(f).match(re) ?? []).map(() => f));
    expect(uses(/"chat\.edit"/g)).toEqual(['AppProtocol.swift']);
    expect(uses(/AppRequest\.chatEdit\(/g)).toEqual(['AppClient.swift']);
    expect(uses(/AppRequest\.historyDeleteVersion\(/g)).toEqual(['AppClient.swift']);
    // editMessage is called once, by the page's sendEdit, which only the editor's sendDraft reaches (through `send`).
    expect(uses(/\beditMessage\(/g).sort()).toEqual(['AppClient.swift', 'ConversationsPage.swift']);
    const conv = read('ConversationsPage.swift');
    expect(conv).toMatch(/private func sendEdit\(_ old: HistoryEntry, _ conv: String, _ text: String\) \{\s*model\.editMessage\(old, viewing: conv, text: text\)\s*\}/);
    expect(conv.match(/\bsendEdit\(/g)).toHaveLength(2); // defined once, passed once as the row's `send`
    expect(conv).toContain('send: { old, conv, text in sendEdit(old, conv, text) },');
    const item = conv.match(/private struct ConversationItem: View \{([\s\S]*?)\n\}\n?$/)?.[1] ?? '';
    expect(item.replace(/\/\/[^\n]*/g, '').match(/\bsend\(/g)).toHaveLength(1); // only in sendDraft
    expect(item.match(/\bsendDraft\(\)/g)).toHaveLength(3); // the field's Return, the Send button, its definition
    // Toggle, search and the version switch read only.
    expect(conv).toMatch(/private func toggle\(_ id: String\) \{[^}]*model\.loadVersions\(id\)\s*\}/);
    expect(item).toMatch(/private var versionSwitch: some View \{[\s\S]*?\n  \}/);
    expect(item.match(/private var versionSwitch: some View \{([\s\S]*?)\n  \}/)?.[1]).not.toMatch(/send|edit\(|delete/i);
    // The app model: the text, the old id and the hash of the stored text, nothing else; refused while working.
    const app = read('AppClient.swift');
    const fn = app.match(/func editMessage\(_ old: HistoryEntry, viewing conv: String, text raw: String\) -> Bool \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(fn).toContain('guard !trimmed.isEmpty, connection == .online, !isWorking, !conv.isEmpty else { return false }');
    // ADR-010 review: it also names the conversation of the version on screen.
    expect(fn).toContain('request(AppRequest.chatEdit(newId(), oldId: old.id, oldHash: textHash(old.said), conv: conv, text: text))');
    expect(app).toContain('return SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()');
    expect(app.match(/func sendChat\([\s\S]*?\n  \}/)?.[0] ?? '').not.toMatch(/chatEdit/);
    // The palette never reaches it, and its allow list stays as it is.
    const pal = read('Palette.swift');
    expect(pal).not.toMatch(/editMessage|chatEdit|deleteVersion|loadVersions|versions/);
    for (const m of ['editMessage', 'deleteVersion', 'loadVersions', 'versions']) expect(PALETTE_MEMBERS).not.toContain(m);
    for (const m of ['editMessage', 'deleteVersion', 'loadVersions', 'versions']) expect(PALETTE_READS).not.toContain(m);
  });

  it('main window (UI v4 shell): two sidebar groups, shortcuts, remembered collapse, Start/Stop at the bottom left, Home', () => {
    const main = read('MainWindow.swift');
    expect(main).toContain('static let talk: [Page] = [.home, .conversations, .activity, .jobs]');
    expect(main).toContain('static let control: [Page] = [.memory, .settings]');
    expect(main).toContain('SidebarSection("Talk", collapsed: collapsed) { rows(Page.talk) }');
    expect(main).toContain('SidebarSection("Control", collapsed: collapsed) { rows(Page.control) }');
    expect(main).toContain('.keyboardShortcut(p.key!, modifiers: .command)');
    expect(main).toContain('.keyboardShortcut("\\\\", modifiers: .command)');
    // The state row sits at the bottom left (owner, 2026-11-21): after both groups and the spacer, the last view in the
    // sidebar's column.
    const sidebar = main.match(/private struct SidebarView: View \{[\s\S]*?\n  var body: some View \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(sidebar).toMatch(/SidebarSection\("Control"[^\n]*\n\s*\}\n\s*Spacer\(minLength: 0\)\n\s*\/\/[^\n]*\n\s*StatusRow\(model: model, control: control, collapsed: collapsed\)\n    \}/);
    expect(sidebar.match(/StatusRow\(/g)).toHaveLength(1);
    // R2: the fake "Ask Stephen" field is gone. The Ask box stays one click away: the banner, the palette, the app menu.
    expect(main).not.toContain('askField');
    expect(main).not.toContain('Button(action: nav.askHere)');
    // The Ask Stephen menu item still opens the Ask box, without ⌘K (⌘K is the palette since UI v4).
    expect(read('AppWindow.swift')).toContain('@objc func askClicked(_ sender: Any?) { actions.ask() }');
    expect(main).not.toContain('askHere');
    expect(read('main.swift')).toContain('WindowActions(ask: { askBox?.show(focus: true) }');
    expect(main).toContain('@AppStorage("sidebarCollapsed")');
    // Start/Stop go through the helper's StephenControl (one owner of the listener), not a second launcher.
    expect(main).toContain('control.start { problem = $0 }');
    expect(main).toContain('control.stop { problem = $0 }');
    expect(main).toContain('.stephenThemedBySettings()');
    const home = read('HomeView.swift');
    // A waiting question makes the chat non-empty, so Home shows the card (#138 banner covers the other pages).
    expect(home).toContain('model.thread.isEmpty && model.confirms.isEmpty');
    expect(read('AskBox.swift')).toContain('reviewMemory: { [weak self] in self?.openWindow(.memory) }');
  });

  it('Recording on sign (UI v4, [DEV REVIEW]): solid, words unchanged, right next to the state row at the bottom left', () => {
    const row = read('MainWindow.swift').match(/private struct StatusRow: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const sign = row.match(/if model\.recordingOn \{([\s\S]*?)\n      \}/)?.[1] ?? '';
    expect(sign).toContain('Text(verbatim: "Recording on")');
    expect(sign).toContain('Image(systemName: "waveform")');
    // Solid in the glass sidebar: surface fill and a lineStrong outline, no material.
    expect(sign).toContain('.background(RoundedRectangle(cornerRadius: Corner.row).fill(t.surface))');
    expect(sign).toContain('.overlay(RoundedRectangle(cornerRadius: Corner.row).stroke(t.lineStrong, lineWidth: 1))');
    expect(sign).not.toMatch(/glass|Material|opacity/i);
    expect(sign).toContain('.help("Your F5 commands are saved on this Mac for 30 days. Turn it off in Settings, Privacy and permissions.")');
    expect(sign).toContain('.accessibilityLabel("Recording on. F5 commands are saved on this Mac for 30 days.")');
    // Right next to the state row: the sign's block ends and the state row's HStack starts, nothing in between.
    expect(row).toMatch(/if model\.recordingOn \{[\s\S]*?\n      \}\n      HStack\(spacing: Space\.s\) \{\n        StatusPill\(s\.word/);
    // Not inside an accordion, and not hidden when the sidebar is collapsed (the waveform stays).
    expect(row).not.toMatch(/Accordion|DisclosureGroup/);
    expect(sign).not.toMatch(/if !collapsed \{[^\n]*waveform/);
  });

  it('Settings (UI v4 step c, plan 6.5): 8 panes in 3 labelled groups, each a grouped Form, rare things in accordions', () => {
    const settings = read('SettingsPage.swift');
    expect(settings).toContain('case aboutYou, connected, privacy, routines, voice, model, appearance, about');
    expect(settings).toContain('("You", [.aboutYou, .connected, .privacy, .routines]),');
    expect(settings).toContain('("Stephen", [.voice, .model]),');
    expect(settings).toContain('("App", [.appearance, .about]),');
    const titles = [...(settings.match(/var title: String \{([\s\S]*?)\n  \}/)?.[1] ?? '').matchAll(/case \.(\w+): return "([^"]+)"/g)].map((m) => m[2]);
    expect(titles).toEqual(['About you', 'Connected', 'Privacy and permissions', 'Routines', 'Voice', 'Model and effort', 'Appearance', 'About']);
    // The sub-list is built from the groups only.
    expect(settings).toContain('ForEach(SettingsItem.groups, id: \\.title) { g in');
    expect(settings).not.toContain('SettingsItem.allCases');
    // Every pane is a grouped Form (S7): the 7 here plus Appearance; the pane is not wrapped in a ScrollView.
    expect(settings).toContain('func settingsForm() -> some View { return formStyle(.grouped).scrollContentBackground(.hidden) }');
    const appearance = read('AppearanceSettings.swift');
    for (const pane of ['AboutYouSettingsPane', 'ConnectedSettingsPane', 'PrivacySettingsPane', 'RoutinesSettingsPane', 'VoiceSettingsPane', 'ModelSettingsPane', 'AboutSettingsPane']) {
      const body = settings.match(new RegExp(`struct ${pane}: View \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
      expect(body, pane).toMatch(/\bForm \{/);
      expect(body, pane).toContain('.settingsForm()');
    }
    expect(appearance).toMatch(/Form \{[\s\S]*\.settingsForm\(\)/);
    expect(settings.match(/struct SettingsView: View \{([\s\S]*?)\n\}/)?.[1]).not.toMatch(/ScrollView \{/);
    // A table goes straight into its section: the permission table has no box of its own.
    const table = read('Components/Lists.swift').match(/struct PermissionTable: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(table).not.toMatch(/\.background\(|\.overlay\(RoundedRectangle/);
    // The plan's accordions, closed by default (Accordion's AppStorage default), one key each.
    for (const [title, key] of [
      ['Where this comes from', 'acc.settings.aboutYou.source'], ['How to connect (Terminal)', 'acc.settings.connected.terminal'],
      ['Where these rules come from', 'acc.settings.privacy.rules'], ['Voices and fallback order', 'acc.settings.voice.voices'],
      ['Wake word and F5', 'acc.settings.voice.wake'], ['What the models cost and do', 'acc.settings.model.about'],
      ['Speed, last 7 days', 'acc.settings.about.speed'],
    ]) expect(settings).toContain(`Accordion("${title}", key: "${key}")`);
    expect(settings).toContain('Accordion("Doctor", key: Self.doctorKey)');
    // Connected: accounts, Zen and Chrome, and the phone link in one list, each with its state; one button each.
    const connected = settings.match(/struct ConnectedSettingsPane: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(connected).toContain('ForEach(model.accounts, id: \\.id)');
    expect(connected).toContain('FormRow("Zen and Chrome"');
    expect(connected).toContain('FormRow("Phone link"');
    expect(connected.match(/QuietButton\(/g)).toHaveLength(2);
    expect(connected).toContain('if phoneOn { control.phoneOff(done) } else { control.phoneOn(done) }');
    expect(read('StephenControl.swift')).toContain('func phoneLinkOn() -> Bool {');
    // Offline (#144): Settings still shows Appearance, with no ScrollView around the Form.
    const main = read('MainWindow.swift');
    const offline = main.match(/if nav\.page == \.settings \{([\s\S]*?)\n      \} else \{/)?.[1] ?? '';
    expect(offline).toContain('AppearanceSettings()');
    expect(offline).not.toMatch(/ScrollView \{/);
    // Personal is gone for good, and the old pane names with it.
    for (const old of ['AccountsSettingsPane', 'BrowsersSettingsPane', 'PhoneSettingsPane', 'WakeSettingsPane', 'TalkSettingsPane', 'SpeedSettingsPane', '"Privacy and safety"', '"How Stephen talks"']) {
      expect(window, old).not.toContain(old);
    }
  });

  it('Settings > Privacy and permissions ([DEV REVIEW]): the table, then the recording switch with the same words and behaviour', () => {
    const settings = read('SettingsPage.swift');
    const pane = settings.match(/private struct PrivacySettingsPane: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    // Order: the read-only table, the switch, then the rules accordion.
    const order = ['PermissionsSection(model: model)', 'Toggle(Self.label, isOn:', 'RulesSourceSection(model: model)'].map((x) => pane.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The switch's words and behaviour are unchanged.
    expect(pane).toContain('private static let label = "Save my F5 commands to measure mistakes"');
    expect(pane).toContain('Toggle(Self.label, isOn: Binding(get: { model.recordingOn }, set: { change($0) }))');
    // #189: the switch shows its label (no labelsHidden), on the theme's accent.
    expect(pane).toContain('.tint(t.accent).disabled(model.connection != .online)');
    expect(pane).not.toContain('FormRow(Self.label)');
    expect(pane).toContain('Note("Saves the audio and the words of commands you start with F5 (or the Ask box mic) on this Mac for 30 days. Never sent anywhere. The wake word never records.")');
    expect(pane).toContain('if model.connection != .online { Note("Start Stephen to change this.") }');
    expect(pane).toContain('.alert("Delete the saved recordings too?", isPresented: $askDelete)');
    expect(pane).toContain('Button("Keep", role: .cancel) { done = "Kept. They are deleted after 30 days." }');
    expect(pane).toMatch(/model\.saveReplay\(on\) \{ err in[\s\S]*?if err == nil && !on \{ askDelete = true \}/);
    // Only this pane sends the switch's requests.
    expect(window.match(/saveReplay\(/g)).toHaveLength(1);
    expect(window.match(/deleteRecordings\b/g)).toHaveLength(1);
    // The one honest sentence about the table (R5), and no "change them in Settings" claim.
    expect(settings).toContain('Note("Read only. These come from Stephen\'s safety rules.")');
    expect(settings).not.toMatch(/[Cc]hange them in Settings/);
    // The "proposes, you keep" promise shows even with no permissions data: outside the `if let`, in its own Section.
    const perms = settings.match(/private struct PermissionsSection: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const promise = 'Section { Note("Stephen never saves memory, sets timers or starts jobs on its own: it proposes, you keep.") }';
    expect(perms).toContain(promise);
    const ifBlock = perms.slice(perms.indexOf('if let p = model.personal?.permissions'), perms.indexOf('} else if let n = model.personalNotice'));
    expect(ifBlock).not.toContain('it proposes, you keep');
    expect(perms.indexOf(promise)).toBeGreaterThan(perms.indexOf('Section { Note(n) }'));
    // Links to it use the new pane (the refusal's "See what Stephen may do").
    expect(settings).toContain('case .privacy: return "Privacy and permissions"');
  });

  it('sidebar drag-to-resize (owner): clamped width kept in AppStorage, resize cursor, rail unchanged', () => {
    const theme = read('Theme.swift');
    const num = (name: string) => Number(theme.match(new RegExp(`static let ${name}: CGFloat = (\\d+)`))?.[1]);
    expect(num('minWidth')).toBeLessThan(num('expanded'));
    expect(num('expanded')).toBeLessThan(num('maxWidth'));
    expect(num('rail')).toBe(40);
    expect(theme).toContain('static func clamp(_ width: CGFloat) -> CGFloat { return width.isNaN ? expanded : min(max(width, minWidth), maxWidth) }');
    // Collapsed is the rail whatever the stored width; expanded is always clamped.
    expect(theme).toContain('static func content(_ collapsed: Bool, _ width: CGFloat = expanded) -> CGFloat { return collapsed ? rail : clamp(width) }');
    const main = read('MainWindow.swift');
    expect(main).toContain('@AppStorage("sidebarWidth") private var sidebarWidth = Double(SidebarMetrics.expanded)');
    expect(main).toContain('let width = SidebarMetrics.clamp(CGFloat(sidebarWidth))');
    expect(main).toContain('.frame(width: SidebarMetrics.column(collapsed, width), alignment: .leading).clipped()');
    // The handle is on the divider, only when expanded; the drag clamps; the cursor is the system resize cursor.
    expect(main).toContain('.overlay { if !collapsed { SidebarResizeHandle(width: $sidebarWidth) } }');
    const handle = main.match(/private struct SidebarResizeHandle: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(handle).toContain('NSCursor.resizeLeftRight.push()');
    expect(handle).toContain('width = Double(SidebarMetrics.clamp(CGFloat(from) + v.translation.width))');
    // A stored width out of range (or NaN) must not make the first drag jump: it starts from the clamped width.
    expect(handle).toContain('let from = start ?? Double(SidebarMetrics.clamp(CGFloat(width)))');
    expect(handle).not.toContain('start ?? width');
    expect(handle).toContain('DragGesture(');
    // A wider sidebar widens the window's minimum, so pages keep their measured room (#154).
    expect(main).toContain('.frame(minWidth: WindowMetrics.minContent.width + (collapsed ? 0 : max(0, width - SidebarMetrics.expanded)),');
    // Every sidebar width reads the dragged width (no fixed-width call left).
    for (const f of ['MainWindow.swift', 'Components/Sidebar.swift']) expect(read(f)).not.toMatch(/SidebarMetrics\.content\(collapsed\)/);
  });

  it('Home Recent (plan 6.1): an accordion of 3, status words, refusals named and counted, verbatim, only View all acts', () => {
    const home = read('HomeView.swift');
    expect(home).toContain('model.history.prefix(3)');
    expect(home).toContain('Accordion(recentChatsTitle(rows.map { $0.word.word }), key: "acc.home.recent")');
    expect(home).toContain('Text(verbatim: r.entry.said)');
    // A refusal is the first word checked, so a refused chat is never "Done" or "Failed"; the title counts problems.
    const word = home.match(/func recentChatWord\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const order = ['"Refused"', '"Failed"', '"Stopped"', '"Done"'].map((w) => word.indexOf(w));
    expect(order.every((i) => i >= 0), word).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(home).toMatch(/func recentChatsTitle[\s\S]*?"\\\(refused\) refused"[\s\S]*?"\\\(failed\) failed"/);
    // Refusals come from the same audit join as Conversations.
    expect(home).toContain('conversationLines(entry: e, audit: model.audit, parse: model.parseDate)');
    const recent = home.match(/private var recentChats: some View \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(recent.match(/Button \{[^}]*\}/g)).toEqual(['Button { nav.page = .conversations }']);
    expect(recent).not.toMatch(/sendChat|model\.\w+\(/);
  });

  it('T6 step 1: Stop next to Working, a Stop menu item while working, and an honest stopped line', () => {
    const chat = read('Components/ChatThread.swift');
    // Ask box and Home share the thread: one Stop button, it sends chat.stop only (jobs keep running).
    expect(chat).toContain('QuietButton("Stop", symbol: "stop.fill") { model.stopChat() }.accessibilityLabel("Stop Stephen")');
    const main = read('main.swift');
    expect(main).toContain('stopItem.isHidden = !working()');
    expect(main).toContain('working: { appModel?.canStop ?? false }, stopWork: { appModel?.stopChat() },');
    // A stopped command is a grey info line; once a tool ran, it says the step may already have happened.
    const client = read('AppClient.swift');
    expect(client).toContain('addBubble(.info, stoppedLine(tools: msg.tools ?? [], steps: msg.steps ?? []), detail: "", steps: msg.steps ?? [])');
    const line = client.match(/func stoppedLine\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(line).toContain('tools.isEmpty && steps.isEmpty ? "Stopped." : "Stopped. The last browser step may already have happened."');
  });

  it('T6 step 2: Stop leaves jobs alone, then offers Stop them too under the stopped line; Stop also while speaking', () => {
    const client = read('AppClient.swift');
    // The cancelled path marks its line and reads jobs.list; Stop them too sends jobs.stop per running job.
    expect(client).toMatch(/stoppedLine\(tools:[^\n]*\n\s*stoppedBubble = chat\.last\?\.id\n\s*refreshJobs\(\)/);
    expect(client).toContain('for j in jobs where j.isRunning { stopJob(j.id) }');
    expect(client).toContain('n == 1 ? "1 job is still running." : "\\(n) jobs are still running."');
    expect(client).toContain('var canStop: Bool { return isWorking || state == "speaking" }');
    const chat = read('Components/ChatThread.swift');
    expect(chat).toContain('if thread.last?.id == model.stoppedBubble && running > 0 {');
    expect(chat).toContain('QuietButton("Stop them too", destructive: true) { model.stopRunningJobs() }');
    expect(chat).toContain('} else if model.canStop {');
    expect(read('main.swift')).toContain('working: { appModel?.canStop ?? false }');
    expect(read('AskBox.swift')).toContain('case .chat where model.canStop: model.stopChat()');
  });

  it('Ask box strip (S9, R7): the state word with its dot; the chat title only in the ⋯ menu, verbatim', () => {
    const box = read('AskBox.swift');
    const strip = box.match(/private var topStrip: some View \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(strip).toContain('StatusPill(s.word, kind: s.kind)');
    expect(strip).not.toContain('threadTitle');
    expect(box).toMatch(/Menu \{\s*\/\/[^\n]*\n\s*Text\(verbatim: model\.threadTitle\)/);
    // R6: the menu opens the Memory page by its name.
    expect(box).toContain('Button("Open Memory") { actions.reviewMemory() }');
    expect(box).not.toContain('Review memory');
    // Offline never claims more than the box knows; every state is a word.
    const word = box.match(/func askBoxStateWord\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    for (const w of ['Offline', 'Connecting', 'Listening', 'Working', 'Speaking', 'Ready', 'Microphone off']) expect(word).toContain(`"${w}"`);
  });

  it('L1 ([DEV REVIEW]): a refused step shows "See what Stephen may do", outside the folded chain; it only navigates', () => {
    const chat = read('Components/ChatThread.swift');
    expect(chat).toContain('private var refused: Bool { return bubble.steps.contains { StepStatus($0.status) == .refused } }');
    // On replies and on problem messages, gated on a refusal; never inside ActionChain (folded by default).
    expect(chat.match(/if refused, let open = links\.permissions \{ link\("See what Stephen may do", open\) \}/g)).toHaveLength(2);
    const chain = chat.match(/struct ActionChain: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(chain).not.toContain('See what Stephen may do');
    // The refusal label and the steps keep their place and look.
    expect(chat).toContain('Text(verbatim: problemLabel(bubble.steps)).safetyLabelStyle(t)');
    // The link button only runs its closure; the closures only navigate (no model call, no answer, no send).
    expect(chat).toMatch(/private func link\(_ title: String, _ action: @escaping \(\) -> Void\) -> some View \{\s*Button\(action: action\)/);
    expect(read('HomeView.swift')).toContain('ChatLinks(permissions: { selectSettingsPane(.privacy); nav.page = .settings }');
    const box = read('AskBox.swift');
    expect(box).toContain('ChatLinks(permissions: actions.openPermissions)');
    expect(box).toContain('openPermissions: { [weak self] in selectSettingsPane(.privacy); self?.openWindow(.settings) }');
    expect(read('SettingsPage.swift')).toContain('func selectSettingsPane(_ item: SettingsItem) { UserDefaults.standard.set(item.rawValue, forKey: "settingsPane") }');
  });

  // R7: a failed menu or doctor request (phone link, Zen, speed, doctor) says what failed in a plain sentence.
  it('StephenControl has no raw "error" fallback; each menu and doctor failure has its own plain line', () => {
    const control = read('StephenControl.swift');
    expect(control).not.toContain('?? "error"');
    for (const [fn, name, text] of [
      ['phoneText', 'PHONE_LINK_FAILED', "Couldn't change the phone link right now."],
      ['zenProblem', 'ZEN_OPEN_FAILED', "Couldn't open Zen for Stephen right now."],
      ['latencyText', 'SPEED_FAILED', "Couldn't load the speed report right now."],
      ['doctorText', 'DOCTOR_FAILED', "Couldn't run the doctor checks right now."],
    ]) {
      expect(control.match(new RegExp(`func ${fn}\\([\\s\\S]*?\\n\\}`))?.[0] ?? '').toContain(`plainFailure(msg.message, ${name})`);
      expect(control).toContain(`let ${name} = "${text}"`);
    }
  });

  it('F9a: the setup sheet shows only fixed lines by code word, never runs the install command, and the status parser keeps an allow-list', () => {
    const sheet = read('OnboardingSheet.swift');
    const control = read('StephenControl.swift');
    expect(sheet).not.toMatch(/Process\(|\.run\(\)|NSAppleScript|launchPath/); // the sheet runs nothing
    expect(sheet).toContain('let CLAUDE_CODE_PAGE = "https://claude.com/claude-code"'); // the link only, as stephen setup and the guide
    expect(sheet).not.toMatch(/npm install|curl |install\.sh|brew install/);
    for (const w of ['missing', 'signed_out', 'ok', 'checking', 'no_launch_info']) expect(sheet).toContain(`case "${w}": return "`);
    expect(sheet).toContain('Text(verbatim: claudeSetupLine(claude))');
    expect(control).toContain('p.arguments = [info.cli, "setup", "--status"]');
    expect(control).toContain('p.standardError = FileHandle.nullDevice');
    expect(control).toContain('let SETUP_CLAUDE_WORDS: Set<String> = ["missing", "signed_out", "ok"]');
    expect(read('MainWindow.swift')).toContain('@AppStorage("onboarded") private var onboarded = false');
  });

  it('F9b: the models step streams code-word progress only and shows fixed lines', () => {
    const sheet = read('OnboardingSheet.swift');
    const control = read('StephenControl.swift');
    expect(control).toContain('p.arguments = [info.cli, "voice-setup", "--json-progress"]');
    expect(control).toContain('let MODEL_EVENTS: Set<String> = ["downloading", "extracting", "installed", "done", "failed"]');
    expect(control.match(/p\.standardError = FileHandle\.nullDevice/g)?.length).toBeGreaterThanOrEqual(2);
    for (const e of ['downloading', 'extracting', 'installed']) expect(sheet).toContain(`case "${e}": return "`);
    expect(sheet).toContain('default: return "The download stopped. Check the internet, then press Retry.');
    expect(sheet).toContain('Text(verbatim: modelSetupLine(models, progress))');
    expect(sheet).toContain('PrimaryButton(progress?.event == "failed" ? "Retry" : "Download")');
    expect(sheet).toContain('.frame(width: 560, height: 560'); // fits the 860 x 640 minimum window (scrolls inside)
  });

  it('F9c: permissions are read from macOS, Run setup again reopens the sheet, one download per helper, its own line per failure', () => {
    const sheet = read('OnboardingSheet.swift');
    const control = read('StephenControl.swift');
    for (const k of ['Privacy_Microphone', 'Privacy_ListenEvent', 'Privacy_Accessibility']) expect(sheet).toContain(k);
    expect(sheet).toContain('AVCaptureDevice.authorizationStatus(for: .audio) == .authorized');
    expect(sheet).toContain('case "input": return CGPreflightListenEventAccess()');
    for (const r of ['keywords', 'busy', 'config']) expect(sheet).toContain(`case "${r}": return "`);
    expect(control).toContain('let MODEL_FAIL_REASONS: Set<String> = ["download", "keywords", "busy", "config"]');
    expect(control).toContain('if setupWatchers.count > 1 {');
    expect(read('SettingsPage.swift')).toContain('QuietButton("Run setup again") { UserDefaults.standard.set(false, forKey: "onboarded") }');
    expect(read('MainWindow.swift')).toContain('.onChange(of: onboarded) { if !$0 { showSetup = true } }');
    expect(read('Info.plist')).toContain('NSMicrophoneUsageDescription'); // requestAccess needs it, or the app quits
    expect(sheet).toContain('Microphone: press Ask now (macOS adds apps to that list only when they ask).'); // no + for the mic list
  });

  it('#189: Settings uses the Mac controls: every switch shows its label on the theme accent, no StephenSwitch', () => {
    const settings = read('SettingsPage.swift');
    const appearance = read('AppearanceSettings.swift');
    expect(settings).toContain('Toggle("Speak replies out loud", isOn: bind(\\.speak)).tint(t.accent)');
    expect(settings).toContain('Toggle("Explain steps as you go", isOn: bind(\\.explain)).tint(t.accent)');
    expect(settings).toContain('Toggle("Start Stephen at login", isOn: on).tint(t.accent)'); // F5
    expect(appearance).toContain('.tint(t.accent)');
    expect(appearance).toContain('Text(verbatim: "Follow the Mac")');
    expect(appearance).toContain('Text(verbatim: "Light by day, Dark at night. The window and the Ask box change together.")');
    for (const src of [settings, appearance]) expect(src).not.toContain('labelsHidden().toggleStyle');
    expect(settings).not.toContain('FormRow("Speak replies out loud")');
    expect(read('Components/Controls.swift')).not.toContain('StephenSwitch');
    // Segmented stays for the memory page (Show memory as); Settings no longer uses it.
    expect(read('MemoryPage.swift')).toContain('Segmented("Show memory as"');
  });

  it('Settings > Model and effort sends model.set (alias or name, and an effort level)', () => {
    expect(client).toContain('type: "model.set", model: model, effort: effort');
    expect(read('SettingsPage.swift')).toContain('model.saveModel(model: name, effort: effort)');
  });

  it('P2 control: the helper owns the listener (not the window), refuses duplicates and a Terminal listener, has the permissions it needs', () => {
    const main = read('main.swift');
    expect(main).toContain('let stephenControl = StephenControl(home: home, log: log)');
    expect(main).toContain('"Start Stephen"');
    expect(main).toContain('control.start(report)');
    expect(client).toContain('if case .running = listener { return done("Stephen is already running.") }');
    expect(client).toContain('LOCAL_PEERPID');
    expect(client).toContain('p.arguments = [info.cli, "listen"]');
    expect(client).toContain('st.st_mode & 0o022 == 0');
    for (const r of ['.phoneOn(', '.phoneOff(', '.zenOpen(', '.doctorRun(']) expect(client).toContain(r);
    const plist = read('Info.plist');
    expect(plist).toContain('NSMicrophoneUsageDescription');
    expect(plist).toContain('NSAppleEventsUsageDescription');
  });

  it('#202 C1: app.sock reconnect backs off to 10 s and goes back to 3 s on Start, Retry, open and app.sock', () => {
    // The body of one Swift func: from its signature to the first line that closes it (two-space indent).
    const body = (src: string, sig: string) => {
      const i = src.indexOf(sig);
      expect(i, sig).toBeGreaterThanOrEqual(0);
      return src.slice(i, src.indexOf('\n  }\n', i));
    };
    const appClient = read('AppClient.swift');
    expect(read('Core.swift')).toContain('let APP_RETRY_MAX_SECONDS = 10.0');
    for (const sig of ['func opened(_ who: String) {', 'func retry() {', 'func resetRetry() {']) {
      expect(body(appClient, sig), sig).toContain('retryDelay = APP_RETRY_SECONDS');
    }
    expect(body(read('StephenControl.swift'), 'func start(_ done: (String?) -> Void) {')).toContain('onStart?()');
    expect(read('main.swift')).toMatch(/stephenControl\.onStart = \{[^}\n]*resetRetry\(\)[^}\n]*\}/);
    // While offline: a file check every 3 s at most; app.sock newly there means connect now.
    const retry = body(appClient, 'private func scheduleRetry() {');
    expect(retry).toContain('min(APP_RETRY_SECONDS, retryTarget - retryWaited)');
    expect(retry).toContain('FileManager.default.fileExists(atPath: self.socketPath)');
    expect(retry).toContain('if appeared || self.retryWaited >= self.retryTarget { self.connect() }');
  });

  it('the window opens from the menu, --open-window and the open_window command', () => {
    const main = read('main.swift');
    expect(main).toContain('"Open Stephen…"');
    expect(main).toContain('"--open-window"');
    expect(main).toContain('core.onOpenWindow');
    expect(window).toContain('NSApp.activate(ignoringOtherApps: true)');
    expect(window).toContain('setFrameAutosaveName');
    expect(window).toContain('isReleasedWhenClosed = false');
    expect(read('Core.swift')).toContain('case "open_window": return .openWindow');
  });

  // The palette's allow list (plan 7.3, review of #246). Any member of model or control (any spacing, line breaks,
  // trailing closures), any free function call, raw requests and rebinding model or control to another name.
  const PALETTE_MEMBERS = ['newChat', 'refreshHistory', 'refreshJobs', 'refreshMemoryPage', 'loadOlderHistory', 'runDoctor', 'confirms', 'configPath'];
  // Step e's Conversations source reads the loaded history (both private(set) in AppModel) and formats it. Reads only:
  // none sends a request or changes state (checked in the Conversations source test).
  const PALETTE_READS = ['history', 'audit', 'parseDate', 'sourceLabel', 'timeText'];
  const PALETTE_FREE_CALLS = ['openConfigFile', 'doctorText', 'conversationRows'];
  function paletteCallProblems(src: string): string[] {
    const code = src.replace(/\/\/[^\n]*/g, '');  // comments say "model" too
    const bad: string[] = [];
    const allowed = [...PALETTE_MEMBERS, ...PALETTE_READS];
    for (const m of code.matchAll(/\b(model|control)\s*\.\s*(\w+)/g)) if (!allowed.includes(m[2] ?? '')) bad.push(`${m[1]}.${m[2]}`);
    for (const m of code.matchAll(/(?<![.\w@])([a-z]\w*)\s*\(/g)) {
      const name = m[1] ?? '';
      const swiftOrLocal = ['if', 'for', 'switch', 'guard', 'return', 'init', 'min', 'max', 'move', 'run', 'close', 'items', 'filter', 'contains', 'lowercased', 'map', 'zip'];
      if (PALETTE_FREE_CALLS.includes(name) || swiftOrLocal.includes(name)) continue;
      if (new RegExp(`func ${name}\\b`).test(code)) continue;  // the palette's own private helpers
      bad.push(`${name}(`);
    }
    for (const m of code.matchAll(/appRequestOnce|AppRequest\.|\brequest\(/g)) bad.push(m[0]);
    for (const m of code.matchAll(/=\s*(model|control)\b(?!\s*\.)/g)) bad.push(`rebinds ${m[1]}`);
    return bad;
  }

  it('review of #246: the two safety labels keep the old look; a held Return sends once', () => {
    const chat = read('Components/ChatThread.swift');
    expect(chat).toContain('Text(verbatim: "Needs your OK").safetyLabelStyle(t)');
    expect(chat).toContain('Text(verbatim: problemLabel(bubble.steps)).safetyLabelStyle(t)');
    // #185: the eyebrow role is 12 pt regular ink-2, and the safety labels never use it.
    const theme = read('Theme.swift');
    expect(theme).toContain('static let eyebrow = Font.system(size: 12)');
    expect(theme).toContain('return self.font(TypeScale.eyebrow).foregroundColor(t.ink2)');
    expect(chat).not.toMatch(/"Needs your OK"\)\.eyebrowStyle|problemLabel\(bubble\.steps\)\)\.eyebrowStyle/);
    // UI v4 step b (#139, [DEV REVIEW]): the question card has a 1.5 pt warn outline all round, solid fill, no glass.
    const card = chat.match(/struct ConfirmMessage: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(card).toContain('.overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.warn, lineWidth: 1.5))');
    expect(card).toContain('.background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface2))');
    expect(card).not.toMatch(/glass|Material|shadow|stephenAnimation|withAnimation|transition/);
    // #139: the question appears without animation: the Ask box card height, the scroll to it, and Home's glide.
    const follow = read('AskBox.swift').match(/private func follow\(_ h: CGFloat\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(follow).toContain('if cardHeight == 0 || reduceMotion || !model.confirms.isEmpty { cardHeight = h; return }');
    expect(follow.indexOf('!model.confirms.isEmpty')).toBeLessThan(follow.indexOf('withAnimation'));
    expect(chat).toContain('.onChange(of: model.confirms.first?.id) { _ in proxy.scrollTo("end", anchor: .bottom) }');
    const home = read('HomeView.swift');
    expect(home).toContain('private var glide: Bool { return model.thread.isEmpty && !model.isWorking }');
    // The glide never reads the questions, so a question arriving mid-chat cannot start an animation (review of #252).
    expect(home.match(/private var glide: Bool \{([^\n]*)\}/)?.[1]).not.toContain('confirms');
    expect(home).toContain('.stephenAnimation(Motion.bar, value: glide)');
    expect(home).not.toContain('value: empty)');
    expect(read('Theme.swift')).toContain('.font(Font.system(size: 11, weight: .medium)).tracking(0.88).textCase(.uppercase)');
    const field = read('Components/Controls.swift').match(/struct AskField: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(field).toMatch(/onKeyPress\(keys: \[\.return\], phases: \.repeat\) \{ press in\s*press\.modifiers\.contains\(\.shift\) \? \.ignored : \.handled/);
  });

  it('⌘K palette allow-list test catches planted calls', () => {
    for (const planted of [
      'control.start { _ in }', 'control.phoneOn { _ in }', 'appRequestOnce(appSocketPath, .phoneOn("p")) { _ in }',
      'model\n  .clearHistory()', 'let m = model; m.forgetMemory("x")', 'model . sendChat("x")', 'model.resumeConversation(r.entry.id)', 'model.editAndResend(q)', 'model.request(.confirmAnswer("a", confirmId: "b", approve: true)) { _ in }',
    ]) expect(paletteCallProblems(`struct P { func go() { ${planted} } }`), planted).not.toEqual([]);
    expect(paletteCallProblems('struct P { func go() { control.runDoctor { nav.doctor = doctorText($0) }; model.newChat() } }')).toEqual([]);
  });

  // UI v4 step a, docs/research/UI-V4-IA-PLAN.md section 7.5.6: the palette is an allow list, not a block list.
  it('⌘K palette: only allow-listed calls, never an answer, no default button, rows verbatim', () => {
    const pal = read('Palette.swift');
    expect(paletteCallProblems(pal)).toEqual([]);
    for (const m of pal.matchAll(/\bactions\.(\w+)/g)) expect(['ask'], m[0]).toContain(m[1]);
    for (const m of pal.matchAll(/\bnav\.(\w+)\s*=[^=]/g)) expect(['page', 'draft', 'paletteOpen', 'doctor', 'conversationQuery', 'conversationOpen'], m[0]).toContain(m[1]);
    for (const m of pal.matchAll(/ThemeStore\.shared\.(\w+)/g)) expect(['pick', 'setFollowMac'], m[0]).toContain(m[1]);
    // No answer, no Allow (not even disabled), nothing sent to the model, no shortcut that could reach the card.
    expect(pal).not.toMatch(/\bAllow\b|\bDeny\b|approve|answerConfirm|denyFirstConfirm|confirmAnswer|sendChat|confirms\.first|keyboardShortcut|\.defaultAction/);
    // Results are data: every Text is Text(verbatim:).
    expect(pal.match(/\bText\((?!verbatim:)/g)).toBeNull();
    // Return runs only the selected row; Esc only closes the palette; a row closes the palette before it runs.
    expect(pal).toContain('.onSubmit { run(items) }');
    expect(pal).toContain('.onKeyPress(.escape) { close(); return .handled }');
    expect(pal).toContain('private func close() { nav.paletteOpen = false }');
    expect(pal).toMatch(/let item = items\[selected\]\s*close\(\)\s*item\.run\(\)/);
    // The Ask row only fills Home's composer.
    expect(pal).toContain('if !q.isEmpty { nav.draft = q }');
  });

  // UI v4 step e, plan 7.2 and 7.5.3 ([DEV REVIEW]): the palette's Conversations source.
  it('⌘K palette Conversations source: the page\'s rows and search, at most 5, verbatim, navigate only', () => {
    const pal = read('Palette.swift');
    const conv = pal.match(/private func conversations\(_ q: String\) -> \[PaletteItem\] \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    // Only for typed words, local over the loaded history, the same rows and search as the page, never more than 5.
    expect(conv).toContain('guard !q.isEmpty else { return [] }');
    expect(conv).toContain('conversationRows(model.history, audit: model.audit, parse: model.parseDate, query: q).prefix(5)');
    expect(conv.match(/prefix\(/g)).toHaveLength(1);
    expect(pal).toContain('return list + matching(goTo, q) + conversations(q) + matching(appActions, q)');
    // What you said, verbatim, one line; source · time under it.
    expect(conv).toContain('title: r.entry.said');
    expect(conv).toContain('detail: "\\(model.sourceLabel(r.entry.source)) · \\(model.timeText(r.entry.ts))"');
    expect(pal).toContain('Text(verbatim: item.title).font(TypeScale.body).foregroundColor(t.ink).lineLimit(1).truncationMode(.tail)');
    expect(pal).toContain('if let d = item.detail { Text(verbatim: d)');
    // A result only navigates: the query, the open row, the page. Nothing else.
    const run = conv.match(/\) \{\n([\s\S]*?)\n      \}/)?.[1] ?? '';
    expect(run.split('\n').map((l) => l.trim())).toEqual([
      'nav.conversationQuery = q', 'nav.conversationOpen = r.entry.id', 'nav.page = .conversations',
    ]);
    // The reads it uses send nothing and change nothing.
    const appClient = read('AppClient.swift');
    for (const sig of ['func parseDate(_ iso: String) -> Date? {', 'func timeText(_ iso: String) -> String {', 'func sourceLabel(_ source: String) -> String {']) {
      const i = appClient.indexOf(sig);
      expect(i, sig).toBeGreaterThanOrEqual(0);
      expect(appClient.slice(i, appClient.indexOf('\n  }\n', i)), sig).not.toMatch(/request\(|assign\(|self\.\w+ =/);
    }
    for (const v of ['history', 'audit']) expect(appClient).toContain(`@Published private(set) var ${v}:`);
    expect(read('MainWindow.swift')).toContain('@Published var conversationQuery = ""\n  @Published var conversationOpen: String? = nil');
  });

  // UI v4 step e, plan 6.2.
  it('Conversations (step e): intro, chips on top of conversationMatches, S5 rows, verbatim, Load older', () => {
    // The row's VoiceOver label is a String variable, never a literal with third-party text (LocalizedStringKey).
    const convPage = read('ConversationsPage.swift');
    expect(convPage).toContain('let spoken: String = "You said: \\(entry.said). \\(word.word). \\(facts)"');
    expect(convPage).toContain('.accessibilityLabel(spoken)');
    // Sidebar and ⌘2 clear the palette's query and open row; the palette jump sets them (#255 review).
    expect(read('MainWindow.swift')).toContain('if p == .conversations { nav.conversationQuery = ""; nav.conversationOpen = nil }');
    // What you said stays copyable: in full, selectable, in the open row.
    expect(convPage).toMatch(/if expanded \{\n\s*HStack\([^\n]*\n\s*Text\(verbatim: shown\.said\)[^\n]*\.textSelection\(\.enabled\)/);
    expect(convPage).not.toMatch(/accessibilityLabel\("[^"]*\\\(entry\./);
    // A memory command keeps its own word (it was "Memory" before step e), not "Done".
    expect(read('HomeView.swift')).toContain('if entry.outcome == "memory" { return ("Memory", .idle) }');
    const conv = read('ConversationsPage.swift');
    expect(conv).toContain('Text(verbatim: "What you asked, what Stephen did, and what it refused. The list is saved on this Mac.")');
    expect(conv).toContain('let CONVERSATIONS_EMPTY = "Nothing yet. Ask Stephen something and it shows here."');
    // Chips: All, Refused, Failed, drawn with Memory's Tag.
    expect(conv).toMatch(/let CONVERSATION_FILTERS = \[\s*MemoryFilter\(id: "all", title: "All"\), MemoryFilter\(id: "refused", title: "Refused"\), MemoryFilter\(id: "failed", title: "Failed"\),\s*\]/);
    expect(conv).toContain('ForEach(CONVERSATION_FILTERS) { f in Tag(f.title, selected: filter == f.id) { filter = f.id }.fixedSize() }');
    // The filter is a pure filter on top of conversationMatches: the search runs first, for every row.
    const rows = conv.match(/func conversationRows\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(rows).toMatch(/\.filter \{ r in\s*guard conversationMatches\(r\.entry, lines: r\.lines, query: query\) else \{ return false \}/);
    expect(rows).toContain('case "refused": return r.lines.contains { $0.status == .refused }');
    expect(rows).toContain('case "failed": return r.entry.outcome == "error" || r.lines.contains { $0.status == .failed }');
    const page = conv.match(/struct ConversationsPage: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(page).toContain('conversationRows(day.entries, audit: model.audit, parse: model.parseDate, query: nav.conversationQuery,');
    expect(page).not.toMatch(/\.filter \{/);
    expect(page).toContain('TextField("Search conversations", text: $nav.conversationQuery)');
    expect(page).toContain('QuietButton("Load older") { model.loadOlderHistory() }');
    // S5 row: title verbatim, facts line in the chat's format, the status word with Home's words.
    expect(conv).toContain('Text(verbatim: entry.said)');
    expect(conv).toContain('Text(verbatim: shown.reply)');
    expect(conv).toContain('Text(verbatim: l.text)');
    expect(conv).toContain('let word = recentChatWord(entry, lines: lines)');
    expect(conv).toContain('StatusPill(word.word, kind: word.kind)');
    expect(conv).toContain('return parts.joined(separator: " · ")');
    // All conversation text is data: no Markdown, no links.
    expect(conv.match(/\bText\((?!verbatim:)/g)).toBeNull();
    expect(conv).not.toMatch(/AttributedString|LocalizedStringKey|Link\(/);
  });

  it('Conversations (step e, [DEV REVIEW]): refused and failed lines sit outside the open or closed condition', () => {
    const conv = read('ConversationsPage.swift');
    const item = conv.match(/private struct ConversationItem: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    // Conditions on the open state in the row (ADR-010 adds the expired line, the version switch and the plain line):
    // none of them holds a step line.
    expect(item.match(/if !?expanded/g)).toEqual(['if expanded', 'if expanded', 'if expanded', 'if expanded', 'if expanded']);
    const said = item.match(/\n        if expanded \{\n([\s\S]*?)\n        \}\n/)?.[1] ?? '';
    expect(said).toContain('Text(verbatim: shown.said)');
    expect(said).not.toContain('ForEach');
    expect(item).toMatch(/if expanded && !shown\.reply\.isEmpty \{\s*Text\(verbatim: shown\.reply\)[^\n]*\n[^\n]*\n\s*\}\n/);
    // The step lines follow that block, not inside it. Only ok lines wait for the open row.
    expect(item).toMatch(/\.fixedSize\(horizontal: false, vertical: true\)\n        \}\n(\s*\/\/[^\n]*\n)*\s*ForEach\(Array\(\(expanded \? shownLines : lines\)\.filter \{ expanded \|\| \$0\.status != \.ok \}\.enumerated\(\)\)/);
    expect(item.match(/ForEach\(/g)).toHaveLength(1);
    // The closed row's facts count the problems too, so a closed row never reads as fine.
    expect(conv).toContain('if refused > 0 { parts.append("\\(refused) refused") }');
    expect(conv).toContain('if failed > 0 { parts.append("\\(failed) failed") }');
  });

  it('⌘K palette: while open, the question card buttons and its Esc are off; the banner stays above it', () => {
    const box = read('AskBox.swift');
    const buttons = box.match(/struct ConfirmButtons: View \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(buttons).toContain('@Environment(\\.paletteOpen) var paletteOpen');
    expect(buttons).toContain('.disabled(!live || paletteOpen)');
    expect(buttons).toContain('try? await Task.sleep(nanoseconds: 750_000_000)');  // the 0.75 s delay is unchanged
    expect(buttons).not.toContain('keyboardShortcut');
    const chat = read('Components/ChatThread.swift');
    expect(chat).toContain('@Environment(\\.paletteOpen) var paletteOpen');
    expect(chat).toContain('Button("") { model.denyFirstConfirm() }.keyboardShortcut(.cancelAction).disabled(paletteOpen)');
    // Off by default (the Ask box never sets it); only the main window sets it, from nav.paletteOpen.
    expect(read('Palette.swift')).toMatch(/struct PaletteOpenKey: EnvironmentKey \{\s*static let defaultValue = false/);
    const setters = readdirSync(helperSourceDir(), { recursive: true }).map(String).filter((f) => f.endsWith('.swift'))
      .filter((f) => read(f).includes('.environment(\\.paletteOpen'));
    expect(setters).toEqual(['MainWindow.swift']);
    const main = read('MainWindow.swift');
    expect(main).toContain('.environment(\\.paletteOpen, nav.paletteOpen)');
    // Layout: toolbar, banner, then the page with the palette in its overlay. The banner is not in the overlay.
    expect(main).toMatch(/WindowToolbar\(model: model, nav: nav\)\s*if !model\.confirms\.isEmpty \{ questionBanner \}\s*detail\.frame/);
    const overlay = main.match(/\.overlay\(alignment: \.top\) \{([\s\S]*?)\n          \}/)?.[1] ?? '';
    expect(overlay).toContain('CommandPalette(');
    expect(overlay).not.toContain('questionBanner');
    // No view in the window gives the palette a default button.
    for (const f of ['Palette.swift', 'MainWindow.swift', 'HomeView.swift']) expect(read(f), f).not.toContain('.defaultAction');
    // App menu (plan 5.3): ⌘K is "Search and actions…", which brings the main window forward first. Ask Stephen stays.
    const app = read('AppWindow.swift');
    expect(app).toContain('NSMenuItem(title: "Search and actions…", action: #selector(paletteClicked(_:)), keyEquivalent: "k")');
    expect(app).toContain('NSMenuItem(title: "Ask Stephen", action: #selector(askClicked(_:)), keyEquivalent: "")');
    expect(app).toMatch(/func paletteClicked\(_ sender: Any\?\) \{\s*show\(\)\s*nav\.paletteOpen = true/);
  });

  it('glass (UI v4 section 8): sidebar, toolbar and palette only; tints and alphas are the checked ones; solid fallbacks', () => {
    const script = join(helperSourceDir(), '..', 'scripts', 'glass-contrast.mjs');
    execFileSync(process.execPath, [script], { stdio: 'pipe' });  // throws if any text pair is under 4.5:1
    const src = readFileSync(script, 'utf8');
    const theme = read('Theme.swift');
    const alpha = src.match(/export const ALPHA = \{([^}]*)\}/)?.[1] ?? '';
    const pairs = [...alpha.matchAll(/(\w+): \[([\d.]+), ([\d.]+)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(['sidebar', 'toolbar', 'palette']);
    for (const [, k, light, dark] of pairs) expect(theme).toContain(`case .${k}: return (${light}, ${dark})`);
    for (const [name, sidebar, ground] of [...src.matchAll(/(\w+): \{ dark: \w+, sidebar: '(\w+)', ground: '(\w+)'/g)].map((m) => [m[1], m[2], m[3]])) {
      expect(theme, name).toMatch(new RegExp(`case \\.${name}:[\\s\\S]*?ground: Color\\(hex: 0x${ground}\\)[\\s\\S]*?sidebar: Color\\(hex: 0x${sidebar}\\)`));
    }
    expect(theme).toContain('if reduceTransparency || contrast == .increased {');
    const uses = readdirSync(helperSourceDir(), { recursive: true }).map(String).filter((f) => f.endsWith('.swift'))
      .flatMap((f) => [...read(f).matchAll(/\.glassBackground\(\.(\w+)\)/g)].map((m) => `${f}:${m[1]}`));
    expect(uses.sort()).toEqual(['MainWindow.swift:sidebar', 'MainWindow.swift:toolbar', 'Palette.swift:palette']);
    // The question card, the banner and the Recording on sign stay solid.
    expect(read('Components/ChatThread.swift')).not.toContain('glassBackground');
    expect(read('AskBox.swift')).not.toContain('glassBackground');
  });
});
