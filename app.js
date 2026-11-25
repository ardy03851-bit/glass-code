'use strict';
(() => {
const $ = id => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder('utf-8');
const files = new Map();               // path -> {bytes?:Uint8Array, text?:string, ver:number}
let cur = null, sel = null, pagePath = null;
const open = new Set(['']);            // expanded folders
const showMore = new Map();            // folder -> rendered entry limit
const PAGE = 300, MAX_EDIT = 3 * 1024 * 1024;
const TEXT_EXT = new Set('html htm css js mjs cjs ts tsx jsx json md txt svg xml csv yml yaml toml ini env py rb php java c h cpp hpp cs go rs sh bat sql vue svelte map lock gitignore less scss sass webmanifest log'.split(' '));
const MIME = {html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',ico:'image/x-icon',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',mp4:'video/mp4',webm:'video/webm',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',txt:'text/plain',xml:'application/xml',wasm:'application/wasm',pdf:'application/pdf',csv:'text/csv',md:'text/markdown'};
const extOf = p => { const m = /\.([^./]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };
const base = p => p.slice(p.lastIndexOf('/') + 1);
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const fmt = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const tick = () => new Promise(r => setTimeout(r, 0));

/* ---------- storage (IndexedDB) ---------- */
let db = null;
const dbOpen = () => new Promise(res => {
  try { const r = indexedDB.open('glasscode', 1); r.onupgradeneeded = () => r.result.createObjectStore('files', {keyPath: 'path'}); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); }
});
const tx = (mode, fn) => new Promise(res => { if (!db) return res(); try { const t = db.transaction('files', mode); const s = t.objectStore('files'); const out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = t.onabort = () => res(); } catch { res(); } });
const dirty = new Set(), removed = new Set(); let saveT = 0;
const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(flush, 700); };
async function flush() {
  const ps = [...dirty], rm = [...removed]; dirty.clear(); removed.clear();
  for (let i = 0; i < ps.length; i += 200) await tx('readwrite', s => { for (const p of ps.slice(i, i + 200)) { const f = files.get(p); if (f) s.put({path: p, data: f.text !== undefined ? f.text : f.bytes}); } });
  if (rm.length) await tx('readwrite', s => rm.forEach(p => s.delete(p)));
}
async function loadAll() { const all = await tx('readonly', s => s.getAll()); return all || []; }

/* ---------- file model ---------- */
const getBytes = p => { const f = files.get(p); return f.bytes || (f.bytes = enc.encode(f.text)); };
const sizeOf = p => { const f = files.get(p); return f.bytes ? f.bytes.length : f.text.length; };
function isText(p) {
  const f = files.get(p); if (!f) return false;
  if (f.text !== undefined) return true;
  const e = extOf(p);
  if (TEXT_EXT.has(e)) return true;
  if (MIME[e] && !/^(text|application\/(json|xml))/.test(MIME[e])) return false;
  const b = f.bytes.subarray(0, 2000); for (const c of b) if (c === 0) return false; return !MIME[e] || true;
}
function getText(p) { const f = files.get(p); if (f.text === undefined) { f.text = dec.decode(f.bytes); } return f.text; }
function setFile(p, data) {
  const old = files.get(p), f = {ver: (old ? old.ver : 0) + 1};
  if (typeof data === 'string') f.text = data; else f.bytes = data;
  files.set(p, f); dirty.add(p); removed.delete(p);
}
function removePath(p) {
  const hit = [...files.keys()].filter(k => k === p || k.startsWith(p + '/'));
  hit.forEach(k => { files.delete(k); dirty.delete(k); removed.add(k); });
  if (cur && !files.has(cur)) openFile(null);
  if (sel && sel !== '' && !files.has(sel) && !hit.length) sel = null;
  saveSoon();
}

/* ---------- UI helpers ---------- */
let toastT = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }
function progress(txt, frac) { $('progress').hidden = txt == null; if (txt != null) { $('pText').textContent = txt; $('pFill').style.width = Math.round((frac || 0) * 100) + '%'; } }
const mainEl = $('main');
function pane(n) { mainEl.dataset.pane = n; document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.pane === n)); }
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { pane(b.dataset.pane); if (b.dataset.pane === 'preview') schedulePreview(0); });
const narrow = () => matchMedia('(max-width:1100px)').matches;

