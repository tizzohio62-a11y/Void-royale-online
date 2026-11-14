// VOID ROYALE server: serves index.html + WebSocket (matchmaking, global messages, live gifts)
// Run:  npm install ws   then   ADMIN_KEY=your-secret node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const OWNER = (process.env.OWNER_NAME || 'voidqtm');
const GIFT_FILE = path.join(__dirname, 'gifts.json');
if (!ADMIN_KEY) console.warn('WARNING: ADMIN_KEY is not set - admin actions (global messages, gifts) are disabled.');

// ---- static file ----
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      if (e) { res.writeHead(404); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(d);
    });
  } else { res.writeHead(404); res.end('Not found'); }
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

// ---- gifts (persisted) ----
let gifts = {};
try { gifts = JSON.parse(fs.readFileSync(GIFT_FILE, 'utf8')) || {}; } catch (e) {}
const saveGifts = () => { try { fs.writeFileSync(GIFT_FILE, JSON.stringify(gifts)); } catch (e) {} };
const rid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const send = (ws, o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} };

// ---- hub (every signed-in player) ----
const hubs = new Set();           // sockets that sent 'hello'
function deliverGifts(ws) {
  const q = gifts[ws.uname];
  if (q && q.length) send(ws, { t: 'gift', items: q });
}

// ---- matchmaking ----
const queues = { casual: [], ranked: [] };
const MAX_PLAYERS = 4, GATHER_MS = 4000;
function qBroadcast(mode) { const q = queues[mode]; q.forEach(w => send(w, { t: 'queued', n: q.length })); }
function dequeue(ws) {
  for (const m in queues) { const i = queues[m].indexOf(ws); if (i >= 0) { queues[m].splice(i, 1); qBroadcast(m); } }
}
function tryMatch(mode) {
  const q = queues[mode];
  if (q.length < 2) return;
  const oldest = Date.now() - q[0].qAt;
  if (q.length < MAX_PLAYERS && oldest < GATHER_MS) return;
  const group = q.splice(0, MAX_PLAYERS);
  const match = { players: group };
  const players = group.map((w, i) => { w.mid = i; w.match = match; return { id: i, name: w.pname, skin: w.pskin }; });
  group.forEach(w => send(w, { t: 'match', you: w.mid, players }));
  qBroadcast(mode);
}
setInterval(() => { tryMatch('casual'); tryMatch('ranked'); }, 1000);

function leaveMatch(ws) {
  const m = ws.match; if (!m) return;
  ws.match = null;
  m.players = m.players.filter(w => w !== ws);
  m.players.forEach(w => send(w, { t: 'left', id: ws.mid }));
  if (m.players.length < 2) m.players.forEach(w => { w.match = null; });
}
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const num = v => { v = +v; return isFinite(v) ? v : 0; };

wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => ws.isAlive = true);
  ws.msgs = 0;
  const rl = setInterval(() => ws.msgs = 0, 1000);

  ws.on('message', raw => {
    if (++ws.msgs > 80) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'hello': {
        ws.uname = clean(m.name, 20).toLowerCase();
        if (ws.uname.length < 1) return;
        hubs.add(ws); deliverGifts(ws); break;
      }
      case 'gack': {
        if (!ws.uname || !Array.isArray(m.ids) || !gifts[ws.uname]) return;
        const ids = new Set(m.ids.map(String));
        gifts[ws.uname] = gifts[ws.uname].filter(g => !ids.has(g.id));
        if (!gifts[ws.uname].length) delete gifts[ws.uname];
        saveGifts(); break;
      }
      case 'admin': {
        if (!ADMIN_KEY || m.key !== ADMIN_KEY) return send(ws, { t: 'ares', msg: 'Wrong admin key.' });
        if (m.act === 'global') {
          const text = clean(m.text, 200); if (!text) return send(ws, { t: 'ares', msg: 'Empty message.' });
          let n = 0;
          hubs.forEach(h => { send(h, { t: 'global', from: OWNER, owner: 1, text }); n++; });
          send(ws, { t: 'ares', msg: 'Global message sent to ' + n + ' player connection(s).' });
        } else if (m.act === 'gift') {
          const to = clean(m.to, 20).toLowerCase(), g = m.gift || {};
          if (to.length < 3) return send(ws, { t: 'ares', msg: 'Bad username.' });
          let item;
          if (g.t === 'gems') { const v = Math.floor(num(g.v)); if (v < 1) return send(ws, { t: 'ares', msg: 'Bad gem amount.' }); item = { id: rid(), t: 'gems', v }; }
          else if (g.t === 'skin') { const v = clean(g.v, 40); if (!v) return send(ws, { t: 'ares', msg: 'Bad skin.' }); item = { id: rid(), t: 'skin', v }; }
          else return send(ws, { t: 'ares', msg: 'Bad gift.' });
          (gifts[to] = gifts[to] || []).push(item); saveGifts();
          let online = 0;
          hubs.forEach(h => { if (h.uname === to) { send(h, { t: 'gift', items: [item] }); online++; } });
          send(ws, { t: 'ares', msg: 'Gift sent to ' + to + (online ? ' (online, delivered now).' : ' (offline, they get it on next sign-in).') });
        }
        break;
      }
      case 'queue': {
        dequeue(ws); leaveMatch(ws);
        ws.pname = clean(m.name, 16) || 'Player'; ws.pskin = clean(m.skin, 40) || 's0';
        const mode = m.mode === 'ranked' ? 'ranked' : 'casual';
        ws.qAt = Date.now(); queues[mode].push(ws); qBroadcast(mode); tryMatch(mode); break;
      }
      case 's': {
        const mt = ws.match; if (!mt) return;
        const o = { t: 's', id: ws.mid, x: num(m.x), y: num(m.y), z: num(m.z), yaw: num(m.yaw), dead: m.dead ? 1 : 0 };
        mt.players.forEach(w => { if (w !== ws) send(w, o); }); break;
      }
      case 'dmg': {
        const mt = ws.match; if (!mt) return;
        const n = Math.max(1, Math.min(100, Math.floor(num(m.n))));
        mt.players.forEach(w => { if (w !== ws && w.mid === (m.to | 0)) send(w, { t: 'dmg', n }); }); break;
      }
      case 'win': {
        const mt = ws.match; if (!mt) return;
        mt.players.forEach(w => { if (w !== ws) send(w, { t: 'win', id: ws.mid }); });
        mt.players.forEach(w => { w.match = null; }); mt.players = []; break;
      }
    }
  });

  ws.on('close', () => { clearInterval(rl); hubs.delete(ws); dequeue(ws); leaveMatch(ws); });
  ws.on('error', () => {});
});

setInterval(() => wss.clients.forEach(w => { if (!w.isAlive) return w.terminate(); w.isAlive = false; try { w.ping(); } catch (e) {} }), 30000);
server.listen(PORT, () => console.log('VOID ROYALE server on port ' + PORT));
