// 서바이벌 퀴즈 서버 (Render 등 Node.js 호스팅용)
// 화면(public/)은 그대로 쓰고, 데이터 저장/실시간 전달을 이 서버가 맡습니다.
// 실행: npm install && npm start
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// 화면 파일은 public 폴더 안에 있어도 되고, server.js 옆(맨 바깥)에 있어도 됩니다.
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const FILES = new Set(['index.html', 'host.html', 'screen.html', 'db.js', 'config.js', 'common.css', 'favicon.ico']);
const DATA = path.join(__dirname, 'data', 'store.json');

// ---------- 저장소 (메모리 + 파일 백업) ----------
const store = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(DATA, 'utf8')))) store.set(k, v); } catch (_) {}
let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(Object.fromEntries(store))); } catch (_) {}
  }, 3000);
}
// 오래된 방 정리 (7일)
setInterval(() => {
  const cut = Date.now() - 7 * 864e5;
  for (const [k, v] of store) if (/^rooms\/[^/]+$/.test(k) && (v.touched || 0) < cut) {
    for (const k2 of [...store.keys()]) if (k2 === k || k2.startsWith(k + '/')) store.delete(k2);
  }
}, 36e5);

const clone = o => JSON.parse(JSON.stringify(o));
const isDel = v => v && typeof v === 'object' && v.__del === 1;
const isNow = v => v && typeof v === 'object' && v.__now === 1;
function resolve(obj) { const o = {}; for (const [k, v] of Object.entries(obj || {})) if (!isDel(v)) o[k] = isNow(v) ? Date.now() : v; return o; }

// ---------- 권한 (Firestore 규칙과 같은 내용) ----------
const seg = p => p.split('/');
const valid = p => /^rooms\/[A-Za-z0-9]{1,12}(\/(players|hosts|secret|quiz)\/[A-Za-z0-9_-]{1,40})?$/.test(p);
const isHost = (uid, r) => store.has(`rooms/${r}/hosts/${uid}`);
const room = r => store.get(`rooms/${r}`);
const isInt = v => Number.isInteger(v);

function canRead(uid, p, isCol) {
  const s = seg(p);
  if (isCol) return s[2] === 'players' || isHost(uid, s[1]);
  if (s.length === 2) return true;
  if (s[2] === 'players') return true;
  if (s[2] === 'hosts') return s[3] === uid || isHost(uid, s[1]);
  return isHost(uid, s[1]);
}
function validPlayer(d) {
  const keys = Object.keys(d);
  return keys.every(k => ['name', 'avatar', 'color', 'choice', 'round', 'late', 'g'].includes(k))
    && typeof d.name === 'string' && d.name.length > 0 && d.name.length <= 12
    && typeof d.avatar === 'string' && d.avatar.length <= 16
    && typeof d.color === 'string' && d.color.length <= 9
    && ['', 'A', 'B'].includes(d.choice) && isInt(d.round) && typeof d.late === 'boolean' && isInt(d.g);
}
function canWrite(uid, op, p, oldD, newD) {
  const s = seg(p), r = s[1];
  if (s.length === 2) {
    if (!oldD) return op !== 'del' && newD.owner === uid;
    return isHost(uid, r);
  }
  const R = room(r); if (!R) return false;
  const kind = s[2], id = s[3];
  if (kind === 'hosts') {
    if (op === 'del') return isHost(uid, r);
    if (oldD) return false;
    const sec = store.get(`rooms/${r}/secret/key`);
    return id === uid && (R.owner === uid || (sec && newD.key === sec.v));
  }
  if (kind === 'secret' || kind === 'quiz') return isHost(uid, r);
  if (kind === 'players') {
    if (op === 'del') return isHost(uid, r) || id === uid;
    if (id !== uid || !validPlayer(newD)) return false;
    if (!oldD) return newD.choice === '' && R.joinOpen === true;
    if (newD.late !== oldD.late || newD.g !== oldD.g) return false;
    if (newD.choice === oldD.choice && newD.round === oldD.round) return true;
    return R.phase === 'question' && newD.round === R.round && Date.now() < (R.startedAt || 0) + ((R.dur || 0) + 2) * 1000;
  }
  return false;
}

// ---------- 변경 알림 (100ms 단위로 묶어서 전송) ----------
const docSubs = new Map();  // path -> Set<[ws, sid]>
const colSubs = new Map();  // colPath -> Set<[ws, sid]>
const pendingDocs = new Set();
const pendingCol = new Map(); // colPath -> Set<id>
function changed(p) {
  pendingDocs.add(p);
  const i = p.lastIndexOf('/'), col = p.slice(0, i);
  if (colSubs.has(col)) { if (!pendingCol.has(col)) pendingCol.set(col, new Set()); pendingCol.get(col).add(p.slice(i + 1)); }
  persist();
}
setInterval(() => {
  for (const p of pendingDocs) {
    const subs = docSubs.get(p); if (!subs || !subs.size) continue;
    const data = JSON.stringify(store.get(p) ?? null);
    for (const [ws, sid] of subs) if (ws.readyState === 1) ws.send(`{"t":"snap","sid":${sid},"data":${data}}`);
  }
  pendingDocs.clear();
  for (const [col, ids] of pendingCol) {
    const subs = colSubs.get(col); if (!subs || !subs.size) continue;
    const ch = JSON.stringify([...ids].map(id => [id, store.get(col + '/' + id) ?? null]));
    for (const [ws, sid] of subs) if (ws.readyState === 1) ws.send(`{"t":"col","sid":${sid},"ch":${ch}}`);
  }
  pendingCol.clear();
}, 100);