/* ---------- tree ---------- */
function buildTree() {
  const root = {d: new Map(), f: []};
  for (const p of [...files.keys()].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}))) {
    const parts = p.split('/'); let n = root;
    for (let i = 0; i < parts.length - 1; i++) { let c = n.d.get(parts[i]); if (!c) n.d.set(parts[i], c = {d: new Map(), f: [], path: parts.slice(0, i + 1).join('/')}); n = c; }
    n.f.push(p);
  }
  return root;
}
let renderQ = 0;
function renderTree() { cancelAnimationFrame(renderQ); renderQ = requestAnimationFrame(drawTree); }
function drawTree() {
  const tree = $('tree'), frag = document.createDocumentFragment(), root = buildTree();
  const mk = (cls, depth, label, icon, path, isDir) => {
    const r = document.createElement('div'); r.className = 'row' + (cls ? ' ' + cls : ''); r.style.paddingLeft = 8 + depth * 16 + 'px'; r.setAttribute('role', 'treeitem');
    r.innerHTML = '<span class="ic"></span><span class="nm"></span>'; r.firstChild.textContent = icon; r.children[1].textContent = label;
    if (path != null) {
      r.dataset.path = path; if (sel === path || (!isDir && cur === path && sel == null)) r.classList.add('sel');
      const ed = document.createElement('button'); ed.className = 'x'; ed.textContent = '✎'; ed.setAttribute('aria-label','Rename'); ed.onclick = e => { e.stopPropagation(); renamePath(path); };
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕'; x.setAttribute('aria-label','Delete'); x.onclick = e => { e.stopPropagation(); if (confirm('Delete ' + path + '?')) { removePath(path); renderTree(); schedulePreview(); } };
      if (r.classList.contains('sel')) r.append(ed, x);
      r.onclick = () => { sel = path; if (isDir) { open.has(path) ? open.delete(path) : open.add(path); drawTree(); } else { openFile(path); if (narrow()) pane('editor'); } };
    }
    return r;
  };
  const walk = (n, depth, key) => {
    const dirs = [...n.d.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, {numeric: true}));
    const entries = [...dirs.map(([name, c]) => ({dir: true, name, c})), ...n.f.map(p => ({dir: false, p}))];
    const lim = showMore.get(key) || PAGE;
    for (const e of entries.slice(0, lim)) {
      if (e.dir) { const o = open.has(e.c.path); frag.append(mk('dir', depth, e.name, o ? '▾' : '▸', e.c.path, true)); if (o) walk(e.c, depth + 1, e.c.path); }
      else frag.append(mk('', depth, base(e.p), '·', e.p, false));
    }
    if (entries.length > lim) { const m = mk('more', depth, `Show ${Math.min(PAGE, entries.length - lim)} more (${entries.length - lim} hidden)`, '…', null); m.onclick = () => { showMore.set(key, lim + PAGE); drawTree(); }; frag.append(m); }
  };
  walk(root, 0, '');
  tree.replaceChildren(frag);
  let total = 0; files.forEach((f, p) => total += f.bytes ? f.bytes.length : f.text.length);
  $('stats').textContent = `${files.size.toLocaleString()} files · ${fmt(total)}`;
}
function revealPath(p) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/')); }
function renamePath(p) {
  const n = prompt('New path for ' + p, p); if (!n || n === p) return;
  const np = n.replace(/^\/+|\/+$/g, ''); if (!np) return;
  const hit = [...files.keys()].filter(k => k === p || k.startsWith(p + '/'));
  for (const k of hit) { const f = files.get(k), nk = np + k.slice(p.length); files.delete(k); removed.add(k); files.set(nk, {...f, ver: f.ver + 1}); dirty.add(nk); if (cur === k) cur = nk; }
  if (sel === p) sel = np; saveSoon(); renderTree(); openFile(cur); schedulePreview(0);
}

