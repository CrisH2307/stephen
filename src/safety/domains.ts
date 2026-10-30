/**
 * Host / URL normalization and domain-list matching for the safety gate.
 *
 * Everything here is pure. Hosts are compared only after normalization (lowercase, trailing
 * dots stripped, IDN → punycode), so `MAIL.GOOGLE.COM.` equals `mail.google.com` and a
 * homoglyph like `pаypal.com` (Cyrillic а → `xn--pypal-4ve.com`) never equals `paypal.com`.
 */

// ───────────────────────────── Normalization ─────────────────────────────

/**
 * Canonical host for comparisons: lowercase, trailing dots stripped, IDN → punycode (UTS#46, so
 * fullwidth/ideographic dots map to '.'), IPv4 in any WHATWG form (0x7f.1, 2130706433, 127.1) →
 * dotted quad, IPv6 compressed in brackets. A port is dropped. '' when invalid.
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h === '') return '';
  if (/[\s/?#@\\]/.test(h)) return '';
  // Bare IPv6 literal ("fe80::1") → bracket it so URL can canonicalize it.
  if (!h.startsWith('[') && (h.match(/:/g)?.length ?? 0) >= 2) h = `[${h}]`;
  if (!h.startsWith('[')) h = h.replace(/\.+$/, '');
  if (h === '') return '';
  let out: string;
  try {
    // WHATWG host parser: the same canonicalization the browser applies before connecting.
    out = new URL(`http://${h}/`).hostname;
  } catch {
    return '';
  }
  return out.replace(/\.+$/, '');
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True for a (normalized) IPv4 dotted quad or bracketed IPv6 literal. */
export function isIpHost(host: string): boolean {
  const h = normalizeHost(host);
  return h.startsWith('[') || IPV4.test(h);
}

/**
 * Multi-label public suffixes we know about (a deliberately small subset of the PSL), plus
 * shared-hosting suffixes where each subdomain belongs to a different owner.
 */
export const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  // UK
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'nhs.uk', 'sch.uk', 'police.uk',
  // Australia / NZ
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  // Canada (provincial + federal government)
  'gc.ca', 'qc.ca', 'on.ca', 'bc.ca', 'ab.ca', 'mb.ca', 'sk.ca', 'ns.ca', 'nb.ca', 'nl.ca', 'pe.ca',
  // Asia
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'com.sg', 'gov.sg', 'edu.sg', 'com.hk', 'gov.hk', 'com.cn', 'gov.cn', 'com.tw', 'co.kr', 'or.kr',
  'co.id', 'com.my', 'com.ph', 'co.th',
  // Americas / Africa / Europe misc
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.mx', 'org.mx', 'gob.mx', 'com.ar', 'gob.ar', 'com.co',
  'co.za', 'gov.za', 'com.tr', 'co.il', 'com.ua',
  // Shared hosting: every subdomain is a different site
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'herokuapp.com', 'appspot.com', 'blogspot.com', 'azurewebsites.net',
  'cloudfront.net', 's3.amazonaws.com', 'onrender.com', 'fly.dev', 'glitch.me', 'repl.co', 'ngrok.io',
  'ngrok-free.app', 'trycloudflare.com',
]);

/** eTLD+1 using MULTI_PART_SUFFIXES; IPs and single-label hosts are returned as-is. */
export function registrableDomain(host: string): string {
  const h = normalizeHost(host);
  if (h === '' || h.startsWith('[') || IPV4.test(h)) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  for (const n of [3, 2]) {
    if (labels.length < n) continue;
    const suffix = labels.slice(-n).join('.');
    if (MULTI_PART_SUFFIXES.has(suffix)) {
      return labels.length > n ? labels.slice(-(n + 1)).join('.') : h;
    }
  }
  return labels.slice(-2).join('.');
}

// ───────────────────────────── URLs ─────────────────────────────

export interface ParsedUrl {
  /** e.g. 'https:' */
  protocol: string;
  /** Normalized host ('' for hostless schemes). For blob: URLs this is the inner URL's host. */
  host: string;
  pathname: string;
  /** '?…' or '' (web URLs only). */
  search: string;
  hash: string;
  /** Explicit non-default port, '' otherwise. */
  port: string;
  /** user:pass@ present. */
  hasCredentials: boolean;
  href: string;
  /** True for http(s), and blob: wrapping http(s). */
  isWeb: boolean;
}

