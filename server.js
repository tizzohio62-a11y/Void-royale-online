// VOID ROYALE online server — matchmaking queue + match relay.
// Zero dependencies. Needs Node 18+.  Run:  node server.js
// Put index.html (the game) next to this file and it will be served at "/".
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const MIN_PLAYERS = 2, MAX_PLAYERS = 4;
const WAIT_MS = +process.env.MATCH_WAIT_MS || 6000; // wait this long for more players before starting with 2-3
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HTML = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    return fs.readFile(HTML, (err, data) => {
      if (err) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('VOID ROYALE server is running. Put index.html next to server.js to serve the game from here.'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }
  res.writeHead(404); res.end('not found');
});

// ---- minimal RFC 6455 websocket framing ----
function frame(op, payload) {
  const len = payload.length; let h;
  if (len < 126) h = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([h, payload]);
}

const clients = new Set(), queue = [];
let nextClientId = 1, nextMatchId = 1;

const num = v => { v = +v; return isFinite(v) ? Math.max(-1000, Math.min(1000, v)) : 0; };
const cleanName = v => String(v || 'Player').replace(/[^\w .-]/g, '').trim().slice(0, 16) || 'Player';
const cleanId = v => String(v || 's0').replace(/[^\w-]/g, '').slice(0, 24) || 's0';

class Client {
  constructor(socket) {
    this.socket = socket; this.id = nextClientId++; this.buf = Buffer.alloc(0);
    this.frag = []; this.fragOp = 0; this.closed = false;
    this.match = null; this.pid = -1; this.name = 'Player'; this.skin = 's0';
    this.mode = 'casual'; this.inQueue = false; this.queuedAt = 0; this.msgCount = 0; this.msgWin = Date.now();
  }
  send(o) { if (this.closed) return; try { this.socket.write(frame(1, Buffer.from(JSON.stringify(o)))); } catch (e) { } }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > (1 << 20)) return this.destroy();
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 15, masked = !!(b[1] & 0x80);
      let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > 65536n) return this.destroy(); len = Number(big); off = 10; }
      if (len > 65536 || !masked) return this.destroy();           // clients must send masked frames
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) { try { this.socket.write(frame(8, Buffer.alloc(0))); } catch (e) { } return this.destroy(); }
      if (op === 9) { try { this.socket.write(frame(10, data)); } catch (e) { } continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { this.fragOp = op; this.frag = [data]; }
      else if (op === 0) this.frag.push(data);
      else continue;
      if (fin) { const text = Buffer.concat(this.frag).toString('utf8'); this.frag = []; if (this.fragOp === 1) this.onMessage(text); }
    }
  }
  onMessage(text) {
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const now = Date.now();
    if (now - this.msgWin > 1000) { this.msgWin = now; this.msgCount = 0; }
    if (++this.msgCount > 150) return;                              // flood guard
    switch (m.t) {
      case 'queue':
        if (this.match || this.inQueue) return;
        this.name = cleanName(m.name); this.skin = cleanId(m.skin); this.mode = m.mode === 'ranked' ? 'ranked' : 'casual'; enqueue(this); break;
      case 'cancel': dequeue(this); break;
      case 's': {
        if (!this.match) return;
        const msg = { t: 's', id: this.pid, x: num(m.x), y: num(m.y), z: num(m.z), yaw: num(m.yaw), dead: m.dead ? 1 : 0, sl: m.sl ? 1 : 0 };
        for (const p of this.match.players) if (p !== this) p.send(msg);
        break;
      }
      case 'dmg': {
        if (!this.match || this.match.over) return;
        const to = this.match.players.find(p => p !== this && p.pid === (m.to | 0));
        if (to) to.send({ t: 'dmg', n: Math.max(1, Math.min(100, m.n | 0)), from: this.pid });
        break;
      }
      case 'win': {
        if (!this.match || this.match.over) return;
        this.match.over = true;
        for (const p of this.match.players) if (p !== this) p.send({ t: 'win', id: this.pid });
        break;
      }
    }
  }
  destroy() {
    if (this.closed) return; this.closed = true; clients.delete(this);
    dequeue(this); leaveMatch(this);
    try { this.socket.end(); } catch (e) { } try { this.socket.destroy(); } catch (e) { }
  }
}

function broadcastQueue() { for (const c of queue) c.send({ t: 'queued', n: queue.filter(x => x.mode === c.mode).length }); }
function enqueue(c) { c.inQueue = true; c.queuedAt = Date.now(); queue.push(c); broadcastQueue(); tryMatch(); }
function dequeue(c) { const i = queue.indexOf(c); if (i >= 0) { queue.splice(i, 1); c.inQueue = false; broadcastQueue(); } }
function tryMatch() {
  for (const mode of ['casual', 'ranked']) {          // casual and ranked players never mix
    for (;;) {
      const q = queue.filter(c => c.mode === mode);
      if (q.length < MIN_PLAYERS) break;
      const waited = Date.now() - q[0].queuedAt;
      if (q.length < MAX_PLAYERS && waited < WAIT_MS) break;
      const group = q.slice(0, MAX_PLAYERS);
      for (const c of group) queue.splice(queue.indexOf(c), 1);
      startMatch(group);
    }
  }
}
function startMatch(players) {
  const m = { id: nextMatchId++, players, over: false };
  players.forEach((p, i) => { p.match = m; p.pid = i; p.inQueue = false; });
  const list = players.map(p => ({ id: p.pid, name: p.name, skin: p.skin }));
  players.forEach(p => p.send({ t: 'match', you: p.pid, players: list }));
  broadcastQueue();
  console.log(`match ${m.id} started: ${list.map(p => p.name).join(', ')}`);
}
function leaveMatch(c) {
  const m = c.match; if (!m) return;
  c.match = null; m.players = m.players.filter(p => p !== c);
  for (const p of m.players) p.send({ t: 'left', id: c.pid });
  if (!m.players.length) console.log(`match ${m.id} ended`);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = new Client(socket); clients.add(c);
  socket.on('data', d => { try { c.onData(d); } catch (e) { c.destroy(); } });
  socket.on('close', () => c.destroy());
  socket.on('error', () => c.destroy());
});

setInterval(tryMatch, 1000);
setInterval(() => { for (const c of clients) { try { c.socket.write(frame(9, Buffer.alloc(0))); } catch (e) { } } }, 20000); // keep-alive

server.listen(PORT, () => console.log(`VOID ROYALE server listening on :${PORT}`));