/* ---------- editor ---------- */
const code = $('code'), gutter = $('gutter');
function updateGutter() {
  const v = code.value; let n = 1; for (let i = v.indexOf('\n'); i !== -1; i = v.indexOf('\n', i + 1)) n++;
  if (n > 30000) { gutter.hidden = true; return; } gutter.hidden = false;
  if (gutter._n === n) return; gutter._n = n;
  let s = ''; for (let i = 1; i <= n; i++) s += i + '\n'; gutter.textContent = s;
}
function openFile(p) {
  cur = p; if (p) { sel = p; revealPath(p); if (/\.html?$/i.test(p)) pagePath = p; }
  $('curName').textContent = p || 'No file';
  const nt = $('nonText'); nt.hidden = true; code.disabled = !p; code.value = ''; gutter._n = 0;
  if (p) {
    if (!isText(p)) { nt.hidden = false; nt.textContent = `${base(p)} · ${fmt(sizeOf(p))} · binary file (kept in project, included in exports and preview)`; code.disabled = true; }
    else if (sizeOf(p) > MAX_EDIT) { nt.hidden = false; nt.textContent = `${base(p)} · ${fmt(sizeOf(p))} · too large to edit here (kept in project, included in exports and preview)`; code.disabled = true; }
    else code.value = getText(p);
  }
  updateGutter(); renderTree(); if (p) schedulePreview();
}
code.addEventListener('input', () => {
  if (!cur || code.disabled) return;
  const f = files.get(cur); f.text = code.value; f.bytes = undefined; f.ver++; dirty.add(cur); saveSoon(); updateGutter();
  if ($('live').checked) schedulePreview(Math.min(900, 250 + code.value.length / 400));
});
code.addEventListener('scroll', () => { gutter.scrollTop = code.scrollTop; }, {passive: true});
code.addEventListener('keydown', e => {
  if (e.key === 'Tab') { e.preventDefault(); ins('  '); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
});
function ins(t) {
  code.focus(); const before = code.value;
  if (t === '' ? !(document.execCommand && document.execCommand('delete')) || code.value === before : !(document.execCommand && document.execCommand('insertText', false, t)) || code.value === before) { code.setRangeText(t, code.selectionStart, code.selectionEnd, 'end'); code.dispatchEvent(new Event('input')); }
}
const selText = () => code.value.slice(code.selectionStart, code.selectionEnd);
async function writeClip(t) { try { await navigator.clipboard.writeText(t); return true; } catch { try { const a = document.createElement('textarea'); a.value = t; document.body.append(a); a.select(); const ok = document.execCommand('copy'); a.remove(); return ok; } catch { return false; } } }
async function readClip() { try { return await navigator.clipboard.readText(); } catch { const t = prompt('Paste your code here (clipboard access was blocked):'); return t; } }
const needFile = () => { if (!cur || code.disabled) { toast('Open a text file first'); return false; } return true; };
$('btnSelAll').onclick = () => { if (!needFile()) return; code.focus(); code.select(); code.setSelectionRange(0, code.value.length); };
$('btnCopy').onclick = async () => { if (!needFile()) return; const t = selText() || code.value; toast(await writeClip(t) ? (selText() ? 'Copied selection' : 'Copied whole file') : 'Copy failed'); };
$('btnCut').onclick = async () => { if (!needFile()) return; const t = selText(); if (!t) return toast('Select something to cut'); if (await writeClip(t)) { ins(''); toast('Cut'); } else toast('Cut failed'); };
$('btnPaste').onclick = async () => { if (!needFile()) return; const t = await readClip(); if (t) ins(t); };
$('btnReplaceClip').onclick = async () => { if (!needFile()) return; const t = await readClip(); if (t == null || t === '') return toast('Clipboard is empty'); code.focus(); code.setRangeText(t, 0, code.value.length, 'end'); code.dispatchEvent(new Event('input')); toast('File replaced with copied code'); };
$('btnFind').onclick = () => { const b = $('findbar'); b.hidden = !b.hidden; if (!b.hidden) { const s = selText(); if (s && !s.includes('\n')) $('findIn').value = s; $('findIn').focus(); countFind(); } };
$('btnFindClose').onclick = () => $('findbar').hidden = true;
function countFind() { const q = $('findIn').value; $('findCount').textContent = q && cur && !code.disabled ? code.value.split(q).length - 1 + ' found' : ''; }
$('findIn').oninput = countFind;
$('btnReplAll').onclick = () => {
  if (!needFile()) return; const q = $('findIn').value; if (!q) return;
  const n = code.value.split(q).length - 1; if (!n) return toast('Nothing found');
  const v = code.value.split(q).join($('replIn').value); code.setRangeText(v, 0, code.value.length, 'end'); code.dispatchEvent(new Event('input')); toast(`Replaced ${n}`); countFind();
};

/* ---------- create / upload ---------- */
const SKEL = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Page</title>\n</head>\n<body>\n\n</body>\n</html>\n';
$('btnNewFile').onclick = () => {
  const dir = sel && files.has(sel) ? dirOf(sel) : (sel || ''); const n = prompt('New file path', (dir ? dir + '/' : '') + 'untitled.html'); if (!n) return;
  const p = n.replace(/^\/+/, ''); if (!p || p.endsWith('/')) return; if (files.has(p)) return toast('File exists');
  setFile(p, /\.html?$/i.test(p) ? SKEL : ''); saveSoon(); openFile(p); if (narrow()) pane('editor');
};
$('btnNewFolder').onclick = () => {
  const n = prompt('New folder name'); if (!n) return; const d = n.replace(/^\/+|\/+$/g, ''); if (!d) return;
  const dir = sel && files.has(sel) ? dirOf(sel) : (sel || ''); const full = dir ? dir + '/' + d : d;
  setFile(full + '/.gitkeep', ''); saveSoon(); revealPath(full + '/x'); open.add(full); sel = full; renderTree();
};
$('btnAddFiles').onclick = () => $('fileIn').click();
$('fileIn').onchange = async e => { await addFiles([...e.target.files]); e.target.value = ''; };
$('btnImport').onclick = () => $('zipIn').click();
$('zipIn').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await importZip(f); };
async function addFiles(list) {
  let n = 0;
  for (const f of list) {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip') { await importZip(f); continue; }
    const p = (f.webkitRelativePath || f.name); setFile(p, new Uint8Array(await f.arrayBuffer())); n++;
  }
  if (n) { saveSoon(); renderTree(); toast(`Added ${n} file${n > 1 ? 's' : ''}`); schedulePreview(0); }
}
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });

