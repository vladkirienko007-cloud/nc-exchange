// Хранилище: общие цены группы и личные сделки каждого игрока.
// Два бэкенда с одинаковым интерфейсом: Firebase (реальная синхронизация)
// и демо (localStorage, только этот браузер).
import { FIREBASE_CONFIG } from './config.js';

export const DEMO = !FIREBASE_CONFIG || !FIREBASE_CONFIG.apiKey;

const SPARK_LEN = 24;

// Активы, которые видны на планшете NC Exchange. Остальные добавляются сами
// при распознавании скриншота или вручную.
export const KNOWN_ASSETS = [
  { ticker: 'NCFUEL', name: 'NC Fuel', type: 'stock' },
  { ticker: 'FAL', name: 'Fertak Airlines', type: 'stock' },
  { ticker: 'NCTECH', name: 'NC Technologies', type: 'stock' },
  { ticker: 'SAMED', name: 'San Andreas Med', type: 'stock' },
];

function randomId(n = 10) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = crypto.getRandomValues(new Uint8Array(n));
  for (const b of buf) s += abc[b % abc.length];
  return s;
}

// Слить новую запись цены с документом актива.
function mergeAsset(old, item, user, at) {
  const a = { ...(old || {}), ticker: item.ticker };
  for (const k of ['name', 'type', 'fundamental', 'revenue', 'profit', 'capital', 'debt', 'dividend',
    'circulating', 'maxSupply', 'activity', 'adoption', 'risk', 'orderFlow', 'cycle']) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== '') a[k] = item[k];
  }
  if (!a.name) a.name = item.ticker;
  if (!a.type) a.type = 'stock';
  if (item.price != null) {
    if (old && old.price != null && old.price !== item.price) a.prevPrice = old.price;
    a.price = item.price;
    a.change = item.change != null ? item.change
      : (old && old.price ? (item.price / old.price - 1) * 100 : null);
    a.spark = [...((old && old.spark) || []), item.price].slice(-SPARK_LEN);
    a.updatedAt = at;
    a.updatedBy = user.name;
    a.updatedUid = user.uid;
  }
  return a;
}

/* ---------------- демо-бэкенд ---------------- */