/** Parse an absolute URL; null when unparsable. blob:https://x/… is classified by its inner URL. */
export function parseUrl(raw: string): ParsedUrl | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  let inner = u;
  if (u.protocol === 'blob:') {
    try {
      inner = new URL(u.pathname);
    } catch {
      return { protocol: 'blob:', host: '', pathname: '', search: '', hash: '', port: '', hasCredentials: false, href: u.href, isWeb: false };
    }
  }
  const web = inner.protocol === 'http:' || inner.protocol === 'https:';
  return {
    protocol: u.protocol,
    host: web ? normalizeHost(inner.hostname) : '',
    pathname: web ? inner.pathname : u.pathname,
    search: web ? inner.search : '',
    hash: web ? inner.hash : u.hash,
    port: web ? inner.port : '',
    hasCredentials: web && (inner.username !== '' || inner.password !== ''),
    href: u.href,
    isWeb: web,
  };
}

/** Host for display / comparison, '' when none. */
export function hostOf(raw: string): string {
  return parseUrl(raw)?.host ?? '';
}

// ───────────────────────────── Patterns ─────────────────────────────

/**
 * A domain-list entry. Grammar (case-insensitive, scheme optional and ignored):
 *   example.com            → example.com and every subdomain
 *   .example.com           → same as above
 *   *.example.com          → subdomains only (not the apex)
 *   example.com/settings   → … and path starts with /settings (segment boundary)
 *   mail.google.com/mail/u/*\/#settings → `*` matches one path segment; a `#` makes the hash part of the match
 */