/* ---------- zip import (batched, multi-threaded, memory-aware) ---------- */
const unzipP = (data, opts) => new Promise((res, rej) => fflate.unzip(data, opts, (e, d) => e ? rej(e) : res(d)));
const skipEntry = n => n.endsWith('/') || /(^|\/)__MACOSX\//.test(n) || /(^|\/)(\.DS_Store|Thumbs\.db)$/.test(n);
let importing = false;
async function importZip(file) {
  if (importing) return toast('An import is already running'); importing = true;
  try {
    progress('Reading ' + file.name + '…', 0);
    const data = new Uint8Array(await file.arrayBuffer());
    const list = [];
    await unzipP(data, {filter: i => { if (!skipEntry(i.name)) list.push({n: i.name, s: i.originalSize}); return false; }});
    if (!list.length) { toast('Zip contains no files'); return; }
    const first = new Set(list.map(i => i.n.split('/')[0])); const strip = first.size === 1 && list.every(i => i.n.includes('/')) ? [...first][0] + '/' : '';
    const BATCH = 48 * 1024 * 1024, MAXN = 400; let i = 0, done = 0, bytes = 0, total = list.reduce((a, b) => a + b.s, 0) || 1;
    while (i < list.length) {
      const names = new Set(); let sz = 0;
      while (i < list.length && (names.size === 0 || (sz + list[i].s <= BATCH && names.size < MAXN))) { names.add(list[i].n); sz += list[i].s; i++; }
      const out = await unzipP(data, {filter: inf => names.has(inf.name)});
      for (const n in out) { const p = strip && n.startsWith(strip) ? n.slice(strip.length) : n; if (p) setFile(p, out[n]); bytes += out[n].length; done++; }
      progress(`Unpacking ${done.toLocaleString()} / ${list.length.toLocaleString()} files (${fmt(bytes)})`, bytes / total);
      await flush(); await tick();
    }
    progress('Building file tree…', 1); await tick();
    const entry = ['index.html', 'index.htm'].find(p => files.has(p)) || [...files.keys()].find(p => /\.html?$/i.test(p));
    if (entry) pagePath = entry;
    openFile(entry || [...files.keys()][0] || null); renderTree();
    toast(`Imported ${done.toLocaleString()} files (${fmt(bytes)})`);
  } catch (e) { console.error(e); toast('Could not read zip: ' + (e.message || e)); }
  finally { importing = false; progress(null); }
}