function createDemoStore() {
  const KEY = 'ncx-demo-v1';
  const listeners = new Set();
  let state = load();

  function seed() {
    const now = Date.now();
    const s = {
      group: { id: 'demo', name: 'Демо-группа', owner: 'me', economy: { status: 'Рост', demand: 4.83, costs: 1.5 } },
      members: {
        me: { name: 'Влад', lastSeen: now, approved: true },
        max: { name: 'Макс', lastSeen: now - 30e3, approved: true },
        den: { name: 'Денис', lastSeen: now - 3600e3, approved: true },
        new1: { name: 'Артём', lastSeen: now - 5 * 60e3, approved: false, requestedAt: now - 5 * 60e3 },
      },
      assets: {}, history: {}, indices: {
        NCX: { code: 'NCX', value: 1327.86, change: 1.34, order: 0 },
        NCE: { code: 'NCE', value: 1459.08, change: 2.37, order: 1 },
        NCT: { code: 'NCT', value: 1323.07, change: 1.17, order: 2 },
      },
      trades: [], alerts: {},
    };
    // Значения со скриншота планшета; фундаментальные у FAL/NCTECH/SAMED — пример.
    const start = {
      NCFUEL: { price: 285.98, change: 2.37, fundamental: 318.63, revenue: 22695653.45, profit: 6429345.72, capital: 873768679.94, dividend: { report: 1308, perShare: 0.23, next: 1314 } },
      FAL: { price: 486.98, change: 1.14, fundamental: 471.2 },
      NCTECH: { price: 160.39, change: 0.98, fundamental: 184 },
      SAMED: { price: 370.45, change: 0.54, fundamental: 352.1 },
    };
    const who = [['me', 'Влад'], ['max', 'Макс'], ['den', 'Денис']];
    for (const base of KNOWN_ASSETS) {
      const v = start[base.ticker];
      const hist = [];
      // Демо-история: плавная кривая к текущей цене за последние двое суток.
      let p = v.price * (1 - v.change / 100 * 2.2);
      for (let i = 30; i >= 0; i--) {
        const at = now - i * 95 * 60e3 - (i ? 0 : 2 * 60e3);
        p = i ? p + (v.price - p) / (i + 1) + (Math.sin(i * 1.7) * v.price * 0.006) : v.price;
        const [uid, name] = who[i % 3];
        hist.push({ id: randomId(), ticker: base.ticker, price: Math.round(p * 100) / 100, uid, name, at, source: i % 4 ? 'screenshot' : 'manual' });
      }
      s.history[base.ticker] = hist;
      const last = hist[hist.length - 1];
      s.assets[base.ticker] = {
        ...base, ...v, prevPrice: hist[hist.length - 2].price,
        spark: hist.slice(-SPARK_LEN).map(h => h.price),
        updatedAt: base.ticker === 'SAMED' ? now - 70 * 60e3 : last.at,
        updatedBy: base.ticker === 'FAL' ? 'Макс' : 'Влад', updatedUid: 'me',
      };
    }
    s.trades = [
      { id: randomId(), ticker: 'NCFUEL', side: 'buy', qty: 120, price: 262.4, fee: 47.23, at: now - 5 * 86400e3 },
      { id: randomId(), ticker: 'NCTECH', side: 'buy', qty: 300, price: 171.1, fee: 77, at: now - 4 * 86400e3 },
      { id: randomId(), ticker: 'NCFUEL', side: 'sell', qty: 20, price: 280.1, fee: 8.4, at: now - 86400e3 },
      { id: randomId(), ticker: 'NCFUEL', side: 'div', qty: 100, price: 0.23, fee: 0, at: now - 3 * 3600e3 },
    ];
    return s;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* пустое или битое хранилище — начнём заново */ }
    return seed();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* приватный режим */ }
    emit();
  }
  function emit() { for (const fn of listeners) fn(); }
  window.addEventListener('storage', e => { if (e.key === KEY) { state = load(); emit(); } });

  const me = { uid: 'me', name: 'Влад' };
  function sub(get, cb) {
    const fn = () => cb(get());
    listeners.add(fn); fn();
    return () => listeners.delete(fn);
  }

  return {
    demo: true,
    async init() { return { user: me, group: { ...state.group, approved: true } }; },
    async signIn() {}, async signOut() {},
    async createGroup() {}, async joinGroup() {},
    watchMyMembership: cb => { cb('approved'); return () => {}; },
    async approveMember(uid) { state.members[uid].approved = true; save(); },
    async removeMember(uid) { delete state.members[uid]; save(); },
    leaveGroup() {},
    async deleteGroup() { state = seed(); save(); },
    async exitGroup() {},
    async renameMe(name) { me.name = name; state.members.me.name = name; save(); },
    reset() { state = seed(); save(); },
    inviteLink() { return location.href.split('#')[0]; },
    watchGroup: cb => sub(() => state.group, cb),
    watchMembers: cb => sub(() => Object.entries(state.members).map(([uid, m]) => ({ uid, ...m })), cb),
    watchAssets: cb => sub(() => Object.values(state.assets), cb),
    watchIndices: cb => sub(() => Object.values(state.indices), cb),
    watchHistory: (t, cb) => sub(() => [...(state.history[t] || [])].sort((a, b) => b.at - a.at), cb),
    watchTrades: cb => sub(() => [...state.trades].sort((a, b) => b.at - a.at), cb),
    watchAlerts: cb => sub(() => state.alerts, cb),
    async saveSnapshot({ assets = [], indices = [], economy }, source) {
      const at = Date.now();
      for (const item of assets) {
        state.assets[item.ticker] = mergeAsset(state.assets[item.ticker], item, me, at);
        if (item.price != null) {
          (state.history[item.ticker] ||= []).push({ id: randomId(), ticker: item.ticker, price: item.price, uid: me.uid, name: me.name, at, source });
        }
      }
      for (const ix of indices) state.indices[ix.code] = { ...ix };
      if (economy) state.group.economy = { ...state.group.economy, ...economy };
      save();
    },
    async deleteHistory(ticker, id) {
      state.history[ticker] = (state.history[ticker] || []).filter(h => h.id !== id);
      save();
    },
    async deleteAsset(ticker) { delete state.assets[ticker]; delete state.history[ticker]; save(); },
    async addTrade(t) { state.trades.push({ id: randomId(), ...t }); save(); },
    async deleteTrade(id) { state.trades = state.trades.filter(t => t.id !== id); save(); },
    async saveAlert(ticker, alert) {
      if (alert) state.alerts[ticker] = alert; else delete state.alerts[ticker];
      save();
    },
  };
}

/* ---------------- Firebase-бэкенд ---------------- */

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

export const LOGIN_RE = /^[a-zA-Z0-9_-]{3,20}$/;
// .invalid — зарезервированный домен, писем туда не бывает
const loginEmail = login => `${login.toLowerCase()}@login.nc-exchange.invalid`;

function authError(e) {
  const m = {
    'auth/invalid-email': 'Логин: только латиница, цифры, _ и -, от 3 до 20 символов.',
    'auth/invalid-credential': 'Неверный логин или пароль.',
    'auth/wrong-password': 'Неверный логин или пароль.',
    'auth/user-not-found': 'Такого логина нет. Нажми «Создать аккаунт».',
    'auth/email-already-in-use': 'Этот логин уже занят. Придумай другой или нажми «Войти».',
    'auth/weak-password': 'Пароль слишком короткий, нужно хотя бы 6 символов.',
    'auth/too-many-requests': 'Слишком много попыток. Подожди немного и попробуй снова.',
    'auth/network-request-failed': 'Нет связи с сервером. Проверь интернет или VPN.',
  };
  return m[e.code] || e.message;
}

