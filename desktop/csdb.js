// CSDb proxy for the drive page (search, release details, file download), same answers as the retrofixer.it
// endpoint. In the app there are no browser CORS limits, but the page expects this API, so it lives here.
'use strict';
const { net } = require('electron');

const UA = 'RFIEC-desktop (+https://github.com/zeus074/RFIEC)';
const MAX_FILE = 4 * 1024 * 1024;
const cache = new Map();
const rate = new Map();

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}
async function get(pathq, limit = MAX_FILE) {
  const r = await net.fetch('https://csdb.dk' + pathq, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: '*/*' } });
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > limit) throw new Error('file too large');
  return { status: r.status, headers: r.headers, body };
}
function sameHostPath(loc) {
  const u = new URL(loc, 'https://csdb.dk/');
  if (u.protocol !== 'https:' || !['csdb.dk', 'www.csdb.dk'].includes(u.hostname)) return null;
  return u.pathname + u.search;
}
async function cached(key, ttl, fn) {
  const now = Date.now(), c = cache.get(key);
  if (c && c.until > now) return c.value;
  const value = await fn();
  cache.set(key, { until: now + ttl * 1000, value });
  return value;
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function unescape(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m));
}
function strip(s) { return unescape(String(s || '').replace(/<[^>]+>/g, '')).trim(); }

const LI = /<li>(?:<a href="\/release\/download\.php\?id=\d+">.*?<\/a>)?<a href="\/release\/\?id=(\d+)">(.*?)<\/a>\s*(?:\(([^)<]*)\))?\s*(?:by\s*(.*?))?<font color="#32E814">\(([^)<]*)\)<\/font>/gs;

async function search(q) {
  q = q.trim().slice(0, 80);
  const r = await get('/search/?' + new URLSearchParams({ seinsel: 'releases', search: q, all: '1' }), 2 * 1024 * 1024);
  if ([301, 302, 303].includes(r.status)) {
    const m = /\/release\/\?id=(\d+)/.exec(r.headers.get('location') || '');
    if (m) return { release: +m[1] };
  }
  const html = r.body.toString('utf8'), out = [];
  for (const m of html.matchAll(LI)) {
    out.push({ id: +m[1], name: strip(m[2]), type: strip(m[3]), group: strip(m[4]), date: strip(m[5]) });
    if (out.length >= 60) break;
  }
  return { results: out };
}

// tiny XML helpers for the CSDb webservice (flat enough for regular expressions)
function tag(xml, name) { const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml); return m ? unescape(m[1]).trim() : ''; }
function all(xml, name) { return [...xml.matchAll(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'g'))].map(m => m[1]); }

async function release(id) {
  const r = await get('/webservice/?' + new URLSearchParams({ type: 'release', id: String(id), depth: '2' }), 2 * 1024 * 1024);
  const xml = r.body.toString('utf8');
  const rel = (/<Release>([\s\S]*)<\/Release>/.exec(xml) || [])[1];
  if (!rel) throw Object.assign(new Error('release not found'), { code: 502 });
  const by = (/<ReleasedBy>([\s\S]*?)<\/ReleasedBy>/.exec(rel) || [])[1] || '';
  const groups = all(by, 'Group').map(g => tag(g, 'Name')).concat(all(by, 'Handle').map(h => tag(h, 'Handle')));
  const links = all(rel, 'DownloadLink').map(d => {
    const url = tag(d, 'Link'), counter = tag(d, 'CounterLink');
    const m = /download\.php\?id=(\d+)/.exec(counter);
    let u; try { u = new URL(url); } catch { u = null; }
    const internal = !!(u && ['csdb.dk', 'www.csdb.dk'].includes(u.hostname) && u.pathname.startsWith('/getinternalfile.php/') && m);
    return { id: m ? +m[1] : 0, file: (u && decodeURIComponent(u.pathname.split('/').pop())) || url, url, internal,
             downloads: +(tag(d, 'Downloads') || 0), status: tag(d, 'Status') };
  });
  let shot = tag(rel, 'ScreenShot');
  if (shot && !shot.startsWith('https://csdb.dk/')) shot = '';
  return { id: +(tag(rel, 'ID') || id), name: tag(rel, 'Name'), type: tag(rel, 'Type'), year: tag(rel, 'ReleaseYear'),
           group: groups.filter(Boolean).slice(0, 3).join(', '), screenshot: shot, links };
}

async function file(id) {
  let p = '/release/download.php?id=' + id;
  for (let i = 0; i < 4; i++) {
    const r = await get(p);
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      p = sameHostPath(r.headers.get('location') || '');
      if (!p) throw Object.assign(new Error('the file is not hosted on csdb.dk'), { code: 403 });
      continue;
    }
    if (r.status !== 200) throw Object.assign(new Error('CSDb answered ' + r.status), { code: 502 });
    let name = (/filename="?([^";]+)/.exec(r.headers.get('content-disposition') || '') || [])[1] || decodeURIComponent(p.split('?')[0].split('/').pop());
    name = name.replace(/[^\w.\- ()+!]/g, '_').slice(0, 120) || 'file.bin';
    return { name, body: r.body };
  }
  throw Object.assign(new Error('too many redirects'), { code: 502 });
}

// same politeness limits as the website: 10 requests and 3 downloads a minute
function limited(isFile) {
  const k = Math.floor(Date.now() / 60000) + (isFile ? 'f' : 'q');
  const n = (rate.get(k) || 0) + 1; rate.set(k, n);
  if (rate.size > 20) for (const key of [...rate.keys()].slice(0, 10)) rate.delete(key);
  return n > (isFile ? 3 : 10);
}

exports.handle = async function (q) {
  const a = q.get('a') || '', id = q.get('id') || '';
  if (limited(a === 'file')) return json(429, { message: 'Too many requests' }, { 'Retry-After': String(60 - Math.floor(Date.now() / 1000) % 60) });
  try {
    if (a === 'search' && (q.get('q') || '').trim()) return json(200, await cached('s:' + q.get('q').trim().toLowerCase(), 3600, () => search(q.get('q'))));
    if (a === 'release' && /^\d+$/.test(id)) return json(200, await cached('r:' + id, 86400, () => release(+id)));
    if (a === 'file' && /^\d+$/.test(id)) {
      const f = await file(+id);
      return new Response(f.body, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': f.name, 'Access-Control-Expose-Headers': 'X-Filename', 'Cache-Control': 'no-store' } });
    }
    return json(400, { message: 'bad request' });
  } catch (e) {
    return json(e.code || 502, { message: e.message || String(e) });
  }
};