/* ---------- export ---------- */
function download(blob, name) {
  const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.append(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(u); }, 20000);
}
const NOCOMP = new Set('png jpg jpeg gif webp avif mp3 mp4 webm ogg woff woff2 zip gz 7z rar pdf wasm'.split(' '));
const zipP = obj => new Promise((res, rej) => fflate.zip(obj, {level: 6}, (e, d) => e ? rej(e) : res(d)));
async function exportZip(prefix, name) {
  const obj = {}; let n = 0;
  for (const p of files.keys()) { if (prefix && !p.startsWith(prefix + '/')) continue; obj[prefix ? p.slice(prefix.length + 1) : p] = [getBytes(p), {level: NOCOMP.has(extOf(p)) ? 0 : 6}]; n++; }
  if (!n) return toast('Nothing to export');
  progress(`Compressing ${n.toLocaleString()} files…`, .5); await tick();
  try { const z = await zipP(obj); download(new Blob([z], {type: 'application/zip'}), name); toast('Exported ' + name); }
  catch (e) { toast('Export failed: ' + e.message); } finally { progress(null); }
}
$('btnExportAll').onclick = () => exportZip('', 'project.zip');
$('btnExportFile').onclick = () => {
  const p = sel || cur; if (!p) return toast('Select a file first');
  if (files.has(p)) { download(new Blob([getBytes(p)], {type: MIME[extOf(p)] || 'application/octet-stream'}), base(p)); toast('Exported ' + base(p)); }
  else exportZip(p, base(p) + '.zip');
};