async function createFirebaseStore() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(FB + 'firebase-app.js'),
    import(FB + 'firebase-auth.js'),
    import(FB + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(FIREBASE_CONFIG);
  // Явно храним вход в IndexedDB (с запасным localStorage), чтобы не входить каждый раз.
  const auth = A.initializeAuth(app, {
    persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence],
    popupRedirectResolver: A.browserPopupRedirectResolver,
  });
  const db = F.initializeFirestore(app, {
    localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
  });

  let user = null;
  let gid = new URLSearchParams(location.search).get('g') || localStorage.getItem('ncx-group');
  let heartbeat = null;

  const gref = (...p) => F.doc(db, 'groups', gid, ...p);
  const gcol = (...p) => F.collection(db, 'groups', gid, ...p);
  const ucol = (...p) => F.collection(db, 'users', user.uid, ...p);

  async function deleteAll(col) {
    for (;;) {
      const s = await F.getDocs(F.query(col, F.limit(400)));
      if (s.empty) return;
      const b = F.writeBatch(db);
      s.docs.forEach(d => b.delete(d.ref));
      await b.commit();
    }
  }

  function snapList(q, cb, map = d => ({ id: d.id, ...d.data() })) {
    return F.onSnapshot(q, s => cb(s.docs.map(map)), err => console.warn(err));
  }

  async function enterGroup(id) {
    const g = await F.getDoc(F.doc(db, 'groups', id));
    if (!g.exists()) throw new Error('Группа не найдена. Проверь ссылку-приглашение.');
    gid = id;
    localStorage.setItem('ncx-group', id);
    const isOwner = g.data().owner === user.uid;
    const me = await F.getDoc(gref('members', user.uid));
    if (!me.exists()) {
      // новый участник — заявка, пока создатель группы её не примет
      await F.setDoc(gref('members', user.uid), { name: user.name, lastSeen: Date.now(), approved: isOwner, requestedAt: Date.now() });
    } else {
      await F.updateDoc(gref('members', user.uid), { name: user.name, lastSeen: Date.now(), ...(isOwner ? { approved: true } : {}) });
    }
    clearInterval(heartbeat);
    heartbeat = setInterval(() => F.updateDoc(gref('members', user.uid), { lastSeen: Date.now() }).catch(() => {}), 60e3);
    const approved = isOwner || (me.exists() && me.data().approved === true);
    return { id, ...g.data(), approved };
  }

  return {
    demo: false,
    async init() {
      const fbUser = await new Promise(res => { const un = A.onAuthStateChanged(auth, u => { un(); res(u); }); });
      if (!fbUser) return { user: null };
      user = { uid: fbUser.uid, name: localStorage.getItem('ncx-name') || fbUser.displayName || 'Игрок' };
      if (!gid) return { user, group: null };
      try { return { user, group: await enterGroup(gid) }; }
      catch (e) { localStorage.removeItem('ncx-group'); gid = null; return { user, group: null, error: e.message }; }
    },
    async signIn() {
      // Только окно: вход через перенаправление ломается в браузерах с
      // разделением сторонних cookie, когда сайт не на firebaseapp.com.
      try { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); }
      catch (e) {
        if (e.code === 'auth/popup-blocked') throw new Error('Браузер заблокировал окно входа. Разреши всплывающие окна для этого сайта и нажми ещё раз.');
        if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') throw new Error('Окно входа закрыто.');
        throw e;
      }
    },
    // Вход по логину и паролю: без всплывающих окон и сторонних страниц — работает в
    // Safari на iPhone. Firebase умеет только почту, поэтому логин превращаем в
    // служебный адрес, который никуда не ведёт.
    async signInLogin(login, password) {
      try { await A.signInWithEmailAndPassword(auth, loginEmail(login), password); }
      catch (e) { throw new Error(authError(e)); }
    },
    async signUpLogin(login, password) {
      try {
        const cred = await A.createUserWithEmailAndPassword(auth, loginEmail(login), password);
        await A.updateProfile(cred.user, { displayName: login });
        localStorage.setItem('ncx-name', login);
      } catch (e) { throw new Error(authError(e)); }
    },
    async signOut() { localStorage.removeItem('ncx-group'); await A.signOut(auth); },
    async createGroup(name) {
      const id = randomId(12);
      await F.setDoc(F.doc(db, 'groups', id), { name, owner: user.uid, createdAt: Date.now(), economy: null });
      gid = id;
      await F.setDoc(gref('members', user.uid), { name: user.name, lastSeen: Date.now(), approved: true });
      const batch = F.writeBatch(db);
      for (const a of KNOWN_ASSETS) batch.set(gref('assets', a.ticker), { ...a });
      await batch.commit();
      return enterGroup(id);
    },
    async joinGroup(id) { return enterGroup(id); },
    // Ждать, пока создатель примет заявку (или отклонит её — тогда документ пропадёт).
    watchMyMembership(cb) {
      return F.onSnapshot(gref('members', user.uid), s => cb(s.exists() ? (s.data().approved ? 'approved' : 'pending') : 'rejected'), () => {});
    },
    approveMember: uid => F.updateDoc(gref('members', uid), { approved: true }),
    removeMember: uid => F.deleteDoc(gref('members', uid)),
    leaveGroup() { localStorage.removeItem('ncx-group'); gid = null; },
    async renameMe(name) {
      user.name = name;
      localStorage.setItem('ncx-name', name);
      await F.updateDoc(gref('members', user.uid), { name });
    },
    inviteLink() { return location.origin + location.pathname + '?g=' + gid; },
    watchGroup: cb => F.onSnapshot(gref(), s => cb({ id: gid, ...s.data() })),
    watchMembers: cb => snapList(gcol('members'), cb, d => ({ uid: d.id, ...d.data() })),
    watchAssets: cb => snapList(gcol('assets'), cb, d => d.data()),
    watchIndices: cb => snapList(gcol('indices'), cb, d => d.data()),
    watchHistory: (t, cb) => snapList(F.query(gcol('assets', t, 'history'), F.orderBy('at', 'desc'), F.limit(500)), cb),
    watchTrades: cb => snapList(F.query(ucol('trades'), F.where('group', '==', gid)), list => cb(list.sort((a, b) => b.at - a.at))),
    watchAlerts: cb => F.onSnapshot(ucol('alerts'), s => {
      const o = {};
      s.docs.forEach(d => { if (d.data().group === gid) o[d.id] = d.data(); });
      cb(o);
    }),
    async saveSnapshot({ assets = [], indices = [], economy }, source) {
      const at = Date.now();
      await F.runTransaction(db, async tx => {
        const olds = await Promise.all(assets.map(a => tx.get(gref('assets', a.ticker))));
        assets.forEach((item, i) => {
          tx.set(gref('assets', item.ticker), mergeAsset(olds[i].data(), item, user, at));
          if (item.price != null) {
            tx.set(F.doc(gcol('assets', item.ticker, 'history')), { ticker: item.ticker, price: item.price, uid: user.uid, name: user.name, at, source });
          }
        });
        for (const ix of indices) tx.set(gref('indices', ix.code), ix);
        if (economy) tx.update(gref(), { economy });
      });
    },
    deleteHistory: (t, id) => F.deleteDoc(gref('assets', t, 'history', id)),
    async deleteAsset(t) {
      // вложенная история сама не удаляется — чистим её пачками
      await deleteAll(gcol('assets', t, 'history'));
      await F.deleteDoc(gref('assets', t));
    },
    // Удалить группу целиком (только создатель). Свой документ участника и
    // документ группы — последними: по ним правила проверяют права.
    async deleteGroup() {
      const assets = await F.getDocs(gcol('assets'));
      for (const d of assets.docs) await deleteAll(gcol('assets', d.id, 'history'));
      await deleteAll(gcol('assets'));
      await deleteAll(gcol('indices'));
      const members = await F.getDocs(gcol('members'));
      const others = members.docs.filter(d => d.id !== user.uid);
      for (let i = 0; i < others.length; i += 400) {
        const b = F.writeBatch(db);
        others.slice(i, i + 400).forEach(d => b.delete(d.ref));
        await b.commit();
      }
      const trades = await F.getDocs(F.query(ucol('trades'), F.where('group', '==', gid)));
      for (const d of trades.docs) await F.deleteDoc(d.ref);
      const ref = gref();
      await F.deleteDoc(gref('members', user.uid)).catch(() => {});
      await F.deleteDoc(ref);
      clearInterval(heartbeat);
      localStorage.removeItem('ncx-group');
      gid = null;
    },
    async exitGroup() {
      await F.deleteDoc(gref('members', user.uid));
      clearInterval(heartbeat);
      localStorage.removeItem('ncx-group');
      gid = null;
    },
    addTrade: t => F.addDoc(ucol('trades'), { ...t, group: gid }),
    deleteTrade: id => F.deleteDoc(F.doc(ucol('trades'), id)),
    saveAlert: (t, alert) => alert
      ? F.setDoc(F.doc(ucol('alerts'), t), { ...alert, group: gid })
      : F.deleteDoc(F.doc(ucol('alerts'), t)),
  };
}

export async function createStore() {
  return DEMO ? createDemoStore() : createFirebaseStore();
}
