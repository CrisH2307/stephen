/**
 * Cross-site taint and outbound-URL analysis (review finding #1).
 *
 * THE RULE (policy.ts applies it; this module supplies the facts):
 *
 *  1. Taint. Reading (snapshot / read_text / find / screenshot → gate.noteRead) any PRIVATE ORIGIN —
 *     mail, private apps (Drive/Docs/Notion/Slack/Calendar/Teams/OneDrive/Dropbox/iCloud/Proton/
 *     Fastmail/GitHub/Linear/Jira…), every sensitive domain and the user's `sensitiveDomains` —
 *     records that exact host (and, for collaborative hosts — Google Docs/Drive, Notion, Figma, Miro,
 *     Airtable, Coda, Quip, Dropbox, Confluence/Jira, SharePoint/OneDrive, Linear, Slack, Discord, Trello,
 *     Asana, GitHub… — the document / channel / board: see SCOPE_RULES and `taintScope`). The taint never expires during the session: a prompt-injected model can wait.
 *
 *  2. Text entry (type / fill_form / select / text-producing or paste key / prompt() text) whose
 *     destination scope differs from ANY tainted scope → confirm. Exact host, not eTLD+1, so
 *     docs.google.com after mail.google.com asks; on collaborative hosts a different document / channel /
 *     repository on the same host also asks (attacker-shared doc, attacker's DM, attacker's issue). After a
 *     private read, any text-producing key counts as text entry wherever focus is (page key listeners).
 *
 *  3. Outbound URL (navigate, tab_open, link click via element.href, form submit via formAction, Enter
 *     in a form field) → confirm when
 *       (a) it matches an OPEN ENDPOINT (redirector, shortener, form/script endpoint, request
 *           collector, tunnel, serverless/instant hosting, pastebin) — even on a tainted host; or
 *       (b) its host differs from ANY tainted host AND the URL can carry data: a non-empty query
 *           string or #fragment, user:pass@, an explicit port, a raw IP host, more than URL_DATA_BUDGET
 *           characters of sub-domain labels + path COMBINED, or it is a form submission (fields travel
 *           in the request).
 *
 *  4. First interaction (review #2 finding 6). Clicks, hovers, scrolls, key presses… are seen by page
 *     scripts, so each one is a (low-bandwidth) channel. After a private read, the first interaction on a
 *     host that was neither read privately nor approved asks "Allow it to interact with <host> for the rest
 *     of this session?"; approval trusts that host until the server stops.
 *
 *  5. First destination (residual gap after review #2: evil.com/482913 and 482913.evil.com fit the
 *     data budget). After a private read, an outbound URL that carries ANYTHING beyond a bare origin — a
 *     path, or a sub-domain other than www — to a host neither read privately nor approved asks once
 *     ("Allow it to visit <host> for the rest of this session?"); approval trusts the host, shared with
 *     rule 4. Only bare origins (https://ycombinator.com/, https://www.wikipedia.org/) stay frictionless.
 *     Rule 3 still applies to trusted hosts: data-carrying URLs (query, long path…) ask every time.
 *
 * Trade-off (deliberate): we keep no page content, so we cannot tell whether a query string
 * contains something that was read. A web search after reading private content
 * (https://www.google.com/search?q=weather) therefore asks once per search, as do clicks on links
 * with tracking parameters and opening a long document URL on another host. Search engines are not
 * exempt: they redirect (I'm Feeling Lucky, DuckDuckGo bangs) and leak queries to site owners.
 */
import {
  compilePatterns,
  type DomainPattern,
  findMatch,
  hostMatches,
  isIpHost,
  type ParsedUrl,
  parseUrl,
  registrableDomain,
} from './domains.js';

/**
 * URL DATA BUDGET (review #2 finding 5). The characters an outbound URL can choose freely without a query
 * or fragment: the subdomain labels left of the registrable domain (wildcard DNS delivers them to the
 * attacker) PLUS the path. One combined budget, so `https://<20>.<20>.<20>.evil.com/<30>` no longer passes
 * label by label. github.com/anthropics/claude-code/issues (29) and www.bbc.co.uk/news/world (13) fit;
 * github.com/anthropics/claude-code/pull/12345 (33) asks.
 * A non-empty query or fragment always counts as data, whatever its length.
 */
export const URL_DATA_BUDGET = 30;

/** One tainted scope: an exact host, or host + document for multi-tenant document hosts. */
export interface PrivateRead {
  host: string;
  scope: string;
  at: number;
}