function colList(col) {
  const pre = col + '/', out = [];
  for (const [k, v] of store) if (k.startsWith(pre) && !k.slice(pre.length).includes('/')) out.push([k.slice(pre.length), v]);
  return out;
}

// ---------- 요청 처리 ----------
function handleOp(ws, m) {
  const p = String(m.path || '');
  if (!valid(p)) return { err: 'invalid-path' };
  const uid = ws.uid, old = store.get(p) || null;
  if (m.op === 'get') return canRead(uid, p) ? { data: old } : { err: 'permission-denied' };
  let next;
  if (m.op === 'set' || m.op === 'create') {
    if (m.op === 'create' && old) return { err: 'already-exists' };
    next = resolve(m.data);
  } else if (m.op === 'update') {
    if (!old) return { err: 'not-found' };
    next = clone(old);
    for (const [k, v] of Object.entries(m.data || {})) {
      const parts = k.split('.'); let o = next;
      for (const s of parts.slice(0, -1)) { if (!o[s] || typeof o[s] !== 'object' || Array.isArray(o[s])) o[s] = {}; o = o[s]; }
      if (isDel(v)) delete o[parts.at(-1)]; else o[parts.at(-1)] = isNow(v) ? Date.now() : v;
    }
  } else if (m.op === 'del') {
    if (!old) return { data: null };
    if (!canWrite(uid, 'del', p, old, null)) return { err: 'permission-denied' };
    store.delete(p); changed(p); return { data: null };
  } else return { err: 'bad-op' };
  if (JSON.stringify(next).length > 300000) return { err: 'too-large' };
  if (!canWrite(uid, m.op, p, old, next)) return { err: 'permission-denied' };
  if (seg(p).length === 2) next.touched = Date.now();
  store.set(p, next); changed(p);
  return { data: null };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const ROUTES = { '/': 'index.html', '/host': 'host.html', '/screen': 'screen.html' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Cache-Control': 'no-store' }); return res.end('ok'); }
  const file = ROUTES[url.pathname] || url.pathname.slice(1);
  if (!FILES.has(file)) { res.writeHead(404); return res.end('not found'); }
  const fp = path.join(PUB, file);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 400 * 1024 });
wss.on('connection', ws => {
  ws.alive = true; ws.subs = new Map(); // sid -> {map, key}
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    ws.alive = true;
    if (m.t === 'ping') return;
    if (m.t === 'hello') {
      const tok = String(m.token || '');
      if (tok.length < 16) return ws.close();
      ws.uid = crypto.createHash('sha256').update(tok).digest('base64url').slice(0, 20).replace(/[-_]/g, 'x');
      return ws.send(JSON.stringify({ t: 'hi', uid: ws.uid }));
    }
    if (!ws.uid) return;
    if (m.t === 'op') {
      let r; try { r = handleOp(ws, m); } catch (e) { r = { err: 'server-error' }; }
      return ws.send(JSON.stringify({ t: 'res', id: m.id, ...r }));
    }
    if (m.t === 'sub') {
      const p = String(m.path || ''), sid = Number(m.sid);
      const isCol = !!m.col;
      const okPath = isCol ? /^rooms\/[A-Za-z0-9]{1,12}\/(players|hosts)$/.test(p) : valid(p);
      if (!okPath || !canRead(ws.uid, p, isCol)) return ws.send(JSON.stringify({ t: 'suberr', sid, err: 'permission-denied' }));
      const map = isCol ? colSubs : docSubs;
      if (!map.has(p)) map.set(p, new Set());
      const entry = [ws, sid]; map.get(p).add(entry); ws.subs.set(sid, { map, p, entry });
      if (isCol) ws.send(JSON.stringify({ t: 'col', sid, full: true, ch: colList(p) }));
      else ws.send(JSON.stringify({ t: 'snap', sid, data: store.get(p) ?? null }));
      return;
    }
    if (m.t === 'unsub') {
      const s = ws.subs.get(Number(m.sid)); if (!s) return;
      s.map.get(s.p)?.delete(s.entry); ws.subs.delete(Number(m.sid));
    }
  });
  ws.on('close', () => { for (const s of ws.subs.values()) s.map.get(s.p)?.delete(s.entry); ws.subs.clear(); });
});
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (_) {} }
}, 30000);

server.listen(PORT, () => console.log(`퀴즈 서버 실행 중: http://localhost:${PORT}  (마스터: /host)`));
