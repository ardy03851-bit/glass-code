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
async function fromPreview(e) {
  if (e.request.referrer && e.request.referrer.startsWith(P)) return true;
  for (const id of [e.clientId, e.resultingClientId]) { if (!id) continue; const c = await self.clients.get(id); if (c && c.url.startsWith(P)) return true; }
  return false;
}
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (u.origin !== location.origin) return;
  if (req.url.startsWith(P)) return e.respondWith(serve(req, u.pathname.slice(PPATH.length)));
  if (/\/sw\.js$/.test(u.pathname)) return;
  if (req.mode === 'navigate' && !(req.referrer && req.referrer.startsWith(P))) return;   // the app itself and unrelated pages load normally
  if (!e.clientId && !req.referrer) return;
  // root-absolute URLs ("/css/a.css") coming from a preview page map to the project root
  e.respondWith((async () => (await fromPreview(e)) ? Response.redirect(P + u.pathname.slice(1) + u.search, 307) : fetch(req))());
});