export interface DomainPattern {
  raw: string;
  host: string;
  subdomainsOnly: boolean;
  path: RegExp | null;
  pathIncludesHash: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function parsePattern(raw: string): DomainPattern | null {
  let s = raw.trim().toLowerCase();
  if (s === '') return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const cut = s.search(/[/#]/);
  let hostPart = cut === -1 ? s : s.slice(0, cut);
  let pathPart = cut === -1 ? '' : s.slice(cut);
  hostPart = hostPart.replace(/:\d+$/, '');
  let subdomainsOnly = false;
  if (hostPart.startsWith('*.')) {
    subdomainsOnly = true;
    hostPart = hostPart.slice(2);
  } else if (hostPart.startsWith('.')) {
    hostPart = hostPart.slice(1);
  }
  if (hostPart.includes('*')) return null;
  const host = normalizeHost(hostPart);
  if (host === '') return null;
  if (pathPart.startsWith('#')) pathPart = `/${pathPart}`;
  if (pathPart === '/' || pathPart === '') {
    return { raw, host, subdomainsOnly, path: null, pathIncludesHash: false };
  }
  const body = pathPart
    .split('*')
    .map(escapeRe)
    .join('[^/?#]*');
  const boundary = pathPart.endsWith('/') ? '' : '(?=$|[/?#])';
  return {
    raw,
    host,
    subdomainsOnly,
    path: new RegExp(`^${body}${boundary}`),
    pathIncludesHash: pathPart.includes('#'),
  };
}

export function compilePatterns(raws: readonly string[]): DomainPattern[] {
  const out: DomainPattern[] = [];
  for (const r of raws) {
    const p = parsePattern(r);
    if (p) out.push(p);
  }
  return out;
}

/** Host-only match: `pattern` may be a string or compiled pattern; any path part of the pattern is ignored. */
export function hostMatches(host: string, pattern: string | DomainPattern): boolean {
  const p = typeof pattern === 'string' ? parsePattern(pattern) : pattern;
  if (!p) return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  if (h.endsWith(`.${p.host}`)) return true;
  return !p.subdomainsOnly && h === p.host;
}

function pathCandidates(u: ParsedUrl, withHash: boolean): string[] {
  const raw = (u.pathname + (withHash ? u.hash : '')).toLowerCase();
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  const collapsed = decoded.replace(/\/{2,}/g, '/');
  return [...new Set([raw, decoded, collapsed])];
}

/** Host + optional path match against a parsed web URL. */
export function urlMatches(u: ParsedUrl, p: DomainPattern): boolean {
  if (!u.isWeb || !hostMatches(u.host, p)) return false;
  if (!p.path) return true;
  const re = p.path;
  return pathCandidates(u, p.pathIncludesHash).some((c) => re.test(c));
}

/** First matching pattern, or null. */
export function findMatch(u: ParsedUrl, patterns: readonly DomainPattern[]): DomainPattern | null {
  for (const p of patterns) if (urlMatches(u, p)) return p;
  return null;
}

// ───────────────────────────── Built-in lists ─────────────────────────────

/** Password-manager vaults and similar. Deny navigate + every action/read. */
export const BUILTIN_BLOCKED_DOMAINS: readonly string[] = [
  '1password.com',
  '1password.ca',
  '1password.eu',
  'lastpass.com',
  'vault.bitwarden.com',
  'vault.bitwarden.eu',
  'app.dashlane.com',
  'keepersecurity.com/vault',
  'keepersecurity.eu/vault',
  'pass.proton.me',
  'passwords.google.com',
  'passwords.google',
];

/**
 * URL schemes whose pages are never read or acted on. (Navigation targets are stricter: only
 * http:, https: and about:blank are allowed — see policy.ts.)
 */
export const BLOCKED_SCHEMES: readonly string[] = [
  'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'chrome-devtools:', 'devtools:',
  'about:', 'file:', 'javascript:', 'data:', 'view-source:', 'moz-extension:', 'resource:', 'edge:',
  'brave:', 'opera:', 'vivaldi:', 'filesystem:', 'jar:',
];

/** Pages where every mutation (and arriving by navigation) needs human confirmation. */
export const BUILTIN_SENSITIVE_DOMAINS: readonly string[] = [
  // Payments / fintech
  'paypal.com', 'dashboard.stripe.com', 'wise.com', 'venmo.com', 'cash.app', 'revolut.com', 'klarna.com',
  // US banks / cards
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'usbank.com', 'ally.com',
  'americanexpress.com', 'discover.com',
  // Canadian banks
  'rbc.com', 'rbcroyalbank.com', 'td.com', 'tdcanadatrust.com', 'bmo.com', 'scotiabank.com', 'cibc.com',
  'tangerine.ca', 'simplii.com', 'desjardins.com', 'nbc.ca', 'eqbank.ca',
  // UK / EU banks
  'hsbc.com', 'barclays.co.uk', 'monzo.com', 'n26.com',
  // Bank TLDs
  'bank', 'creditunion',
  // Investing / crypto
  'wealthsimple.com', 'questrade.com', 'interactivebrokers.com', 'fidelity.com', 'schwab.com', 'vanguard.com',
  'robinhood.com', 'etrade.com', 'coinbase.com', 'kraken.com', 'binance.com',
  // Government / tax / health
  'canada.ca', 'cra-arc.gc.ca', 'servicecanada.gc.ca', 'ontario.ca', 'irs.gov', 'ssa.gov', 'healthcare.gov',
  'medicare.gov', 'login.gov', 'id.me', 'gov.uk',
  // Identity / account security
  'accounts.google.com', 'myaccount.google.com', 'admin.google.com', 'account.microsoft.com',
  'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'account.apple.com', 'account.proton.me',
  'github.com/settings', 'gitlab.com/-/profile',
  // Cloud IAM consoles
  'console.aws.amazon.com/iam', 'console.cloud.google.com/iam-admin', 'portal.azure.com',
  // Mail forwarding / filter settings (classic exfiltration persistence)
  'mail.google.com/mail/u/*/#settings', 'mail.google.com/mail/#settings',
  'outlook.live.com/mail/*/options', 'outlook.live.com/mail/options',
  'outlook.office.com/mail/options', 'outlook.office365.com/mail/options',
];

/**
 * PRIVATE ORIGINS. Reading any of these (plus every sensitive domain and the user's
 * `sensitiveDomains`) arms the session's cross-site taint: later text entry on, or data-carrying
 * navigation to, a different host needs the user's OK (see policy.ts / egress.ts).
 * Grammar as for every list here: 'domain' = itself + subdomains, '*.domain' = subdomains only,
 * optional path prefix.
 */
export const BUILTIN_MAIL_DOMAINS: readonly string[] = [
  'mail.google.com', 'inbox.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
  'outlook.cloud.microsoft', 'mail.yahoo.com', 'mail.proton.me', 'proton.me', 'icloud.com', 'fastmail.com',
  'mail.aol.com', 'mail.zoho.com', 'mail.zoho.eu', 'app.hey.com', 'mail.superhuman.com', 'app.tuta.com',
  'mail.tutanota.com', 'mail.yandex.com', 'mail.gmx.com', 'mail.gmx.net',
];

/** Private productivity apps: documents, chat, calendars, files, tickets, code, CRM, AI chats. */
export const BUILTIN_PRIVATE_APP_DOMAINS: readonly string[] = [
  // Google Workspace
  'drive.google.com', 'docs.google.com', 'sheets.google.com', 'slides.google.com', 'calendar.google.com',
  'contacts.google.com', 'keep.google.com', 'chat.google.com', 'meet.google.com', 'photos.google.com',
  'voice.google.com', 'messages.google.com', 'tasks.google.com', 'gemini.google.com', 'notebooklm.google.com',
  // Microsoft 365
  'onedrive.live.com', '*.sharepoint.com', 'teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft',
  'to-do.office.com', 'to-do.live.com', 'www.office.com', 'm365.cloud.microsoft', 'loop.cloud.microsoft',
  'onenote.com', 'www.onenote.com', 'copilot.microsoft.com',
  // Notes / docs / wikis / whiteboards
  'notion.so', 'notion.com', 'coda.io', 'quip.com', 'evernote.com', 'dropbox.com', 'paper.dropbox.com',
  'app.box.com', '*.box.com', 'figma.com', 'miro.com', 'airtable.com', 'app.clickup.com', 'app.asana.com',
  'trello.com', '*.monday.com', '3.basecamp.com', 'linear.app', '*.atlassian.net', 'bitbucket.org',
  // Chat
  'app.slack.com', '*.slack.com', 'discord.com', 'web.whatsapp.com', 'web.telegram.org', 'messenger.com',
  'www.messenger.com', 'facebook.com/messages', 'www.facebook.com/messages', 'linkedin.com/messaging',
  'www.linkedin.com/messaging', 'x.com/messages', 'x.com/i/chat', 'signal.org', 'app.element.io',
  // Code (repos may be private)
  'github.com', 'gist.github.com', 'gitlab.com',
  // CRM / support / HR / finance tools
  '*.lightning.force.com', '*.my.salesforce.com', 'app.hubspot.com', '*.zendesk.com', 'app.intercom.com',
  'app.gusto.com', '*.workday.com', '*.myworkday.com', 'app.rippling.com', 'quickbooks.intuit.com',
  'app.xero.com', 'dashboard.stripe.com',
  // Proton / Fastmail / iCloud suites (non-mail parts)
  'drive.proton.me', 'calendar.proton.me', 'app.fastmail.com', 'www.icloud.com',
  // AI chat histories
  'claude.ai', 'chatgpt.com', 'chat.openai.com',
  // Password-adjacent / personal data
  'calendly.com/app', 'zoom.us/meeting', 'app.zoom.us',
];

/**
 * OPEN ENDPOINTS: hosts/paths that forward, store or hand to a third party whatever the URL
 * carries — redirectors, URL shorteners, form/script endpoints anyone can create, request
 * collectors, tunnels, serverless function hosts and pastebins. While the cross-site taint is armed
 * ANY navigation/link to one of these needs the user's OK (even a bare-looking URL, and even on
 * the same host that was read: an attacker's Google Form lives on docs.google.com).
 */
export const OPEN_ENDPOINT_DOMAINS: readonly string[] = [
  // Google redirectors and attacker-creatable endpoints on google.com hosts
  'google.com/url', 'www.google.com/url', 'google.com/amp', 'www.google.com/amp', 'google.com/imgres',
  'www.google.com/imgres', 'google.com/sorry', 'www.google.com/sorry', 'google.com/interstitial',
  'www.google.com/interstitial', 'script.google.com', 'script.googleusercontent.com',
  '*.googleusercontent.com', 'docs.google.com/forms', 'forms.gle', 'sites.google.com', 'goo.gl', 'g.co',
  'translate.google.com', '*.translate.goog', 'firebasestorage.googleapis.com', 'storage.googleapis.com',
  '*.cloudfunctions.net', '*.run.app', '*.appspot.com', 'datastudio.google.com', 'lookerstudio.google.com',
  // Microsoft equivalents
  'forms.office.com', 'forms.microsoft.com', 'forms.cloud.microsoft', 'aka.ms', '*.safelinks.protection.outlook.com',
  'outlook.office365.com/owa/redir.aspx', '*.azurewebsites.net', '*.azure-api.net', '*.logic.azure.com',
  // Other redirectors / link wrappers
  'l.facebook.com', 'lm.facebook.com', 'l.instagram.com', 'out.reddit.com', 'click.redditmail.com',
  'www.youtube.com/redirect', 'youtube.com/redirect', 'slack-redir.net', 'href.li', 'urldefense.com',
  'urldefense.proofpoint.com', 'linkprotect.cudasvc.com', 'r.jina.ai', 'web.archive.org/save',
  // URL shorteners
  'bit.ly', 'bitly.com', 't.co', 'tinyurl.com', 'ow.ly', 'is.gd', 'v.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly',
  'shorturl.at', 't.ly', 'rb.gy', 'tiny.cc', 'lnkd.in', 'shorturl.com', 's.id', 'qrco.de', 'bl.ink', 'short.io',
  'tr.ee', 'linktr.ee', 'dub.sh',
  // Forms anyone can create
  '*.typeform.com', 'form.typeform.com', 'jotform.com', '*.jotform.com', 'tally.so', 'formspree.io',
  'getform.io', 'usebasin.com', 'airtable.com/shr*', 'airtable.com/app*/shr*', 'airtable.com/app*/pag*',
  // Request collectors / webhooks / OAST
  'webhook.site', 'requestbin.com', '*.requestbin.com', '*.requestbin.net', '*.pipedream.net', 'hookbin.com',
  'beeceptor.com', '*.beeceptor.com', 'requestcatcher.com', '*.requestcatcher.com', 'postb.in', 'ptsv2.com',
  'ptsv3.com', 'httpbin.org', 'eu.httpbin.org', 'requestinspector.com', 'webhook.cool', 'hooks.zapier.com',
  'hook.integromat.com', '*.make.com', 'hooks.slack.com', 'discord.com/api/webhooks',
  'discordapp.com/api/webhooks', 'api.telegram.org', 'interact.sh', '*.interact.sh', '*.oast.fun',
  '*.oast.live', '*.oast.me', '*.oast.pro', '*.oast.site', '*.oast.online', 'burpcollaborator.net',
  '*.burpcollaborator.net', 'oastify.com', '*.oastify.com', 'canarytokens.com', 'dnslog.cn', '*.dnslog.cn',
  // Tunnels / serverless / instant hosting
  '*.ngrok.io', '*.ngrok-free.app', '*.ngrok.app', '*.ngrok.dev', '*.ngrok-free.dev', '*.ngrok.pizza',
  '*.trycloudflare.com', '*.workers.dev', '*.loca.lt', 'localtunnel.me', '*.localtunnel.me', '*.serveo.net',
  '*.serveousercontent.com', '*.localhost.run', '*.lhr.life', '*.pagekite.me', '*.tunnelmole.net',
  'on.aws', '*.amazonaws.com',
  '*.vercel.app', '*.netlify.app', '*.glitch.me', '*.repl.co', '*.replit.dev', '*.replit.app',
  '*.deno.dev', '*.val.run', '*.fly.dev', '*.onrender.com', '*.herokuapp.com', '*.pages.dev',
  '*.github.io', '*.gitlab.io', '*.surge.sh', 'neocities.org', '*.neocities.org',
  // Pastebins
  'pastebin.com', 'paste.ee', 'hastebin.com', 'ghostbin.co', 'dpaste.org', 'dpaste.com', 'rentry.co',
  'rentry.org', 'privatebin.net', 'paste.rs', 'termbin.com', 'controlc.com', 'justpaste.it', 'pastes.io',
  'gist.githubusercontent.com', 'transfer.sh', 'file.io', '0x0.st', 'temp.sh',
];
