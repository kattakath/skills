// Local fixture site for the gate's detectors: 127.0.0.1, a random port, no network beyond it.
//
//   import { startFixtureServer } from './server.mjs';
//   const { base, close, setTrace, hits } = await startFixtureServer();
//
// /cdn-cgi/trace mimics Cloudflare's trace (text/plain key=value lines) for the egress
// preflight; setTrace(body) swaps the body per case. Its ip= is a TEST-NET-3 sentinel
// (RFC 5737) that a test asserts never reaches an event, a run file or the gate's output.
//
// One route per detector rule, plus pages that must PASS. The challenge pages mimic only the
// MARKERS the detectors look for (an id, an iframe src, a title) — no real challenge script.

import { createServer } from 'node:http';

const html = (title, body = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const ROUTES = {
  '/ok': [200, html('ok', '<main><h1>fine</h1><p>an ordinary page</p></main>')],
  '/ok-2': [200, html('ok two', '<main><p>another ordinary page</p></main>')],
  '/ok-3': [200, html('ok three', '<main><p>a third</p></main>')],
  '/login': [200, html('Sign in', '<form><input name="u"><input name="p" type="password"></form>')],
  '/403': [403, html('Forbidden', '<p>no</p>')],
  '/429': [429, html('Too Many Requests', '<p>slow down</p>')],
  '/503': [503, html('Service Unavailable', '<p>later</p>')],
  '/challenge-title': [200, html('Just a moment...', '<p>checking</p>')],
  // Challenge MARKERS count only when corroborated (gate-detectors.json probe.corroboration):
  // these three answer 401 — a status >= 400 that is not itself a stop rule.
  '/cf-chl': [401, html('example', '<div id="cf-chl-widget-a1b2c" style="width:300px;height:65px">x</div>')],
  '/hcaptcha': [401, html('example', '<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html" width="300" height="150"></iframe>')],
  '/recaptcha': [401, html('example', '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x" width="300" height="80"></iframe>')],
  // MUST PASS. The measured false positive: Cloudflare injects this beacon into normal 200 pages.
  '/cf-beacon': [200, html('ordinary', '<main><p>fine</p></main><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>')],
  // MUST PASS. A captcha widget on a normal 200 page (a login form's) is not a wall.
  '/hcaptcha-200': [200, html('contact us', '<form><div class="h-captcha" style="width:300px;height:80px"></div></form>')],
  '/consent': [200, html('example', '<div id="onetrust-consent-sdk" style="position:fixed;inset:0;background:#fff">we value your privacy</div>')],
  '/age': [200, html('example', '<div class="age-gate-modal" style="width:400px;height:200px">are you 18?</div>')],
  // A consent element that is present but NOT rendered must not stop the page.
  '/consent-hidden': [200, html('example', '<div id="onetrust-consent-sdk" style="display:none"></div><p>fine</p>')],
};

export const TRACE_IP = '203.0.113.77';

export const traceBody = ({ loc = 'CA', colo = 'YYZ', warp = 'off' } = {}) =>
  ['fl=1f2', 'h=www.cloudflare.com', `ip=${TRACE_IP}`, `ts=${Date.now() / 1000}`, 'visit_scheme=https',
    'uag=Mozilla/5.0', `colo=${colo}`, 'sliver=none', 'http=http/2', `loc=${loc}`, 'tls=TLSv1.3',
    'sni=plaintext', `warp=${warp}`, 'gateway=off', 'rbi=off', 'kex=X25519', ''].join('\n');

export async function startFixtureServer() {
  let trace = traceBody();
  const hits = new Map();
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === '/cdn-cgi/trace') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(trace);
      return;
    }
    if (path === '/redirect-login') {
      res.writeHead(302, { location: '/login?next=%2Fprivate' });
      res.end();
      return;
    }
    if (path === '/cf-mitigated') {
      // What a Cloudflare managed challenge answers with: the header is the signal.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        server: 'cloudflare',
        'cf-ray': '8a1b2c3d4e5f6a7b-YYZ',
        'cf-mitigated': 'challenge',
        'set-cookie': 'fixture_session=not-a-real-secret; Path=/',
      });
      res.end(html('example', '<p>one moment</p>'));
      return;
    }
    const route = ROUTES[path];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(html('Not Found'));
      return;
    }
    res.writeHead(route[0], { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(route[1]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    // How often a path was requested: the proof that a refused run navigated nothing.
    hits: (path) => hits.get(path) ?? 0,
    setTrace: (body) => {
      trace = body;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// Standalone: `node server.mjs` prints the base URL and serves until killed.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { base } = await startFixtureServer();
  process.stdout.write(`${base}\n`);
}
