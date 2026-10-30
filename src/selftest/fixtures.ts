/**
 * Fixture pages for `browser-hub selftest`, served from this process on 127.0.0.1 only.
 *
 * Two listeners give two origins (and sites): A = http://127.0.0.1:<pa>, B = http://localhost:<pb>.
 * Both share one record of what the pages reported back (`hits`) and of form submissions, so the
 * selftest can verify SERVER-SIDE that a refused "Send" really sent nothing, a covered button was not
 * clicked, and a click inside the cross-origin iframe landed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FixtureServer {
  /** http://127.0.0.1:<port> */
  readonly a: string;
  /** http://localhost:<port> (different origin and site from `a`) */
  readonly b: string;
  /** Bodies of POST /submit requests received so far. */
  submissions(): string[];
  /** `what` values pages reported via POST /hit?what=… (button clicks, password input, submit events). */
  hits(): string[];
  /** Wait up to `ms` for a hit to arrive (page beacons are asynchronous). */
  waitForHit(what: string, ms: number): Promise<boolean>;
  close(): Promise<void>;
}

const HIT_JS = `function hit(what){try{fetch('/hit?what='+encodeURIComponent(what),{method:'POST',keepalive:true}).catch(function(){});}catch(e){}}`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px}label{display:block;margin:8px 0}</style>
<script>${HIT_JS}</script></head><body>${body}</body></html>`;
}

const FORM_PAGE = page(
  'Selftest form',
  `<main>
<h1>browser-hub selftest form</h1>
<form id="f" method="post" action="/submit">
  <label>Full name <input id="name" name="fullname" type="text"></label>
  <label>Notes <textarea id="notes" name="notes" rows="3" cols="40"></textarea></label>
  <label>Color <select id="color" name="color">
    <option value="">Choose…</option><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option>
  </select></label>
  <label><input id="extras" type="checkbox" name="extras" value="yes"> Include extra details</label>
  <label>Password <input id="pw" type="password" name="password" autocomplete="current-password"></label>
  <button type="submit">Send</button>
</form>
<p id="echo">Echo: nothing yet</p>
</main>
<script>
  var f = document.getElementById('f');
  function update() {
    document.getElementById('echo').textContent =
      'Echo: name=' + f.fullname.value + ' | notes=' + f.notes.value.replace(/\\n/g, '[NL]') +
      ' | color=' + f.color.value + ' | extras=' + (f.extras.checked ? 'yes' : 'no');
  }
  f.addEventListener('input', update);
  f.addEventListener('change', update);
  document.getElementById('pw').addEventListener('input', function () { hit('password-input'); });
  f.addEventListener('submit', function () { hit('submit-event'); });
</script>`,
);

const OVERLAY_PAGE = page(
  'Selftest overlay',
  `<main>
<h1>Overlay test</h1>
<button id="covered" style="position:absolute;left:40px;top:140px;width:240px;height:48px" onclick="hit('covered-button')">Continue to next step</button>
</main>
<div id="shield" style="position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.25);z-index:10" onclick="hit('overlay')"></div>`,
);

const framesPage = (originB: string): string =>
  page(
    'Selftest frames',
    `<main>
<h1>Frames test</h1>
<button id="parentbtn" onclick="hit('parent-button')">Parent button</button>
<iframe id="cross" title="Cross-origin frame" src="${originB}/frame-child" width="420" height="160"></iframe>
</main>`,
  );

const FRAME_CHILD = page(
  'Selftest frame child',
  `<p>Inside the cross-origin frame</p>
<button id="framebtn" onclick="hit('frame-button')">Frame button</button>`,
);

const INDEX_PAGE = page('Selftest', '<main><h1>browser-hub selftest</h1><p>Local fixture server.</p></main>');

const MAX_BODY = 64 * 1024;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Start both fixture listeners on 127.0.0.1 (random ports). */
export async function startFixtureServer(): Promise<FixtureServer> {
  const submissions: string[] = [];
  const hits: string[] = [];
  const waiters = new Set<() => void>();
  const origins = { a: '', b: '' };
  const allowedHosts = new Set<string>();

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // Only answer requests addressed to our own two origins (no DNS-rebinding style access).
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end('misdirected');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    const html = (body: string): void => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
    };

    if (req.method === 'POST' && (url.pathname === '/submit' || url.pathname === '/hit')) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        if (body.length < MAX_BODY) body += chunk;
      });
      req.on('end', () => {
        if (url.pathname === '/submit') {
          submissions.push(body);
          html(page('Submitted', '<p>Submitted.</p>'));
        } else {
          hits.push(url.searchParams.get('what') ?? '');
          res.writeHead(204).end();
        }
        for (const w of [...waiters]) w();
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    switch (url.pathname) {
      case '/':
        return html(INDEX_PAGE);
      case '/form':
        return html(FORM_PAGE);
      case '/overlay':
        return html(OVERLAY_PAGE);
      case '/frames':
        return html(framesPage(origins.b));
      case '/frame-child':
        return html(FRAME_CHILD);
      default:
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  };

  const sa = createServer(handler);
  const sb = createServer(handler);
  const [pa, pb] = await Promise.all([listen(sa), listen(sb)]);
  origins.a = `http://127.0.0.1:${pa}`;
  origins.b = `http://localhost:${pb}`;
  for (const h of [`127.0.0.1:${pa}`, `localhost:${pa}`, `127.0.0.1:${pb}`, `localhost:${pb}`]) allowedHosts.add(h);

  return {
    a: origins.a,
    b: origins.b,
    submissions: () => [...submissions],
    hits: () => [...hits],
    waitForHit(what, ms) {
      if (hits.includes(what)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (ok: boolean) => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(ok);
        };
        const check = () => {
          if (hits.includes(what)) done(true);
        };
        const timer = setTimeout(() => done(false), ms);
        timer.unref?.();
        waiters.add(check);
      });
    },
    async close() {
      for (const w of [...waiters]) w();
      await Promise.all([closeServer(sa), closeServer(sb)]);
    },
  };
}
