/**
 * app.sock protocol v1 (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 13): the shared fixture
 * test/fixtures/app-protocol-v1.jsonl, which the Node server (src/app) tests run against too, is well formed and
 * covers every message in the table. Plus cheap source checks on the Swift window, which can only be compiled on the
 * Mac: it sends every request type, handles every response and push type, shows untrusted text verbatim, and is
 * reachable from the menu, `--open-window` and the helper.sock `open_window` command.
 */
import { readFileSync } from 'node:fs';
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
  // Personal page (src/app/personal.ts), read-only.
  'personal.summary': ['personal', 'error'],
  // Memory page (UI-PLAN v3.1 section 7a): proposals are kept or skipped only by the owner's click.
  'memory.graph': ['graph', 'error'],
  'memory.suggestions': ['suggestions', 'error'],
  'memory.propose': ['suggestions', 'error'],
  'memory.keep': ['memory', 'error'],
  'memory.skip': ['suggestions', 'error'],
  'memory.usage': ['memory.usage', 'error'],
};
const REQUEST_TYPES = Object.keys(RESPONSES);
/** Request types only the CLI sends. */
const CLI_ONLY_REQUESTS = ['window.open', 'confirm.ask'];
/** Responses only the gate reads. */
const GATE_ONLY_RESPONSES = ['confirm.result'];
const RESPONSE_TYPES = [...new Set(Object.values(RESPONSES).flat())];
const PUSH_TYPES = ['state', 'heard', 'chat.done', 'confirm', 'confirm.end'];
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
  const client = read('AppClient.swift');
  // The window's sources: frame and router, Home, and the older screens.
  const window = ['AppWindow.swift', 'MainWindow.swift', 'HomeView.swift', 'PersonalView.swift'].map(read).join('\n');

  it('AppClient sends every request type and handles every response and push type', () => {
    const windowRequests = REQUEST_TYPES.filter((t) => !CLI_ONLY_REQUESTS.includes(t));
    const windowResponses = RESPONSE_TYPES.filter((t) => !GATE_ONLY_RESPONSES.includes(t));
    for (const t of [...windowRequests, ...windowResponses, ...PUSH_TYPES]) expect(client, t).toContain(`"${t}"`);
    expect(client).toContain('APP_MAX_LINE_BYTES = 256 * 1024');
    expect(client).toContain('APP_CHAT_MAX_CHARS = 2000');
    expect(read('main.swift')).toContain('home + "/run/app.sock"');
  });

  it('Ask box usage bars: sends usage.get and decodes the P2 shape (PR #18) without importing it', () => {
    // {id,type:"usage",context:{percent,warn,tokens,window}|null,memory:{percent,warn,bytes,budget}}
    expect(client).toContain('type: "usage.get"');
    expect(client).toContain('msg.type == "usage"');
    // P2's UsageBar (percent is a rounded whole number in src/app/usage.ts).
    expect(client).toMatch(/struct UsageBar: Decodable[\s\S]*let percent: Int[\s\S]*let warn: Bool/);
    expect(client).toContain('decodeIfPresent(UsageBar.self, forKey: .context)');
    expect(client).toContain('decodeIfPresent(UsageBar.self, forKey: .memory)');
    const box = read('AskBox.swift');
    expect(box).toContain('if let m = model.usage?.context');
    expect(box).toContain('let high = warn');
  });

  it('untrusted text is never rendered as Markdown: every Text(...) with a non-literal is Text(verbatim:)', () => {
    for (const src of [window, client, read('AskBox.swift')]) {
      const bad = src.match(/\bText\((?!verbatim:|")[^)]*\)/g) ?? [];
      expect(bad).toEqual([]);
    }
  });

  it('Personal (accounts, personal.summary, memory) and Home\'s Today row are wired to the protocol', () => {
    expect(window).toContain('case .personal: PersonalView(model: model, nav: nav)');
    expect(window).toContain('model.refreshPersonal()');
    expect(client).toContain('AppRequest.personalSummary(newId())');
    expect(client).toContain('if type == "personal" { personal = try? PersonalSummary(from: decoder) }');
    // View only: the one write on the page is Forget (owner default 3).
    const personal = read('PersonalView.swift');
    expect(personal.match(/model\.(add|update|clear|forget|stop|send)\w*\(/g)).toEqual(['model.forgetMemory(']);
    expect(personal).toContain('PermissionTable(');
    expect(window).toContain('model.refreshAccounts()');
    expect(window).toContain('model.sendChat(APP_TODAY_PROMPT)');
    // The card sends exactly what the tests (and the user) expect, through the ordinary chat request.
    expect(client).toContain('let APP_TODAY_PROMPT = "what\'s my day?"');
    expect(client).toContain('AppRequest.accountsStatus(newId())');
    // Only system colours.
    expect(window).not.toMatch(/Color\((red|green|blue|white|black):/);
  });

  it('Jobs tab is wired to the protocol and shows job text verbatim', () => {
    expect(window).toContain('case .jobs: JobsView(model: model)');
    expect(window).toContain('model.refreshJobs()');
    expect(window).toContain('model.stopJob(');
    expect(client).toContain('AppRequest.jobsList(newId())');
    expect(client).toContain('AppRequest.jobsStop(newId(), jobId:');
    expect(window).toContain('NSWorkspace.shared.activateFileViewerSelecting');
    expect(window).toContain("No jobs yet. Say 'while I'm cooking, …' or 'start a job to …'");
    // Refresh every 5 s while visible.
    expect(window).toContain('Timer.publish(every: 5');
    // Stop only for a job that has not ended.
    expect(window).toMatch(/if job\.isRunning/);
  });

  it('main window (UI-PLAN v3.1 sections 4 and 6): sidebar pages, shortcuts, remembered collapse, Start/Stop, Home', () => {
    const main = read('MainWindow.swift');
    expect(main).toContain('static let stephen: [Page] = [.home, .conversations, .jobs]');
    expect(main).toContain('static let you: [Page] = [.personal, .settings]');
    expect(main).toContain('.keyboardShortcut(p.key!, modifiers: .command)');
    expect(main).toContain('.keyboardShortcut("\\\\", modifiers: .command)');
    expect(main).toContain('@AppStorage("sidebarCollapsed")');
    expect(main).toContain('.frame(width: collapsed ? 60 : 220)');
    // Start/Stop go through the helper's StephenControl (one owner of the listener), not a second launcher.
    expect(main).toContain('control.start { problem = $0 }');
    expect(main).toContain('control.stop { problem = $0 }');
    for (const w of ['"Listening"', '"Stopped"', '"Offline"']) expect(main).toContain(w);
    expect(main).toContain('.stephenThemed(savedThemeChoice())');
    const home = read('HomeView.swift');
    expect(home).toContain('let HOME_SUGGESTIONS = ["Plan my day", "Find internships", "Start a job"]');
    expect(home).toContain('model.confirms.count');
    expect(read('AskBox.swift')).toContain('reviewMemory: { [weak self] in self?.close(); self?.openWindow(.memory) }');
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
});