// ───────────────────────────── per-document taint scopes (review #2 finding 3) ─────────────────────────────
//
// On a collaborative host, the user's private document and an attacker-shared one live side by side (and
// most of these apps autosave as you type). So the taint scope there is the DOCUMENT, not the host: reading
// Notion page A then typing into Notion page B asks. Each rule maps a URL on its hosts to a document key;
// a URL on such a host where no document can be recognized keeps the plain host scope, which differs from
// every document scope (so it asks too — friction, never a hole).

type KeyFn = (u: ParsedUrl, segs: string[], q: URLSearchParams) => string | null;
interface ScopeRule {
  /** domains.ts grammar: 'domain' = itself + subdomains, '*.domain' = subdomains only. */
  hosts: string[];
  key: KeyFn;
}

const seg = (segs: string[], i: number): string | null => (segs[i] !== undefined && segs[i] !== '' ? segs[i]! : null);
/** segs[i+1] when segs[i] (case-insensitive) is one of `names`. */
const after = (segs: string[], names: string[]): string | null => {
  for (let i = 0; i < segs.length - 1; i++) if (names.includes(segs[i]!.toLowerCase())) return segs[i + 1]!;
  return null;
};
const NOTION_ID = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const notionId = (raw: string): string => {
  const m = NOTION_ID.exec(raw);
  return m ? m[1]!.replace(/-/g, '').toLowerCase() : raw.toLowerCase();
};
const GUID = /\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/i;
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

