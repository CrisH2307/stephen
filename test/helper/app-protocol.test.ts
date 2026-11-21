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
import { helperSourceDir } from '../../src/helper/install.js';

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
};
const REQUEST_TYPES = Object.keys(RESPONSES);
/** Request types only the CLI sends. */
const CLI_ONLY_REQUESTS = ['window.open', 'confirm.ask'];
/** Responses only the gate reads. */
const GATE_ONLY_RESPONSES = ['confirm.result'];
const RESPONSE_TYPES = [...new Set(Object.values(RESPONSES).flat())];
// replay (#208): the "Recording on" sign follows the listener's push, not a cached settings answer.
const PUSH_TYPES = ['state', 'heard', 'chat.done', 'confirm', 'confirm.end', 'replay'];
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
            expect(Object.keys(e).sort()).toEqual(['followUp', 'id', 'ms', 'outcome', 'reply', 'said', 'source', 'tools', 'ts', 'turns']);
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
    const windowRequests = REQUEST_TYPES.filter((t) => !CLI_ONLY_REQUESTS.includes(t));
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

  it('R10a-2 (#94): Try again re-sends only a typed bubble; spoken and phone bubbles show where they came from', () => {
    const chat = read('Components/ChatThread.swift');
    // The one guard: the last said bubble, and only when it has no source label. No fallback to an older typed one.
    expect(chat).toContain(
      'guard let last = thread.last(where: { $0.kind == .said }), last.detail.isEmpty else { return nil }',
    );
    // retry() reaches sendChat only through that guard; it is the file's only sendChat.
    expect(chat).toContain('if let typed = retryableText(model.thread) { model.sendChat(typed) }');
    expect(chat.match(/sendChat\(/g)).toHaveLength(1);
    // The button exists only when the guard passes (nil retry, no button).
    expect(chat).toContain('retry: canRetry ? { retry() } : nil');
    expect(chat).toContain('let canRetry = retryableText(thread) != nil');
    expect(chat).toContain('if isLast, let retry = retry { QuietButton("Try again", action: retry) }');
    // Typed bubbles get an empty label; heard ones always a non-empty one, even for an unknown or missing source.
    expect(client).toContain('addBubble(.said, text, detail: "")');
    expect(client).toContain('addBubble(.said, text, detail: heardLabel(msg.source))');
    const label = client.match(/func heardLabel\(_ source: String\?\) -> String \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(label).toContain('default: return "Not typed here"');
    const returns = [...label.matchAll(/return ([^\n]*)/g)].map((m) => m[1]);
    expect(returns.length).toBeGreaterThanOrEqual(5);
    for (const r of returns) expect(r, r).toMatch(/^"[^"]+"$/);
    for (const s of ['voice-ptt', 'voice-wake', 'phone', 'cli']) expect(label).toContain(`case "${s}":`);
    // UI v4 step b (#142, [DEV REVIEW]): the source line in #142's words.
    for (const [s, w] of [['voice-ptt', 'From: F5'], ['voice-wake', 'From: Hey Stephen'], ['phone', 'From: Phone']]) {
      expect(label).toContain(`case "${s}": return "${w}"`);
    }
    // Shown under the bubble (verbatim) and read by VoiceOver.
    expect(chat).toContain('if !bubble.detail.isEmpty {\n          Text(verbatim: bubble.detail)');
    expect(chat).toContain('"You, \\(bubble.detail): \\(bubble.text)"');
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
    for (const label of ['Length', 'Tone', 'Model', 'Effort']) {
      expect(settings).toMatch(new RegExp(`Segmented\\("${label}",[^\\n]*caption: true\\)`));
    }
    expect(read('Components/Controls.swift')).toMatch(/if caption \{\s*Text\(verbatim: label\)/);
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
    expect(main).toContain('case home, conversations, jobs, memory, settings\n');
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
    const failedLine = body.split('\n').find((l) => l.includes('GroupedList("Failed, last 7 days")')) ?? '';
    expect(failedLine).toContain('if !failed.isEmpty { GroupedList("Failed, last 7 days") { rows(failed) } }');
    expect(body.match(/Accordion\(/g)).toHaveLength(1);
    const accordion = body.slice(body.indexOf('Accordion('));
    expect(accordion).not.toContain('Failed, last 7 days');
    expect(body.indexOf('GroupedList("Failed')).toBeLessThan(body.indexOf('Accordion('));
    // Earlier is a closed accordion that counts its failures in the label.
    expect(body).toContain('Accordion(jobsEarlierTitle(earlier), key: "acc.jobs.earlier") { GroupedList { rows(earlier) } }');
    expect(jobs).toContain('func jobsEarlierTitle(_ jobs: [JobRow]) -> String');
    expect(jobs).toMatch(/jobsEarlierTitle[\s\S]*?failed\) failed/);
    expect(jobs).toContain('let earlier = model.jobs.filter { !$0.isRunning && !jobFailedRecently($0, now: now) }');
    expect(jobs).toContain('now - (job.endedAt ?? job.createdAt) <= 7 * 24 * 3600 * 1000.0');
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

  it('main window (UI v4 shell): two sidebar groups, shortcuts, remembered collapse, Start/Stop at the bottom left, Home', () => {
    const main = read('MainWindow.swift');
    expect(main).toContain('static let talk: [Page] = [.home, .conversations, .jobs]');
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
    const order = ['PermissionsSection(model: model)', 'FormRow(Self.label)', 'RulesSourceSection(model: model)'].map((x) => pane.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The switch's words and behaviour are unchanged.
    expect(pane).toContain('private static let label = "Save my F5 commands to measure mistakes"');
    expect(pane).toContain('Toggle(Self.label, isOn: Binding(get: { model.recordingOn }, set: { change($0) }))');
    expect(pane).toContain('.toggleStyle(StephenSwitch()).disabled(model.connection != .online)');
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
  const PALETTE_FREE_CALLS = ['openConfigFile', 'doctorText'];
  function paletteCallProblems(src: string): string[] {
    const code = src.replace(/\/\/[^\n]*/g, '');  // comments say "model" too
    const bad: string[] = [];
    for (const m of code.matchAll(/\b(model|control)\s*\.\s*(\w+)/g)) if (!PALETTE_MEMBERS.includes(m[2] ?? '')) bad.push(`${m[1]}.${m[2]}`);
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
      'model\n  .clearHistory()', 'let m = model; m.forgetMemory("x")', 'model . sendChat("x")', 'model.request(.confirmAnswer("a", confirmId: "b", approve: true)) { _ in }',
    ]) expect(paletteCallProblems(`struct P { func go() { ${planted} } }`), planted).not.toEqual([]);
    expect(paletteCallProblems('struct P { func go() { control.runDoctor { nav.doctor = doctorText($0) }; model.newChat() } }')).toEqual([]);
  });

  // UI v4 step a, docs/research/UI-V4-IA-PLAN.md section 7.5.6: the palette is an allow list, not a block list.
  it('⌘K palette: only allow-listed calls, never an answer, no default button, rows verbatim', () => {
    const pal = read('Palette.swift');
    expect(paletteCallProblems(pal)).toEqual([]);
    for (const m of pal.matchAll(/\bactions\.(\w+)/g)) expect(['ask'], m[0]).toContain(m[1]);
    for (const m of pal.matchAll(/\bnav\.(\w+)\s*=[^=]/g)) expect(['page', 'draft', 'paletteOpen', 'doctor'], m[0]).toContain(m[1]);
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
    const script = join(helperSourceDir(), '..', 'docs', 'research', 'ui-v4-mock', 'glass-contrast.mjs');
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
