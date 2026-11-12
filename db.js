// 데이터 연결 계층: Firebase(Firestore + 익명 로그인)
// 주소에 ?mock=1 을 붙이면 Firebase 없이 이 브라우저 안에서만 동작하는 테스트 모드
const MOCK = new URLSearchParams(location.search).has('mock');
const V = '10.12.2';

export const DEL = { __del: 1 };
export const NOW = { __now: 1 };
export const serverNow = () => Date.now();

let api;
export async function initDB() {
  if (api) return api;
  api = MOCK ? mockApi() : window.BACKEND === 'server' ? await serverApi() : await firebaseApi();
  await api.ready;
  return api;
}

async function loadConfig() {
  if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey) return window.FIREBASE_CONFIG;
  const r = await fetch('/__/firebase/init.json');
  if (!r.ok) throw new Error('Firebase 설정을 찾지 못했어요 (Firebase Hosting으로 배포했는지 확인)');
  return r.json();
}

async function firebaseApi() {
  const [{ initializeApp }, fs, au] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
  ]);
  const app = initializeApp(await loadConfig());
  const db = fs.getFirestore(app);
  const auth = au.getAuth(app);
  await au.setPersistence(auth, au.browserLocalPersistence);
  const cred = auth.currentUser ? { user: auth.currentUser } : await new Promise((res, rej) => {
    const off = au.onAuthStateChanged(auth, u => { off(); u ? res({ user: u }) : au.signInAnonymously(auth).then(res, rej); });
  });
  const conv = obj => {
    const o = {};
    for (const [k, v] of Object.entries(obj)) o[k] = v === DEL ? fs.deleteField() : v === NOW ? fs.serverTimestamp() : v;
    return o;
  };
  const ref = p => fs.doc(db, p);
  return {
    uid: cred.user.uid,
    ready: Promise.resolve(),
    get: async p => { const s = await fs.getDoc(ref(p)); return s.exists() ? s.data() : null; },
    set: (p, d) => fs.setDoc(ref(p), conv(d)),
    create: async (p, d) => fs.setDoc(ref(p), conv(d)),
    update: (p, d) => fs.updateDoc(ref(p), conv(d)),
    del: p => fs.deleteDoc(ref(p)),
    watch: (p, cb, err) => fs.onSnapshot(ref(p), s => cb(s.exists() ? s.data() : null), e => err && err(e)),
    watchCol: (p, cb, err) => fs.onSnapshot(fs.collection(db, p), s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), e => err && err(e)),
  };
}

// ---------- 자체 서버(server.js)와 WebSocket으로 연결 ----------
function serverApi() {
  let tok = localStorage.getItem('q_tok');
  if (!tok) { tok = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('q_tok', tok); }
  let ws, seq = 0, uid = null, retry = 0;
  const pending = new Map(), subs = new Map(), queue = [];
  const banner = on => {
    let el = document.getElementById('connBanner');
    if (!el) { el = document.createElement('div'); el.id = 'connBanner'; el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#c0392b;color:#fff;text-align:center;font-size:13px;padding:6px;display:none'; el.textContent = '연결이 끊겼어요. 다시 연결하는 중…'; document.body.appendChild(el); }
    el.style.display = on ? 'block' : 'none';
  };
  let readyRes; const ready = new Promise(r => (readyRes = r));
  const raw = o => { if (ws && ws.readyState === 1 && uid) ws.send(JSON.stringify(o)); else queue.push(o); };
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: tok }));
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'hi') {
        uid = m.uid; api.uid = uid; retry = 0; banner(false); readyRes();
        for (const [sid, s] of subs) ws.send(JSON.stringify({ t: 'sub', sid, path: s.path, col: s.col }));
        while (queue.length) ws.send(JSON.stringify(queue.shift()));
        return;
      }
      if (m.t === 'res') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.err ? p.rej(Object.assign(new Error(m.err), { code: m.err })) : p.res(m.data); return; }
      const s = subs.get(m.sid); if (!s) return;
      if (m.t === 'snap') s.cb(m.data);
      if (m.t === 'col') {
        if (m.full) s.map = new Map();
        for (const [id, d] of m.ch) d ? s.map.set(id, d) : s.map.delete(id);
        s.cb([...s.map].map(([id, d]) => ({ id, ...d })));
      }
      if (m.t === 'suberr' && s.err) s.err(new Error(m.err));
    };
    ws.onclose = () => {
      banner(!!uid);
      for (const p of pending.values()) p.rej(new Error('연결이 끊겼어요'));
      pending.clear();
      setTimeout(connect, Math.min(5000, 400 + retry++ * 700));
    };
  }
  setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 20000);
  const op = (o, path, data) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); raw({ t: 'op', id, op: o, path, data }); });
  const sub = (path, col, cb, err) => { const sid = ++seq; subs.set(sid, { path, col, cb, err, map: new Map() }); raw({ t: 'sub', sid, path, col }); return () => { subs.delete(sid); raw({ t: 'unsub', sid }); }; };
  const api = {
    uid: null, ready,
    get: p => op('get', p),
    set: (p, d) => op('set', p, d),
    create: (p, d) => op('create', p, d),
    update: (p, d) => op('update', p, d),
    del: p => op('del', p),
    watch: (p, cb, err) => sub(p, false, cb, err),
    watchCol: (p, cb, err) => sub(p, true, cb, err),
  };
  connect();
  return api;
}

