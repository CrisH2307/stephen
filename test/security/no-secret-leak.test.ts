/**
 * No account or voice secret leaves Stephen. Fake secrets (Canvas token, Notion token, calendar ICS address, Gmail
 * refresh token and OAuth client secret, the Google access token the fake token server hands out, the ElevenLabs
 * key) sit in a private fake `.env` and a fake Keychain. The real serve tool paths run against fake HTTP servers on
 * 127.0.0.1, with the real gate, audit log, session-state binding and tool log, once with good answers and once with
 * every server failing and echoing what it was sent. Then none of the secrets may appear in: tool results, the tool
 * log, the audit log, the session-state file, a history entry built from the tool log (as the listener does), or
 * anything written to stdout/stderr.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GMAIL_SCOPE } from '../../src/accounts/gmail.js';
import { HistoryStore } from '../../src/history/store.js';
import { createSafety } from '../../src/safety/index.js';
import { withSessionState } from '../../src/safety/session-state.js';
import { readToolLog } from '../../src/server/tool-log.js';
import { createTts } from '../../src/voice/tts/index.js';
import { parseTtsConfig } from '../../src/voice/tts/config.js';
import { afplayPlayer } from '../../src/voice/tts/player.js';
import { setup, textOf } from '../server/fakes.js';
import { FakeElevenLabs, FakeSecurity, fakeBin } from '../voice/tts/helpers.js';

const SECRETS = {
  canvas: '12345~LEAKcanvasLEAKcanvasLEAKcanvas',
  notion: 'ntn_LEAKnotionLEAKnotionLEAKnotion00',
  icsKey: 'private-LEAKicsLEAKicsLEAKics0000',
  refresh: '1//0gLEAKrefreshLEAKrefreshLEAKrefresh',
  clientSecret: 'GOCSPX-LEAKclientLEAKclientLEAK',
  access: 'ya29.LEAKaccessLEAKaccessLEAKaccess',
  eleven: 'sk_LEAKelevenLEAKelevenLEAKelevenLEAKeleven0000beef',
} as const;
const TZ = 'America/Toronto';
const DB = '0123456789abcdef0123456789abcdef';
const DB_DASHED = '01234567-89ab-cdef-0123-456789abcdef';
const MSG_ID = '18f2a0c4d5e6f701';
const B64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

const tmp = mkdtempSync(join(tmpdir(), 'stephen-leak-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ───────────── one fake server for Canvas, Notion, Gmail, the Google token endpoint and the ICS feed ─────────────

let failing = false;
let server: Server;
let base = '';
const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const MESSAGE = {
  id: MSG_ID,
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'The midterm is moved to Thursday',
  internalDate: String(Date.parse('2026-11-02T14:14:00Z')),
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'Dr. A Patel <a.patel@ontariotechu.ca>' },
      { name: 'Subject', value: 'Midterm moved' },
    ],
    body: { data: B64('Hi Cris,\nThe midterm is Thursday.') },
  },
};
const FEED = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Lecture', 'DTSTART;TZID=America/Toronto:20261102T100000', 'DTEND;TZID=America/Toronto:20261102T112000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

function answer(req: IncomingMessage, raw: string, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  if (failing) {
    // A hostile or broken service: every answer is an error that repeats the request, credentials included.
    const echo = `bad request ${req.url} auth=${req.headers.authorization ?? ''} body=${raw}`;
    res.writeHead(url.pathname === '/token' ? 400 : 500, { 'content-type': 'application/json', 'x-echo': echo.replace(/[^\x20-\x7e]/g, '') });
    res.end(JSON.stringify({ error: echo, message: echo }));
    return;
  }
  const p = url.pathname;
  if (p === '/token') return json(res, { access_token: SECRETS.access, expires_in: 3599, scope: GMAIL_SCOPE, token_type: 'Bearer' });
  if (p === `/calendar/ical/me/${SECRETS.icsKey}/basic.ics`) {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(FEED);
    return;
  }
  if (p === '/api/v1/planner/items') return json(res, [{ plannable_type: 'assignment', plannable: { title: 'Quiz 3' }, plannable_date: '2026-11-02T03:59:00Z', context_name: 'SOFE 3980U' }]);
  if (p === '/api/v1/courses') return json(res, [{ id: 7, name: 'Software Quality', course_code: 'SOFE 3980U' }]);
  if (p === '/api/v1/announcements') return json(res, [{ title: 'Midterm', message: '<p>Room change</p>', posted_at: '2026-11-01T12:00:00Z', context_code: 'course_7' }]);
  if (p === `/v1/databases/${DB_DASHED}`) return json(res, { title: [{ plain_text: 'Tasks' }], properties: { Name: { type: 'title' }, Done: { type: 'checkbox' } } });
  if (p === `/v1/databases/${DB_DASHED}/query`) return json(res, { results: [{ object: 'page', properties: { Name: { type: 'title', title: [{ plain_text: 'Lab report' }] }, Done: { type: 'checkbox', checkbox: false } } }], has_more: false });
  if (p === '/v1/search') return json(res, { results: [], has_more: false });
  if (p === '/gmail/v1/users/me/messages') return json(res, { messages: [{ id: MSG_ID, threadId: 't1' }], resultSizeEstimate: 1 });
  if (p === `/gmail/v1/users/me/messages/${MSG_ID}`) return json(res, MESSAGE);
  json(res, { error: 'not found' }, 404);
}

let eleven: FakeElevenLabs;
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => answer(req, raw, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  eleven = await new FakeElevenLabs().start();
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await eleven.stop();
});

// ───────────── one serve run ─────────────

async function runServe(label: string): Promise<{ texts: string[]; files: string[]; out: string }> {
  const dir = mkdtempSync(join(tmp, `${label}-`));
  const envFile = join(dir, '.env');
  writeFileSync(
    envFile,
    [`CANVAS_API=${SECRETS.canvas}`, `CANVAS_URL=${base}`, `NOTION_API=${SECRETS.notion}`, `GOOGLE_CALENDAR_ICS=${base}/calendar/ical/me/${SECRETS.icsKey}/basic.ics`, `GOOGLE_OAUTH_CLIENT_SECRET=${SECRETS.clientSecret}`, ''].join('\n'),
    { mode: 0o600 },
  );
  const keychain = new FakeSecurity();
  keychain.items.set('stephen-gmail-personal|tester', SECRETS.refresh);
  keychain.items.set('stephen-elevenlabs|tester', SECRETS.eleven);
  const secrets = { platform: 'darwin' as const, exec: keychain.exec, user: 'tester', envFile };

  const voiceDir = join(dir, 'voice');
  mkdirSync(voiceDir, { recursive: true, mode: 0o700 });
  const statePath = join(voiceDir, 'conversation-state.json');
  const toolLog = join(voiceDir, 'tool-log.jsonl');
  const afplay = fakeBin('afplay');
  const audioTmp = mkdtempSync(join(dir, 'audio-'));
  const speaker = createTts(parseTtsConfig({ elevenlabs: { timeoutSec: 1 } }), {
    home: dir,
    keys: secrets,
    baseUrl: eleven.baseUrl,
    play: afplayPlayer(afplay.path),
    sayCommand: fakeBin('say').path,
    log: (l) => process.stderr.write(`[stephen] ${l}\n`),
    tmpRoot: audioTmp,
  });
  eleven.routes = failing ? [{ prefix: '/', reply: { kind: 'error', status: 401, detail: { status: 'invalid_api_key', message: `bad key ${SECRETS.eleven}` } } }] : [];

  const out: string[] = [];
  const grab = (chunk: unknown) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return true;
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(grab as never),
    vi.spyOn(process.stderr, 'write').mockImplementation(grab as never),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')))),
  ];
  const texts: string[] = [];
  let h: Awaited<ReturnType<typeof setup>>;
  try {
    h = await setup({
      overrides: { accounts: { timeZone: TZ, gmail: { clientId: 'fake-client-id.apps.googleusercontent.com', accounts: ['personal'] }, notion: { todoDatabase: DB } } } as never,
      extraDeps: {
        safetyFactory: withSessionState(createSafety, statePath),
        toolLog,
        voice: { speaker },
        accounts: { secrets, allowLoopbackHttp: true, notionOrigin: base, gmailOrigin: base, googleTokenOrigin: base, now: () => new Date('2026-11-02T12:00:00Z') },
      },
    });
    // announce first: once private data is read it says nothing (src/voice/announce.ts), and the TTS key must be used.
    const calls: [string, Record<string, unknown>][] = [
      ['announce', { text: 'Playing Say So by Doja Cat' }],
      ['canvas_due', { days: 3 }],
      ['canvas_announcements', {}],
      ['calendar_events', { range: 'today' }],
      ['notion_todos', {}],
      ['notion_search', { query: 'lab' }],
      ['gmail_search', {}],
      ['gmail_read', { id: MSG_ID }],
    ];
    for (const [name, args] of calls) {
      const r = (await h.call(name, args)) as CallToolResult;
      texts.push(`${name}: ${r.isError ? 'ERROR ' : ''}${textOf(r)}`);
    }
  } finally {
    for (const s of spies) s.mockRestore();
  }

  // The listener's history entry for this command: the tool log's records (as src/voice does), plus a reply.
  const history = new HistoryStore({ home: dir, retentionDays: 1 });
  history.append({ source: 'voice-ptt', said: 'what is due', reply: 'You have a quiz.', outcome: 'ok', tools: readToolLog(toolLog), followUp: false, ms: 1, turns: 1 });

  const files = [h!.cfg.auditLogPath, statePath, toolLog, ...readdirSync(join(dir, 'history')).map((f) => join(dir, 'history', f))];
  return { texts, files, out: out.join('') };
}

function expectNoSecret(where: string, text: string): void {
  for (const [name, secret] of Object.entries(SECRETS)) expect(text.includes(secret), `${name} secret in ${where}`).toBe(false);
}

describe('no secret leaves Stephen (tool results, logs, state, history, stdout/stderr)', () => {
  for (const mode of ['services answer normally', 'every service fails and echoes the request'] as const) {
    it(mode, async () => {
      failing = mode !== 'services answer normally';
      const r = await runServe(failing ? 'fail' : 'ok');

      // The paths really ran: secrets were used, the gate state, audit log, tool log and history were written.
      if (!failing) {
        expect(r.texts.find((t) => t.startsWith('canvas_due'))).toContain('Quiz 3');
        expect(r.texts.find((t) => t.startsWith('calendar_events'))).toContain('Lecture');
        expect(r.texts.find((t) => t.startsWith('notion_todos'))).toContain('Lab report');
        expect(r.texts.find((t) => t.startsWith('gmail_read'))).toContain('The midterm is Thursday.');
        expect(eleven.requests.at(-1)?.key).toBe(SECRETS.eleven);
      } else {
        expect(r.texts.filter((t) => t.includes('ERROR')).length).toBeGreaterThanOrEqual(5);
      }
      // (No read succeeds when every service fails, so the gate has no state to save then.)
      for (const f of r.files) if (!failing || !f.endsWith('conversation-state.json')) expect(statSync(f).size, f).toBeGreaterThan(0);
      expect(readFileSync(r.files[2]!, 'utf8')).toContain('canvas_due');

      for (const t of r.texts) expectNoSecret('a tool result', t);
      for (const f of r.files) expectNoSecret(f, existsSync(f) ? readFileSync(f, 'utf8') : '');
      expectNoSecret('stdout/stderr', r.out);
    });
  }
});