const GOOGLE_DOC_RE = /^\/(document|spreadsheets|presentation|forms|drawings|file|jamboard)\/(?:u\/\d+\/)?d\/(?:e\/)?([^/?#]+)/;
const REPO_RESERVED: ReadonlySet<string> = new Set([
  'settings', 'notifications', 'orgs', 'organizations', 'marketplace', 'explore', 'search', 'login', 'logout',
  'sessions', 'new', 'pulls', 'issues', 'dashboard', 'users', 'groups', '-', 'account', 'topics', 'trending',
]);

export const SCOPE_RULES: readonly ScopeRule[] = [
  // Google Docs/Sheets/Slides/Forms/Drawings: /<kind>/d/<id>
  {
    hosts: ['docs.google.com'],
    key: (u) => {
      const m = GOOGLE_DOC_RE.exec(u.pathname);
      return m ? `${m[1]}/d/${m[2]}` : null;
    },
  },
  // Google Drive files and folders: /file/d/<id>, /drive/folders/<id>, /open?id=<id>
  {
    hosts: ['drive.google.com'],
    key: (u, segs, q) => after(segs, ['d', 'folders']) ?? q.get('id'),
  },
  // GitHub / GitLab / Bitbucket: /<owner>/<repo>
  {
    hosts: ['github.com', 'gitlab.com', 'bitbucket.org'],
    key: (_u, segs) =>
      segs.length >= 2 && !REPO_RESERVED.has(segs[0]!.toLowerCase()) ? `${segs[0]!.toLowerCase()}/${segs[1]!.toLowerCase()}` : null,
  },
  // Gists: /<user>/<id> or /<id>
  { hosts: ['gist.github.com'], key: (_u, segs) => seg(segs, segs.length - 1) },
  // Notion: …/<Title>-<32 hex id> (any workspace prefix), ?p=<id> (peeked page), *.notion.site published pages
  {
    hosts: ['notion.so', 'notion.com', 'notion.site'],
    key: (_u, segs, q) => {
      const p = q.get('p');
      if (p) return notionId(p);
      const last = seg(segs, segs.length - 1);
      return last ? notionId(last) : null;
    },
  },
  // Figma: /file|design|board|proto|slides|deck|make|site/<key>
  { hosts: ['figma.com'], key: (_u, segs) => after(segs, ['file', 'design', 'board', 'proto', 'slides', 'deck', 'make', 'site', 'buzz']) },
  // Miro: /app/board/<id>/
  { hosts: ['miro.com'], key: (_u, segs) => after(segs, ['board']) },
  // Airtable: /<appXXXXXXXX>/… (the base)
  { hosts: ['airtable.com'], key: (_u, segs) => (segs[0] && /^app[a-z0-9]+$/i.test(segs[0]) ? segs[0] : null) },
  // Coda: /d/<Title>_d<docId>/…
  {
    hosts: ['coda.io'],
    key: (_u, segs) => {
      const d = after(segs, ['d']);
      if (!d) return null;
      const m = /_d([A-Za-z0-9-]+)$/.exec(d);
      return m ? m[1]! : d;
    },
  },
  // Quip (and company.quip.com): /<threadId>/<title>
  {
    hosts: ['quip.com'],
    key: (_u, segs) => (segs[0] && /^[A-Za-z0-9]{8,}$/.test(segs[0]) && !/^(?:browse|settings|account)$/i.test(segs[0]) ? segs[0] : null),
  },
  // Dropbox Paper: /doc/<Title>--<id>; Dropbox shared links /s/<id>, /scl/fi/<id>, /scl/fo/<id>, /sh/<id>
  {
    hosts: ['paper.dropbox.com'],
    key: (_u, segs) => {
      const d = after(segs, ['doc', 'ep', 'folder']);
      if (!d) return null;
      const i = d.lastIndexOf('--');
      return i >= 0 ? d.slice(i + 2) : d;
    },
  },
  { hosts: ['dropbox.com'], key: (_u, segs) => after(segs, ['s', 'fi', 'fo', 'sh']) },
  // Confluence (/wiki/spaces/<SPACE>/pages/<id>, else the space) and Jira (issue key, else project)
  {
    hosts: ['*.atlassian.net'],
    key: (_u, segs, q) => {
      if (segs[0]?.toLowerCase() === 'wiki') {
        const page = after(segs, ['pages']);
        if (page) return `wiki/page/${page}`;
        const tiny = after(segs, ['x']);
        if (tiny) return `wiki/x/${tiny}`;
        const space = after(segs, ['spaces', 'display']);
        return space ? `wiki/space/${space.toLowerCase()}` : null;
      }
      const sel = q.get('selectedIssue');
      if (sel && JIRA_KEY.test(sel.toUpperCase())) return `issue/${sel.toUpperCase()}`;
      const issue = segs.find((s) => JIRA_KEY.test(s));
      if (issue) return `issue/${issue}`;
      const project = after(segs, ['projects']);
      return project ? `project/${project.toUpperCase()}` : null;
    },
  },
  // SharePoint / OneDrive for Business: ?sourcedoc={GUID}, sharing links /:w:/r|g|s/…/<token>, else the site / personal drive
  {
    hosts: ['*.sharepoint.com'],
    key: (_u, segs, q) => {
      const doc = q.get('sourcedoc') ?? q.get('sourceDoc') ?? q.get('UniqueId') ?? q.get('uniqueid');
      const g = doc ? GUID.exec(doc) : null;
      if (g) return `doc/${g[1]!.toLowerCase()}`;
      if (segs[0] && /^:[a-z]:$/i.test(segs[0]) && segs.length >= 3 && !segs.includes('_layouts')) {
        return `link/${segs[segs.length - 1]}`;
      }
      const site = after(segs, ['sites', 'teams', 'personal']);
      return site ? `site/${site.toLowerCase()}` : null;
    },
  },
  // OneDrive (consumer): ?resid= / ?id= item, /personal/<cid>/…
  {
    hosts: ['onedrive.live.com'],
    key: (_u, segs, q) => {
      const item = q.get('resid') ?? q.get('id');
      if (item) return `item/${item.toLowerCase()}`;
      const p = after(segs, ['personal']);
      return p ? `personal/${p.toLowerCase()}` : null;
    },
  },
  // Microsoft Loop: /p/<token>
  { hosts: ['loop.cloud.microsoft'], key: (_u, segs) => after(segs, ['p']) },
  // Linear: /<ws>/issue/<KEY-1>, /<ws>/project/<slug>, /<ws>/document/<slug>, else the workspace
  {
    hosts: ['linear.app'],
    key: (_u, segs) => {
      const ws = seg(segs, 0);
      if (!ws) return null;
      for (const kind of ['issue', 'project', 'document', 'view']) {
        const id = after(segs, [kind]);
        if (id) return `${ws.toLowerCase()}/${kind}/${kind === 'issue' ? id.toUpperCase() : id.toLowerCase()}`;
      }
      return ws.toLowerCase();
    },
  },
  // Slack: app.slack.com/client/<TEAM>/<CHANNEL>, <ws>.slack.com/archives/<CHANNEL>, /messages/<CHANNEL>
  {
    hosts: ['slack.com'],
    key: (_u, segs) => {
      const i = segs.findIndex((s) => s.toLowerCase() === 'client');
      if (i >= 0 && segs[i + 2]) return `${segs[i + 1]!.toUpperCase()}/${segs[i + 2]!.toUpperCase()}`;
      const ch = after(segs, ['archives', 'messages']);
      return ch ? ch.toUpperCase() : null;
    },
  },
  // Discord: /channels/<guild|@me>/<channel>
  {
    hosts: ['discord.com'],
    key: (_u, segs) => {
      const i = segs.findIndex((s) => s.toLowerCase() === 'channels');
      return i >= 0 && segs[i + 2] ? `${segs[i + 1]}/${segs[i + 2]}` : null;
    },
  },
  // Trello: /b/<boardId>/…, /c/<cardId>/…
  {
    hosts: ['trello.com'],
    key: (_u, segs) => (segs[0] && /^[bc]$/i.test(segs[0]) && segs[1] ? `${segs[0].toLowerCase()}/${segs[1]}` : null),
  },
  // Asana: /0/<projectId>/<taskId> (legacy), /1/<ws>/project/<projectId>/…
  {
    hosts: ['app.asana.com'],
    key: (_u, segs) => {
      const p = after(segs, ['project']);
      if (p) return `project/${p}`;
      if (segs[0] === '0' && segs[1] && /^\d+$/.test(segs[1])) return `project/${segs[1]}`;
      return null;
    },
  },
  // Box: /file/<id>, /folder/<id>, /s/<shared>, /notes/<id>
  { hosts: ['box.com'], key: (_u, segs) => { const k = segs[0]?.toLowerCase(); return k && ['file', 'folder', 's', 'notes'].includes(k) && segs[1] ? `${k}/${segs[1]}` : null; } },
  // ClickUp: /t/<taskId>, /<team>/v/<view>/…
  { hosts: ['app.clickup.com'], key: (_u, segs) => { const t = after(segs, ['t']); return t ? `t/${t}` : seg(segs, 0); } },
  // monday.com: /boards/<id>
  { hosts: ['monday.com'], key: (_u, segs) => after(segs, ['boards']) },
  // Basecamp: /<account>/buckets/<projectId>/…
  { hosts: ['3.basecamp.com'], key: (_u, segs) => { const b = after(segs, ['buckets']); return b ? `${seg(segs, 0)}/${b}` : null; } },
  // Zendesk: /agent/tickets/<id> (tickets are opened by outside customers)
  { hosts: ['zendesk.com'], key: (_u, segs) => { const t = after(segs, ['tickets']); return t ? `ticket/${t}` : null; } },
  // Intercom: …/conversation/<id>
  { hosts: ['app.intercom.com'], key: (_u, segs) => { const c = after(segs, ['conversation', 'conversations']); return c ? `conversation/${c}` : null; } },
];

const COMPILED_SCOPE_RULES: ReadonlyArray<{ patterns: DomainPattern[]; key: KeyFn }> = SCOPE_RULES.map((r) => ({
  patterns: compilePatterns(r.hosts),
  key: r.key,
}));

/**
 * Taint scope of a URL: `host/<document key>` on the collaborative hosts in SCOPE_RULES, else the exact
 * normalized host. '' for non-web URLs. Examples:
 *   docs.google.com/document/d/<id>/edit        → 'docs.google.com/document/d/<id>'
 *   www.notion.so/acme/Salary-review-<32 hex>   → 'www.notion.so/<32 hex>'
 *   app.slack.com/client/T01/C02/thread/…       → 'app.slack.com/T01/C02'
 *   github.com/<owner>/<repo>/issues/3          → 'github.com/<owner>/<repo>'
 */
export function taintScope(raw: string): string {
  const u = parseUrl(raw);
  if (!u || !u.isWeb) return '';
  return scopeOf(u);
}

function scopeOf(u: ParsedUrl): string {
  const rule = COMPILED_SCOPE_RULES.find((r) => r.patterns.some((p) => hostMatches(u.host, p)));
  if (!rule) return u.host;
  let segs: string[];
  try {
    segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    segs = u.pathname.split('/').filter(Boolean);
  }
  let key: string | null = null;
  try {
    key = rule.key(u, segs, new URLSearchParams(u.search));
  } catch {
    key = null;
  }
  return key ? `${u.host}/${key}` : u.host;
}

/** The read record for a private origin, else null. */
export function privateReadOf(raw: string, privateSources: readonly DomainPattern[], at: number): PrivateRead | null {
  const u = parseUrl(raw);
  if (!u || !u.isWeb || !findMatch(u, privateSources)) return null;
  return { host: u.host, scope: scopeOf(u), at };
}

/** Tainted reads whose scope differs from `destScope` ('' = unknown/non-web → every read differs). */
export function taintFromOtherScopes(reads: readonly PrivateRead[], destScope: string): PrivateRead[] {
  return reads.filter((r) => destScope === '' || r.scope !== destScope);
}

/** Tainted reads whose HOST differs from `destHost`. */
export function taintFromOtherHosts(reads: readonly PrivateRead[], destHost: string): PrivateRead[] {
  return reads.filter((r) => destHost === '' || r.host !== destHost);
}

// ───────────────────────────── private data read by Stephen's own tools (phase 2a) ─────────────────────────────

/**
 * Sources of private data read through Stephen's own API tools (Canvas, Gmail, Notion, calendar), not a web page.
 * "private" = `serve --assume-private-read` (taint armed from the start). See docs/PLAN-2A-READ-MY-STUFF.md.
 */
export const PRIVATE_DATA_SOURCES = ['canvas', 'gmail', 'notion', 'calendar', 'private'] as const;
export type PrivateDataSource = (typeof PRIVATE_DATA_SOURCES)[number];
const PRIVATE_DATA_SUFFIX = '.private.stephen.invalid';
const PRIVATE_DATA_LABELS: Record<PrivateDataSource, string> = {
  canvas: 'your Canvas',
  gmail: 'your email',
  notion: 'your Notion',
  calendar: 'your calendar',
  private: 'your private data',
};

/**
 * The synthetic taint host of a source: `canvas.private.stephen.invalid`. `.invalid` can never resolve (RFC 2606),
 * so no real page has this host: every real destination counts as a different host than the read.
 */
export function privateDataHost(source: PrivateDataSource): string {
  if (!PRIVATE_DATA_SOURCES.includes(source)) throw new Error(`unknown private data source: ${String(source)}`);
  return `${source}${PRIVATE_DATA_SUFFIX}`;
}

/** "your Canvas" for a synthetic host, else null. */
export function privateDataLabel(host: string): string | null {
  if (!host.endsWith(PRIVATE_DATA_SUFFIX)) return null;
  const s = host.slice(0, -PRIVATE_DATA_SUFFIX.length) as PrivateDataSource;
  return PRIVATE_DATA_SOURCES.includes(s) ? PRIVATE_DATA_LABELS[s] : null;
}

/** "mail.google.com", "mail.google.com and docs.google.com", "mail.google.com and 3 other private sites". */
export function describeSources(reads: readonly PrivateRead[]): string {
  const hosts = [...new Set(reads.map((r) => privateDataLabel(r.host) ?? r.host))];
  if (hosts.length === 0) return 'a private site';
  if (hosts.length === 1) return hosts[0]!;
  if (hosts.length === 2) return `${hosts[0]} and ${hosts[1]}`;
  return `${hosts[0]} and ${hosts.length - 1} other private sites`;
}

export interface Outbound {
  url: ParsedUrl;
  /** Plain-words reason this URL can carry data / forward it, or null for a bare-looking URL. */
  dataReason: string | null;
  /** Matched open-endpoint pattern (redirector / collector / form …), or null. */
  openEndpoint: string | null;
}

/**
 * Assess an outbound web URL. `isFormSubmission` = the request will carry form fields
 * (submit button / Enter in a form field), which always counts as data.
 */
export function assessOutbound(raw: string, openEndpoints: readonly DomainPattern[], isFormSubmission = false): Outbound | null {
  const url = parseUrl(raw);
  if (!url || !url.isWeb) return null;
  const open = findMatch(url, openEndpoints);
  return { url, dataReason: dataReasonOf(url, isFormSubmission), openEndpoint: open ? open.raw : null };
}

/** Characters of an outbound URL counted against URL_DATA_BUDGET: subdomain labels + path (no outer slashes). */
export function dataBudgetUsed(u: ParsedUrl): number {
  const reg = registrableDomain(u.host);
  const sub = u.host.length > reg.length ? u.host.slice(0, u.host.length - reg.length - 1) : '';
  const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  return sub.length + path.length;
}

function dataReasonOf(u: ParsedUrl, isFormSubmission: boolean): string | null {
  if (isFormSubmission) return 'it submits a form, which sends the form fields';
  if (u.search.length > 1) return 'it carries a query string (?…)';
  if (u.hash.length > 1) return 'it carries a #fragment';
  if (u.hasCredentials) return 'it embeds a user name/password';
  if (isIpHost(u.host)) return 'it points at a raw IP address';
  if (u.port !== '') return `it uses port ${u.port}`;
  const used = dataBudgetUsed(u);
  if (used > URL_DATA_BUDGET) {
    return `its sub-domain and path are long enough to carry data (${used} chars; more than ${URL_DATA_BUDGET} need your OK)`;
  }
  return null;
}