// ---------- 테스트용 가짜 DB (localStorage, 같은 브라우저 탭끼리 공유) ----------
function mockApi() {
  const KEY = 'mockdb';
  let uid = sessionStorage.getItem('mock_uid');
  if (!uid) { uid = 'u' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('mock_uid', uid); }
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; } };
  let store = load();
  const subs = new Set();
  let pending = false;
  const notify = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; subs.forEach(f => f()); }, 30); };
  const save = () => { localStorage.setItem(KEY, JSON.stringify(store)); notify(); };
  addEventListener('storage', e => { if (e.key === KEY) { store = load(); notify(); } });
  const val = v => (v === NOW ? Date.now() : v);
  const clone = o => (o ? JSON.parse(JSON.stringify(o)) : null);
  const api = {
    uid, ready: Promise.resolve(),
    get: async p => clone(store[p]),
    set: async (p, d) => { const o = {}; for (const k in d) if (d[k] !== DEL) o[k] = val(d[k]); store[p] = o; save(); },
    create: async (p, d) => { if (store[p]) throw new Error('exists'); return api.set(p, d); },
    update: async (p, d) => {
      if (!store[p]) throw new Error('not found');
      for (const [k, v] of Object.entries(d)) {
        const parts = k.split('.'); let o = store[p];
        for (const s of parts.slice(0, -1)) o = o[s] = o[s] || {};
        if (v === DEL) delete o[parts.at(-1)]; else o[parts.at(-1)] = val(v);
      }
      save();
    },
    del: async p => { delete store[p]; save(); },
    watch: (p, cb) => { let last; const f = () => { const s = JSON.stringify(store[p] ?? null); if (s !== last) { last = s; cb(clone(store[p])); } }; subs.add(f); setTimeout(f); return () => subs.delete(f); },
    watchCol: (p, cb) => {
      let last; const pre = p + '/';
      const f = () => {
        const list = Object.keys(store).filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(k => ({ id: k.slice(pre.length), ...store[k] }));
        const s = JSON.stringify(list); if (s !== last) { last = s; cb(clone(list)); }
      };
      subs.add(f); setTimeout(f); return () => subs.delete(f);
    },
  };
  window.__mock = api;
  return api;
}

// ---------- 공용 도우미 ----------
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const qs = new URLSearchParams(location.search);
export function withMock(url) { return MOCK ? url + (url.includes('?') ? '&' : '?') + 'mock=1' : url; }

// 라벨 표시: O/X 같은 한 글자는 큰 기호로, 나머지는 글자로
export function labelHTML(t, side, cls = '') {
  const c = side === 'A' ? 'mark-a' : 'mark-b';
  const s = String(t ?? '');
  const n = Math.max(1, [...s].length);
  return `<span class="${c} ${n === 1 ? 'sym' : 'word'} ${cls}" style="--n:${n}">${esc(s)}</span>`;
}

// 남은 시간 계산: 문제 시작을 '받은 시점' 기준으로 계산(기기 시계 차이 무시)
export function makeClock() {
  let key = '', t0 = 0;
  return room => {
    if (!room || room.phase !== 'question') return 0;
    const k = room.round + ':' + (room.startedKey || '');
    if (k !== key) { key = k; t0 = performance.now() - 250; }
    return Math.max(0, room.dur * 1000 - (performance.now() - t0));
  };
}

export function qrInto(el, text, size) {
  el.innerHTML = '';
  try { new QRCode(el, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M }); }
  catch (_) { el.innerHTML = `<img alt="QR" src="https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=0&data=${encodeURIComponent(text)}">`; }
}
