// Void Royale server: hosts index.html, accounts + gifts API, global announcements, matchmaking (bots fill empty slots)
// Run: npm install && OWNER_KEY=yourSecret node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const OWNER_KEY = process.env.OWNER_KEY || 'robloxisfun55';
if (!process.env.OWNER_KEY) console.warn('[warn] OWNER_KEY is not set, using the old default. Set OWNER_KEY in your host settings.');
const MATCH_SIZE = +process.env.MATCH_SIZE || 6;   // players per match (humans + bots)
const FILL_MS = +process.env.FILL_MS || 15000;     // wait this long for real players, then fill with bots
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');

let db = { secret: crypto.randomBytes(24).toString('hex'), acc: {}, gifts: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let st = 0;
const save = () => { clearTimeout(st); st = setTimeout(() => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('save failed', e.message); } }, 300); };
save();

const tok = n => crypto.createHmac('sha256', db.secret).update(n).digest('hex');
const hp = (h, salt) => crypto.scryptSync(String(h), salt, 32).toString('hex');
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const send = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(JSON.stringify(o)); };
const readBody = req => new Promise(r => { let s = ''; req.on('data', c => { s += c; if (s.length > 20000) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch (e) { r({}); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

function api(url, b, res) {
  const nm = String(b.name || '').trim().toLowerCase();
  if (url === '/api/owner') return send(res, 200, eq(b.p || '', OWNER_KEY) ? { ok: 1 } : { ok: 0 });

  if (url === '/api/auth') {
    if (nm.length < 3 || nm.length > 24 || nm === 'voidqtm' || nm === 'guest') return send(res, 200, { err: 'Invalid name.' });
    const h = String(b.h || ''); if (h.length < 4) return send(res, 200, { err: 'Invalid password.' });
    const a = db.acc[nm];
    const make = () => { const salt = crypto.randomBytes(12).toString('hex'); db.acc[nm] = { salt, h: hp(h, salt) }; save(); return send(res, 200, { ok: 1, token: tok(nm) }); };
    if (b.mode === 'create') return a ? send(res, 200, { err: 'That name is taken.' }) : make();
    if (!a) return b.mode === 'adopt' ? make() : send(res, 200, { err: 'No account with that name. Tap Create account.' });
    if (!eq(hp(h, a.salt), a.h)) return send(res, 200, { err: b.mode === 'adopt' ? 'That name belongs to another account online.' : 'Wrong password.' });
    return send(res, 200, { ok: 1, token: tok(nm) });
  }

  if (url === '/api/inbox') {
    if (!db.acc[nm] || !eq(b.token || '', tok(nm))) return send(res, 200, { gifts: [] });
    const g = db.gifts[nm] || [];
    if (g.length) { delete db.gifts[nm]; save(); }
    return send(res, 200, { gifts: g });
  }

  if (url === '/api/gift') {
    if (!eq(b.key || '', OWNER_KEY)) return send(res, 200, { err: 'Wrong owner key.' });
    const to = String(b.to || '').trim().toLowerCase();
    if (!db.acc[to]) return send(res, 200, { err: 'No account named "' + to + '" on the server yet. They need to open the live site and sign in once.' });
    const g = b.gift || {}; let gift;
    if (g.t === 'gems') { const v = Math.floor(+g.v); if (!(v >= 1 && v <= 1e9)) return send(res, 200, { err: 'Bad gem amount.' }); gift = { t: 'gems', v }; }
    else if (g.t === 'skin' && typeof g.v === 'string' && g.v.length < 40) gift = { t: 'skin', v: g.v };
    else return send(res, 200, { err: 'Bad gift.' });
    (db.gifts[to] = db.gifts[to] || []).push(gift); save();
    let online = 0;
    for (const w of wss.clients) if (w.pres && w.name === to && w.readyState === 1) { w.send(JSON.stringify({ t: 'gift' })); online = 1; }
    return send(res, 200, { ok: 1, online });
  }

  if (url === '/api/announce') {
    if (!eq(b.key || '', OWNER_KEY)) return send(res, 200, { err: 'Wrong owner key.' });
    const msg = String(b.msg || '').trim().slice(0, 200); if (!msg) return send(res, 200, { err: 'Empty message.' });
    let n = 0;
    for (const w of wss.clients) if (w.pres && w.readyState === 1) { w.send(JSON.stringify({ t: 'ann', msg })); n++; }
    return send(res, 200, { ok: 1, n });
  }
  send(res, 404, { err: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,GET' }); return res.end(); }
  if (req.url.startsWith('/api/')) {
    if (req.method !== 'POST') return send(res, 405, { err: 'POST only' });
    const b = await readBody(req);
    try { return api(req.url.split('?')[0], b, res); } catch (e) { console.error(e); return send(res, 500, { err: 'Server error' }); }
  }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(__dirname, path.normalize(p));
  if (!f.startsWith(__dirname) || !MIME[path.extname(f)]) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] }); res.end(d); });
});

// ---------------- websockets: presence (announcements/gifts) + matches ----------------
const wss = new WebSocketServer({ server, maxPayload: 8192 });
const queues = { casual: [], ranked: [] };
const tx = (w, o) => { if (w && w.readyState === 1) w.send(JSON.stringify(o)); };
const unq = w => { for (const k in queues) { const i = queues[k].findIndex(e => e.ws === w); if (i >= 0) queues[k].splice(i, 1); } };

function startMatch(list) {
  const k = list.length, nb = MATCH_SIZE - k;
  const players = list.map((e, i) => ({ id: i, name: e.name, skin: e.skin }));
  for (let i = 0; i < nb; i++) players.push({ id: k + i, name: 'Bot ' + (i + 1), skin: 's0', bot: 1 });
  const g = { humans: list.map(e => e.ws), k, nb };
  list.forEach((e, i) => { e.ws.m = g; e.ws.pid = i; tx(e.ws, { t: 'match', you: i, host: 0, humans: k, bots: nb, players }); });
}

setInterval(() => {
  for (const mode in queues) {
    const q = queues[mode];
    q.forEach(e => tx(e.ws, { t: 'queued', n: q.length }));
    while (q.length >= MATCH_SIZE) startMatch(q.splice(0, MATCH_SIZE));
    if (q.length && Date.now() - q[0].t0 >= FILL_MS) startMatch(q.splice(0, MATCH_SIZE));
  }
}, 500);
setInterval(() => wss.clients.forEach(w => { try { w.ping(); } catch (e) {} }), 25000);

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'hello') { ws.pres = 1; ws.name = String(m.name || '').toLowerCase().slice(0, 24); return; }
    if (m.t === 'queue') {
      if (ws.m) return; unq(ws);
      queues[m.mode === 'ranked' ? 'ranked' : 'casual'].push({ ws, name: String(m.name || 'Player').slice(0, 16), skin: String(m.skin || 's0').slice(0, 40), t0: Date.now() });
      return;
    }
    const g = ws.m; if (!g) return; const id = ws.pid;
    if (m.t === 's') { const o = { t: 's', id, x: +m.x || 0, y: +m.y || 0, z: +m.z || 0, yaw: +m.yaw || 0, dead: m.dead ? 1 : 0 }; g.humans.forEach((w, i) => { if (i !== id) tx(w, o); }); return; }
    if (m.t === 'bs') { if (id !== 0 || !Array.isArray(m.b)) return; const o = { t: 'bs', b: m.b.slice(0, 8) }; g.humans.forEach((w, i) => { if (i !== 0) tx(w, o); }); return; }
    if (m.t === 'dmg') {
      const to = m.to | 0, n = Math.max(1, Math.min(100, +m.n || 0));
      if (to < g.k) { if (to !== id) tx(g.humans[to], { t: 'dmg', n, from: id }); }
      else if (to < g.k + g.nb) tx(g.humans[0], { t: 'bdmg', id: to, n, from: id });
      return;
    }
    if (m.t === 'win') { g.humans.forEach((w, i) => { if (i !== id) tx(w, { t: 'win', id }); }); }
  });
  ws.on('close', () => {
    unq(ws);
    const g = ws.m; if (!g) return; const id = ws.pid;
    g.humans[id] = null;
    g.humans.forEach(w => tx(w, { t: 'left', id }));
    if (id === 0) for (let i = 0; i < g.nb; i++) g.humans.forEach(w => tx(w, { t: 'left', id: g.k + i })); // host owns the bots
  });
});

server.listen(PORT, () => console.log('Void Royale server on :' + PORT));
