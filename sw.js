/* Glass Code preview server: serves project files from the app tab at real URLs under __p/ so previews behave like a normal host. */
const P = self.registration.scope + '__p/';
const PPATH = new URL(P).pathname;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
async function pickClient() {
  const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  const apps = all.filter(c => c.url.startsWith(self.registration.scope) && !c.url.startsWith(P) && !/viewer\.html/.test(c.url));
  return apps.find(c => c.visibilityState === 'visible') || apps[0] || null;
}
async function serve(req, rel) {
  const cl = await pickClient();
  if (!cl) return new Response('Glass Code: keep the app tab open to serve preview files.', {status: 503, headers: {'content-type': 'text/plain'}});
  const ch = new MessageChannel();
  const p = new Promise(r => { ch.port1.onmessage = m => r(m.data); setTimeout(() => r(null), 15000); });
  cl.postMessage({type: 'gc-get', path: rel, range: req.headers.get('range')}, [ch.port2]);
  const d = await p;
  if (!d) return new Response('Timed out reading file from app', {status: 504});
  if (d.status === 404) return new Response('<!DOCTYPE html><meta charset=utf-8><body style="font:16px system-ui;padding:40px;color:#444"><h1>404</h1><p>File not found in project: ' + rel.replace(/[<&]/g, '') + '</p>', {status: 404, headers: {'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store'}});
  const h = {'content-type': d.type, 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'content-length': String(d.buf.byteLength)};
  if (d.status === 206) h['content-range'] = `bytes ${d.start}-${d.end}/${d.total}`;
  return new Response(req.method === 'HEAD' ? null : d.buf, {status: d.status, headers: h});
}
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (u.origin !== location.origin) return;
  if (req.url.startsWith(P)) return e.respondWith(serve(req, u.pathname.slice(PPATH.length) ));
  // root-absolute URLs ("/css/a.css") coming from a preview page map to the project root
  if (req.referrer && req.referrer.startsWith(P) && !/\/(sw\.js)$/.test(u.pathname)) return e.respondWith(Response.redirect(P + u.pathname.slice(1) + u.search, 307));
});