/* ---------- preview builder ---------- */
const urlCache = new Map();   // path@ver -> blob url (unprocessed files)
let buildUrls = [];
function resolveRef(ref, from) {
  ref = (ref || '').trim(); if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
  const m = /^([^?#]*)([?#].*)?$/.exec(ref); let p = m[1]; try { p = decodeURIComponent(p); } catch {}
  const parts = p.startsWith('/') ? [] : dirOf(from).split('/').filter(Boolean);
  for (const s of p.split('/')) { if (s === '' || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); }
  const path = parts.join('/'); return files.has(path) ? {path, suf: m[2] || ''} : null;
}
const blobUrl = (data, type) => URL.createObjectURL(new Blob([data], {type}));
function Builder(persist) {
  const memo = new Map(), made = [];
  const mk = (data, type) => { const u = blobUrl(data, type); made.push(u); return u; };
  const css = (t, from, stack) => t.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/g, (m, q, u, q2, u2) => {
    const r = resolveRef(u || u2, from); if (!r) return m; const nu = urlFor(r.path, stack) + r.suf; return u ? `url("${nu}")` : `@import "${nu}"`;
  });
  const js = (t, from, stack) => t.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\2/g, (m, a, q, u) => {
    const r = resolveRef(u, from); if (!r || stack.includes(r.path)) return m; return a + q + urlFor(r.path, stack) + r.suf + q;
  });
  function urlFor(path, stack = []) {
    if (memo.has(path)) return memo.get(path);
    const e = extOf(path), f = files.get(path); let u;
    const st = stack.concat(path);
    if (e === 'css') u = mk(css(getText(path), path, st), 'text/css');
    else if (e === 'js' || e === 'mjs') u = mk(js(getText(path), path, st), 'text/javascript');
    else if (e === 'html' || e === 'htm') { if (stack.includes(path)) return ''; u = mk(page(path, st), 'text/html;charset=utf-8'); }
    else {
      const k = path + '@' + f.ver; u = urlCache.get(k);
      if (!u) { u = blobUrl(getBytes(path), MIME[e] || 'application/octet-stream'); urlCache.set(k, u); if (urlCache.size > 4000) { const o = urlCache.keys().next().value; URL.revokeObjectURL(urlCache.get(o)); urlCache.delete(o); } }
    }
    memo.set(path, u); return u;
  }
  function shimMap() {
    const map = {}; if (files.size > 1500) return map;
    for (const p of files.keys()) { const e = extOf(p); if (e === 'html' || e === 'htm' || e === 'css' || e === 'js' || e === 'mjs' || sizeOf(p) > 8e6) continue; map[p] = urlFor(p); }
    return map;
  }
  const SHIM = "(function(){var M=__MAP__,B=__BASE__;function r(u){try{if(typeof u!=='string')return u;if(/^([a-z][a-z0-9+.-]*:|\\/\\/|#)/i.test(u))return u;var p=u.split(/[?#]/)[0];var a=p[0]==='/'?[]:B.split('/').filter(Boolean);p.split('/').forEach(function(s){if(s===''||s==='.')return;if(s==='..')a.pop();else a.push(s)});return M[a.join('/')]||u}catch(e){return u}}var F=window.fetch;if(F)window.fetch=function(u,o){return F.call(this,(u&&u.url)?u:r(u),o)};var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=r(u);return X.apply(this,arguments)};document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(!h||h[0]==='#'||/^([a-z][a-z0-9+.-]*:|\\/\\/)/i.test(h)||a.target==='_blank')return;e.preventDefault();var t=window.parent!==window?window.parent:window.opener;if(t)t.postMessage({gcNav:h,base:B},'*')},true)})();";
  function page(path, stack) {
    const doc = new DOMParser().parseFromString(getText(path), 'text/html');
    for (const el of doc.querySelectorAll('[src],[href],[poster],[data]')) {
      if (el.tagName === 'A' || el.tagName === 'AREA') continue;
      for (const a of ['src', 'href', 'poster', 'data']) { if (!el.hasAttribute(a)) continue; const r = resolveRef(el.getAttribute(a), path); if (r) { const u = urlFor(r.path, stack); if (u) el.setAttribute(a, u + r.suf); } }
    }
    for (const el of doc.querySelectorAll('[srcset]')) el.setAttribute('srcset', el.getAttribute('srcset').split(',').map(s => { const [u, ...d] = s.trim().split(/\s+/); const r = resolveRef(u, path); return r ? [urlFor(r.path, stack) + r.suf, ...d].join(' ') : s.trim(); }).join(', '));
    for (const el of doc.querySelectorAll('style')) el.textContent = css(el.textContent, path, stack);
    for (const el of doc.querySelectorAll('[style*="url("]')) el.setAttribute('style', css(el.getAttribute('style'), path, stack));
    for (const el of doc.querySelectorAll('script:not([src])')) if (el.type === 'module') el.textContent = js(el.textContent, path, stack);
    const s = doc.createElement('script'); s.textContent = SHIM.replace('__MAP__', JSON.stringify(shimMap()).replace(/</g, '\\u003c')).replace('__BASE__', JSON.stringify(dirOf(path)));
    doc.head.insertBefore(s, doc.head.firstChild);
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }
  return {build(path) { const u = mk(page(path, [path]), 'text/html;charset=utf-8'); if (persist) made.splice(made.indexOf(u), 1); else buildUrls.push(...made); if (persist) { /* keep alive */ } return u; }};
}
function msgPage(t) { return blobUrl(`<!DOCTYPE html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:16px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#555;background:#f2f2f4;text-align:center;padding:20px">${t}`, 'text/html;charset=utf-8'); }
function pickPage() {
  if (cur && /\.html?$/i.test(cur) && files.has(cur)) return cur;
  if (pagePath && files.has(pagePath)) return pagePath;
  return ['index.html', 'index.htm'].find(p => files.has(p)) || [...files.keys()].find(p => /\.html?$/i.test(p)) || null;
}
function buildFor(persist) {
  const p = pickPage();
  if (!p) return {path: null, url: msgPage('No HTML file in this project yet.<br>Add an index.html to see a preview.')};
  pagePath = p;
  try { return {path: p, url: new Builder(persist).build(p)}; }
  catch (e) { console.error(e); return {path: p, url: msgPage('Preview error: ' + String(e.message).replace(/</g, '&lt;'))}; }
}

/* ---------- live preview with double-buffered frames ---------- */
const frames = $('frames'); let pvT = 0, pvSeq = 0, lastPV = 0, active = null;
function schedulePreview(ms = 300) { clearTimeout(pvT); pvT = setTimeout(renderPreview, ms); }
function renderPreview() {
  if (document.hidden) return;
  if (narrow() && mainEl.dataset.pane !== 'preview') { pvDirty = true; return; }
  pvDirty = false;
  const stale = buildUrls; buildUrls = [];
  const {path, url} = buildFor(false); $('pvName').textContent = path ? '· ' + path : '';
  const seq = ++pvSeq, next = document.createElement('iframe');
  next.className = 'hide'; next.setAttribute('allow', 'fullscreen; autoplay; camera; microphone; clipboard-write; accelerometer; gyroscope; geolocation');
  next.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads');
  const finish = () => { if (seq !== pvSeq) { next.remove(); return; } next.classList.remove('hide'); if (active && active !== next) active.remove(); active = next; stale.forEach(u => URL.revokeObjectURL(u)); lastPV = performance.now(); };
  next.onload = finish; next.src = url; frames.append(next);
  setTimeout(() => { if (next.classList.contains('hide') && seq === pvSeq) finish(); }, 4000);
}
let pvDirty = false;
new MutationObserver(() => { if (pvDirty && mainEl.dataset.pane === 'preview') renderPreview(); }).observe(mainEl, {attributes: true, attributeFilter: ['data-pane']});
matchMedia('(max-width:1100px)').addEventListener('change', () => schedulePreview(0));
document.addEventListener('visibilitychange', () => { if (!document.hidden && pvDirty) renderPreview(); });
function run() { if (narrow()) pane('preview'); renderPreview(); }
$('btnRun').onclick = run; $('btnReload').onclick = run;
window.addEventListener('message', e => {
  const d = e.data; if (!d || typeof d.gcNav !== 'string') return;
  const r = resolveRef(d.gcNav, (d.base ? d.base + '/' : '') + '_'); if (!r || !/\.html?$/i.test(r.path)) return toast('Link target not found in project: ' + d.gcNav);
  const url = new Builder(true).build(r.path);
  try { if (active && e.source === active.contentWindow) { pagePath = r.path; $('pvName').textContent = '· ' + r.path; } e.source.location.replace(url + r.suf); } catch (x) { console.warn(x); }
});

/* ---------- open preview popup ---------- */
const menu = $('menu');
$('btnPopup').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.hidden = true; });
$('mTab').onclick = () => { menu.hidden = true; const {url} = buildFor(true); const w = window.open(url, '_blank'); if (!w) toast('Pop-up blocked. Allow pop-ups for this site.'); };
const fs = $('fs');
function closeFs() { fs.hidden = true; $('fsFrame').replaceChildren(); if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
$('mFull').onclick = () => {
  menu.hidden = true; const {url} = buildFor(true); const f = document.createElement('iframe');
  f.setAttribute('allow', 'fullscreen; autoplay; camera; microphone; clipboard-write; accelerometer; gyroscope');
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads'); f.src = url;
  $('fsFrame').replaceChildren(f); fs.hidden = false;
  const rq = fs.requestFullscreen || fs.webkitRequestFullscreen; if (rq) { try { const pr = rq.call(fs); if (pr && pr.catch) pr.catch(() => {}); } catch {} }
};
$('fsClose').onclick = closeFs;
['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => document.addEventListener(ev, () => { if (!document.fullscreenElement && !document.webkitFullscreenElement && !fs.hidden) closeFs(); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !fs.hidden) closeFs(); });
window.addEventListener('beforeunload', flush);

/* ---------- boot ---------- */
const STARTER = {
  'index.html': '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Hello</title>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello, Glass Code</h1>\n  <p>Edit me and the preview updates live.</p>\n  <button id="b">Clicked 0 times</button>\n  <script src="script.js"></script>\n</body>\n</html>\n',
  'style.css': 'body{font-family:-apple-system,system-ui,sans-serif;display:grid;place-content:center;min-height:100vh;margin:0;background:linear-gradient(135deg,#e9ebf0,#b9bdc7);color:#222;text-align:center}\nbutton{font-size:18px;padding:12px 22px;border-radius:12px;border:0;background:#2b2d31;color:#fff}\n',
  'script.js': 'let n = 0;\nconst b = document.getElementById("b");\nb.onclick = () => { b.textContent = "Clicked " + (++n) + " times"; };\n'
};
(async () => {
  db = await dbOpen();
  const saved = await loadAll();
  if (saved.length) saved.forEach(r => files.set(r.path, typeof r.data === 'string' ? {text: r.data, ver: 1} : {bytes: r.data, ver: 1}));
  else { for (const k in STARTER) setFile(k, STARTER[k]); await flush(); }
  const entry = files.has('index.html') ? 'index.html' : [...files.keys()][0] || null;
  openFile(entry); renderTree(); schedulePreview(0);
  window.__gc = {files, importZip, exportZip, run, getText, get cur() { return cur; }, ready: true};
})();
})();
