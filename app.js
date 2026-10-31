import { createStore, DEMO, LOGIN_RE } from './store.js';
import * as U from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } };

const S = {
  user: null, group: null,
  members: [], assets: [], indices: [], trades: [], alerts: {}, history: [],
  filter: lsGet('ncx-filter', 'all'),
  favs: new Set(lsGet('ncx-favs', [])),
  range: '24h',
  selecting: false, sel: new Set(),
};
let store;
let unsubs = [];
let histUnsub = null;
let histTicker = null;

/* ---------------- маршруты ---------------- */

function route() {
  const [, view = 'market', arg] = (location.hash || '#/market').split('/');
  return { view, arg: arg && decodeURIComponent(arg) };
}
window.addEventListener('hashchange', () => { $('#modal-root [data-close]')?.click(); render(); scrollTo(0, 0); });

/* ---------------- запуск ---------------- */

async function boot() {
  store = await createStore();
  const res = await store.init();
  S.user = res.user;
  S.group = res.group;
  if (!S.user) return renderLogin();
  if (!S.group) return renderGroupPicker(res.error);
  enter();
}

// Войти в группу или ждать, пока создатель примет заявку.
function enter() {
  if (S.group.approved) return subscribe();
  renderPending();
  const un = store.watchMyMembership(st => {
    if (st === 'approved') { un(); S.group.approved = true; subscribe(); render(); }
    if (st === 'rejected') { un(); store.leaveGroup(); S.group = null; renderGroupPicker('Создатель группы отклонил заявку.'); }
  });
}

function renderPending() {
  $('#app').innerHTML = `<div class="login panel pad">
    <div class="logo"><i class="ti ti-hourglass"></i></div>
    <h2 style="font-size:18px">Заявка отправлена</h2>
    <p class="muted">Группа «${esc(S.group.name)}». Как только создатель группы примет заявку, откроется таблица. Эту страницу можно не закрывать.</p>
    <button class="btn ghost block" data-act="signout">Выйти</button>
  </div>`;
}

const approved = () => S.members.filter(m => m.approved !== false);
const pending = () => S.members.filter(m => m.approved === false);
const isOwner = () => S.group && S.group.owner === S.user.uid;

function subscribe() {
  unsubs.forEach(u => u());
  unsubs = [
    store.watchGroup(g => { S.group = { ...g, approved: true }; render(); }),
    store.watchMembers(m => { S.members = m; render(); }),
    store.watchAssets(a => { S.assets = a; checkAlerts(); render(); }),
    store.watchIndices(i => { S.indices = i; render(); }),
    store.watchTrades(t => { S.trades = t; render(); }),
    store.watchAlerts(a => { S.alerts = a; checkAlerts(); render(); }),
  ];
  setInterval(render, 60e3); // «N мин назад» и онлайн
}

/* ---------------- каркас ---------------- */

function render() {
  if (!S.user || !S.group || !S.group.approved) return;
  const r = route();
  if (r.view === 'asset') ensureHistory(r.arg); else ensureHistory(null);
  const views = { market: viewMarket, asset: viewAsset, portfolio: viewPortfolio, group: viewGroup };
  const body = (views[r.view] || viewMarket)(r.arg);
  const nav = r.view === 'asset' ? 'market' : r.view;
  const req = isOwner() && pending().length ? ` <span class="badge">${pending().length}</span>` : '';
  const tab = (v, label) => `<a class="tab ${nav === v ? 'on' : ''}" href="#/${v}">${label}${v === 'group' ? req : ''}</a>`;
  const bn = (v, label, icon) => `<a class="${nav === v ? 'on' : ''}" href="#/${v}"><i class="ti ti-${icon}"></i>${label}${v === 'group' ? req : ''}</a>`;
  $('#app').innerHTML = `
  <div class="shell">
    ${DEMO ? `<div class="banner"><span><i class="ti ti-info-circle"></i> Демо-режим: данные только в этом браузере, друзья их не видят. Для общей таблицы подключи Firebase (см. README).</span><button class="btn ghost small" data-act="reset-demo">Сбросить демо</button></div>` : ''}
    <div class="topbar">
      <div class="brand">
        <div class="logo"><i class="ti ti-chart-line"></i></div>
        <div style="min-width:0">
          <h1>Общая биржа</h1>
          <div class="sub">${esc(S.group.name)} · ${membersLine()}</div>
        </div>
      </div>
      <div class="actions">
        <button class="btn" data-act="manual"><i class="ti ti-edit"></i><span class="lbl">Внести цены</span></button>
        <button class="btn primary" data-act="scan"><i class="ti ti-scan"></i><span class="lbl">Распознать скриншот</span></button>
      </div>
    </div>
    <nav class="tabs">${tab('market', 'Рынок')}${tab('portfolio', 'Мой портфель')}${tab('group', 'Группа')}</nav>
    ${body}
  </div>
  <nav class="bottomnav">${bn('market', 'Рынок', 'chart-candle')}${bn('portfolio', 'Портфель', 'wallet')}${bn('group', 'Группа', 'users')}</nav>`;
  if (r.view === 'asset') mountChart();
}

function online(m) { return Date.now() - (m.lastSeen || 0) < 3 * 60e3; }

function membersLine() {
  const on = approved().filter(online).length;
  return `<span class="up">● ${on} онлайн</span> из ${approved().length}`;
}

/* ---------------- рынок ---------------- */

function viewMarket() {
  const econ = S.group.economy;
  const idx = [...S.indices].sort((a, b) => (a.order ?? 9) - (b.order ?? 9) || a.code.localeCompare(b.code));
  let list = [...S.assets];
  if (S.filter === 'stock') list = list.filter(a => a.type !== 'crypto');
  if (S.filter === 'crypto') list = list.filter(a => a.type === 'crypto');
  if (S.filter === 'fav') list = list.filter(a => S.favs.has(a.ticker));
  if (S.filter === 'under') list = list.filter(a => (U.discount(a) ?? 0) > 0).sort((a, b) => U.discount(b) - U.discount(a));
  else list.sort((a, b) => (S.favs.has(b.ticker) - S.favs.has(a.ticker)) || a.ticker.localeCompare(b.ticker));
  const chip = (f, label) => `<button class="chip ${f === 'under' ? 'green' : ''} ${S.filter === f ? 'on' : ''}" data-act="filter" data-f="${f}">${label}</button>`;
  return `
    ${econ || idx.length ? `<div class="econ">
      ${econ ? `<div class="panel"><div class="val ${/пад|спад|кризис/i.test(econ.status || '') ? 'down' : 'up'}"><i class="ti ti-bolt"></i> Экономика${econ.status ? ': ' + esc(econ.status) : ''}</div>
        <div class="lbl">${econ.demand != null ? 'спрос ' + U.pct(econ.demand) : ''}${econ.costs != null ? ' · расходы ' + U.pct(econ.costs) : ''}</div></div>` : ''}
      ${idx.map(i => `<div class="panel"><div class="lbl">${esc(i.code)}</div><div class="val num">${U.plain(i.value)} <span class="small ${U.cls(i.change)}">${U.pct(i.change)}</span></div></div>`).join('')}
    </div>` : ''}
    <div class="chips">${chip('all', 'Все')}${chip('stock', 'Акции')}${chip('crypto', 'Крипто')}${chip('fav', '<i class="ti ti-star"></i> Избранное')}${chip('under', 'Недооценённые')}
      ${isOwner() && list.length && !S.selecting ? '<button class="chip" data-act="select-mode" style="margin-left:auto"><i class="ti ti-checkbox"></i> Выбрать</button>' : ''}</div>
    ${S.selecting ? `<div class="banner" style="background:var(--panel2);color:var(--text)">
      <span>Выбрано: ${S.sel.size}</span>
      <span style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn" data-act="select-all">${list.every(a => S.sel.has(a.ticker)) ? 'Снять все' : 'Выбрать все'}</button>
        <button class="btn danger" data-act="delete-selected"><i class="ti ti-trash"></i>Удалить</button>
        <button class="btn ghost" data-act="select-cancel">Отмена</button>
      </span></div>` : ''}
    <div class="panel market">
      <div class="row head"><span>Актив</span><span>Цена</span><span>Изм.</span><span>Фунд. цена</span><span>Тренд</span><span>Обновил</span><span></span></div>
      ${list.length ? list.map(assetRow).join('') : `<div class="empty">${S.filter === 'under' ? 'Нет акций дешевле фундаментальной цены.' : 'Здесь пока пусто. Распознай скриншот биржи или внеси цены вручную.'}</div>`}
    </div>`;
}

function tileFor(a, lg) {
  const short = /^NC/.test(a.ticker) ? 'NC' : (a.name || a.ticker || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div class="tile ${a.type === 'crypto' ? 'crypto' : ''} ${lg ? 'lg' : ''}">${esc(short)}</div>`;
}

function assetRow(a) {
  const d = U.discount(a);
  const alert = S.alerts[a.ticker];
  const hit = alertHit(a, alert);
  const stale = a.updatedAt && Date.now() - a.updatedAt > U.STALE_MS;
  const sel = S.selecting && S.sel.has(a.ticker);
  return `<div class="row ${sel ? 'selected' : hit ? 'alerted' : d > 0 ? 'under' : ''}" data-act="${S.selecting ? 'toggle-sel' : 'open'}" data-t="${esc(a.ticker)}">
    <div class="asset-name">${tileFor(a)}<div style="min-width:0"><div class="t">${esc(a.name)}</div><div class="s">${esc(a.ticker)} · ${a.type === 'crypto' ? 'Крипто' : 'Акции'} ${S.favs.has(a.ticker) ? '<i class="ti ti-star warn"></i>' : ''}${alert ? '<i class="ti ti-bell warn"></i>' : ''}</div></div></div>
    <div class="price num c-price">${U.money(a.price)}</div>
    <div class="num c-change ${U.cls(a.change)}">${U.pct(a.change)}</div>
    <div class="num c-fund">${a.fundamental ? U.money(a.fundamental) + `<div class="small ${d > 0 ? 'up' : 'muted'}">${d > 0 ? 'ниже на ' + U.pct(d, false) : 'выше на ' + U.pct(-d, false)}</div>` : '<span class="muted">—</span>'}</div>
    <div class="c-spark">${spark(a.spark)}</div>
    <div class="small c-who ${hit ? 'warn' : stale ? 'warn' : 'muted'}">${hit ? hitText(alert, a) : a.updatedAt ? esc(a.updatedBy) + ' · ' + U.ago(a.updatedAt) + (stale ? ' · устарело' : '') : 'нет цены'}</div>
    ${S.selecting
      ? `<span class="star c-star sel-box ${sel ? 'on' : ''}"><i class="ti ti-${sel ? 'square-check' : 'square'}"></i></span>`
      : `<button class="star c-star ${S.favs.has(a.ticker) ? 'on' : ''}" data-act="fav" data-t="${esc(a.ticker)}" aria-label="В избранное"><i class="ti ti-star"></i></button>`}
  </div>`;
}

function spark(pts, w = 90, h = 26) {
  if (!pts || pts.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const xy = pts.map((p, i) => `${(i / (pts.length - 1) * w).toFixed(1)},${(h - 3 - (p - min) / span * (h - 6)).toFixed(1)}`).join(' ');
  const c = pts[pts.length - 1] > pts[0] ? 'var(--green)' : pts[pts.length - 1] < pts[0] ? 'var(--red)' : 'var(--muted)';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${c}" stroke-width="1.6" points="${xy}"/></svg>`;
}

/* ---------------- карточка актива ---------------- */

function ensureHistory(t) {
  if (t === histTicker) return;
  histUnsub && histUnsub();
  histUnsub = null; histTicker = t; S.history = [];
  if (t) histUnsub = store.watchHistory(t, h => { S.history = h; if (histTicker === t) render(); });
}

const RANGES = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, all: Infinity };

function viewAsset(t) {
  const a = S.assets.find(x => x.ticker === t);
  if (!a) return `<a class="btn back" href="#/market"><i class="ti ti-arrow-left"></i>Назад</a><div class="empty">Актив ${esc(t)} не найден.</div>`;
  const d = U.discount(a);
  const pf = U.buildPortfolio(S.trades.filter(x => x.ticker === t), S.assets);
  const my = pf.positions[0];
  const alert = S.alerts[t];
  const dv = a.dividend;
  const rb = k => `<button class="chip ${S.range === k ? 'on' : ''}" data-act="range" data-r="${k}">${{ '1h': '1ч', '24h': '24ч', '7d': '7д', all: 'всё' }[k]}</button>`;
  return `
  <a class="btn back" href="#/market"><i class="ti ti-arrow-left"></i>Рынок</a>
  <div class="grid2">
    <div>
      <div class="panel pad">
        <div class="asset-head">
          <div class="asset-name">${tileFor(a, true)}<div><div class="muted small">${esc(a.ticker)} · ${a.type === 'crypto' ? 'Крипто' : 'Акции'}</div><div style="font-size:20px;font-weight:700">${esc(a.name)}</div></div></div>
          <div><div class="big num">${U.money(a.price)}</div><div class="${U.cls(a.change)} num" style="text-align:right">${U.pct(a.change)}</div></div>
        </div>
        <div class="chips" style="margin:12px 0 0">${rb('1h')}${rb('24h')}${rb('7d')}${rb('all')}</div>
        <div class="chart" id="chart"></div>
        <div class="stats">
          <div class="stat"><div class="lbl">Фундаментальная цена</div><div class="val num">${U.money(a.fundamental)}</div>${d != null ? `<div class="small ${d > 0 ? 'up' : 'muted'}">${d > 0 ? 'рынок ниже на ' + U.pct(d, false) : 'рынок выше на ' + U.pct(-d, false)}</div>` : ''}</div>
          <div class="stat"><div class="lbl">Выручка</div><div class="val num">${U.compact(a.revenue)}</div></div>
          <div class="stat"><div class="lbl">Чистая прибыль</div><div class="val num ${U.cls(a.profit)}">${U.compact(a.profit)}</div></div>
          <div class="stat"><div class="lbl">Капитал компании</div><div class="val num">${U.compact(a.capital)}</div></div>
        </div>
        ${dv ? `<div class="dividend"><div class="up"><i class="ti ti-coins"></i> Отчёт №${esc(dv.report ?? '—')} · дивиденды ${U.money(dv.perShare)} на акцию</div>${dv.next ? `<div class="small muted">Следующий отчёт №${esc(dv.next)}</div>` : ''}</div>` : ''}
        <button class="btn block fav-btn ${S.favs.has(t) ? 'on' : ''}" style="margin-top:12px" data-act="fav" data-t="${esc(t)}">
          <i class="ti ti-star"></i>${S.favs.has(t) ? 'В избранном — убрать' : 'Добавить в избранное'}</button>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button class="btn" data-act="price-one" data-t="${esc(t)}"><i class="ti ti-edit"></i>Новая цена</button>
          <button class="btn" data-act="edit-asset" data-t="${esc(t)}"><i class="ti ti-building"></i>Данные компании</button>
          ${isOwner() ? `<button class="btn danger" data-act="delete-asset" data-t="${esc(t)}"><i class="ti ti-trash"></i>Удалить</button>` : ''}
        </div>
      </div>
    </div>
    <div>
      <div class="panel pad">
        <h2>Моя позиция</h2>
        ${my ? `<div class="stats" style="margin-top:0">
            <div class="stat"><div class="lbl">Акций</div><div class="val num">${U.plain(my.qty, 0)}</div></div>
            <div class="stat"><div class="lbl">Средняя цена</div><div class="val num">${U.money(my.avg)}</div></div>
            <div class="stat"><div class="lbl">Стоимость</div><div class="val num">${U.money(my.value)}</div></div>
            <div class="stat"><div class="lbl">Прибыль</div><div class="val num ${U.cls(my.unreal)}">${U.money(my.unreal)}<div class="small">${U.pct(my.unrealPct)}</div></div></div>
          </div>` : `<div class="muted small">У тебя нет этой ${a.type === 'crypto' ? 'монеты' : 'акции'}.</div>`}
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn primary" data-act="trade" data-t="${esc(t)}" data-side="buy">Купил</button>
          <button class="btn" data-act="trade" data-t="${esc(t)}" data-side="sell">Продал</button>
          <button class="btn" data-act="trade" data-t="${esc(t)}" data-side="div">Дивиденды</button>
        </div>
      </div>
      <div class="panel pad" style="margin-top:14px">
        <h2>Сигнал</h2>
        ${alert ? `<div class="small">${alert.below ? 'Цена ниже ' + U.money(alert.below) : ''}${alert.below && alert.above ? ' или ' : ''}${alert.above ? 'выше ' + U.money(alert.above) : ''}</div>` : '<div class="muted small">Сообщу, когда цена пересечёт нужный уровень. Сигналы личные, их видишь только ты.</div>'}
        <button class="btn" style="margin-top:10px" data-act="alert" data-t="${esc(t)}"><i class="ti ti-bell"></i>${alert ? 'Изменить' : 'Настроить'}</button>
      </div>
      <div class="panel pad list" style="margin-top:14px">
        <h2>История цен</h2>
        ${S.history.slice(0, 30).map(h => `<div class="item">
          <span class="num" style="font-weight:600">${U.money(h.price)}</span>
          <span class="small muted" style="flex:1;text-align:right">${esc(h.name)} · ${h.source === 'screenshot' ? '<i class="ti ti-scan"></i>' : '<i class="ti ti-pencil"></i>'} ${U.dateTime(h.at)}</span>
          ${h.uid === S.user.uid || S.group.owner === S.user.uid ? `<button class="btn icon ghost" data-act="del-hist" data-t="${esc(t)}" data-id="${esc(h.id)}" aria-label="Удалить"><i class="ti ti-trash"></i></button>` : ''}
        </div>`).join('') || '<div class="muted small">Цен пока нет.</div>'}
      </div>
    </div>
  </div>`;
}

function mountChart() {
  const box = $('#chart');
  if (!box) return;
  const a = S.assets.find(x => x.ticker === route().arg);
  const from = Date.now() - RANGES[S.range];
  let pts = S.history.filter(h => h.at >= from).sort((x, y) => x.at - y.at);
  if (pts.length < 2) {
    box.innerHTML = `<div class="empty">Для графика нужно хотя бы две цены за этот период.</div>`;
    return;
  }
  const W = box.clientWidth || 600, H = box.clientHeight || 260, P = { l: 4, r: 4, t: 18, b: 22 };
  const vals = pts.map(p => p.price);
  if (a && a.fundamental) vals.push(a.fundamental);
  let min = Math.min(...vals), max = Math.max(...vals);
  const padV = (max - min) * 0.08 || max * 0.02;
  min -= padV; max += padV;
  const t0 = pts[0].at, t1 = pts[pts.length - 1].at, tspan = t1 - t0 || 1;
  const X = t => P.l + (t - t0) / tspan * (W - P.l - P.r);
  const Y = v => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const line = pts.map(p => `${X(p.at).toFixed(1)},${Y(p.price).toFixed(1)}`).join(' ');
  const up = pts[pts.length - 1].price >= pts[0].price;
  const col = up ? 'var(--green)' : 'var(--red)';
  const fy = a && a.fundamental ? Y(a.fundamental) : null;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <polygon fill="${col}" fill-opacity=".12" points="${X(t0)},${H - P.b} ${line} ${X(t1)},${H - P.b}"/>
    <polyline fill="none" stroke="${col}" stroke-width="2" points="${line}"/>
    ${fy != null ? `<line x1="0" x2="${W}" y1="${fy}" y2="${fy}" stroke="var(--blue-soft)" stroke-dasharray="5 5"/><text x="6" y="${fy - 6}" fill="var(--blue-soft)" font-size="11">фундаментальная ${U.money(a.fundamental)}</text>` : ''}
    <text x="${W - 4}" y="12" text-anchor="end" fill="var(--muted)" font-size="11">${U.money(Math.max(...pts.map(p => p.price)))}</text>
    <text x="${W - 4}" y="${H - 6}" text-anchor="end" fill="var(--muted)" font-size="11">${U.money(Math.min(...pts.map(p => p.price)))}</text>
    <text x="4" y="${H - 6}" fill="var(--muted)" font-size="11">${U.dateTime(t0)}</text>
    <line id="cx" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" stroke="var(--line2)" visibility="hidden"/>
    <circle id="cd" r="4" fill="${col}" visibility="hidden"/>
  </svg><div class="tip hidden"></div>`;
  const svg = box.querySelector('svg'), tip = box.querySelector('.tip'), cx = box.querySelector('#cx'), cd = box.querySelector('#cd');
  const move = e => {
    const r = svg.getBoundingClientRect();
    const x = ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(X(p.at) - x) < Math.abs(X(best.at) - x)) best = p;
    const bx = X(best.at), by = Y(best.price);
    cx.setAttribute('x1', bx); cx.setAttribute('x2', bx); cx.setAttribute('visibility', 'visible');
    cd.setAttribute('cx', bx); cd.setAttribute('cy', by); cd.setAttribute('visibility', 'visible');
    tip.classList.remove('hidden');
    tip.style.left = Math.min(Math.max(bx / W * r.width, 70), r.width - 70) + 'px';
    tip.innerHTML = `<b>${U.money(best.price)}</b> <span class="muted">${esc(best.name)} · ${U.dateTime(best.at)}</span>`;
  };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('touchmove', move, { passive: true });
  svg.addEventListener('mouseleave', () => { tip.classList.add('hidden'); cx.setAttribute('visibility', 'hidden'); cd.setAttribute('visibility', 'hidden'); });
}

/* ---------------- портфель ---------------- */

function viewPortfolio() {
  const pf = U.buildPortfolio(S.trades, S.assets);
  const colors = ['#5b6cff', '#3fdca0', '#f2b84b', '#ff6b7a', '#8fa0ff', '#b8742a', '#2fb5c9'];
  const card = (lbl, val, sub, c = '') => `<div class="panel"><div class="lbl">${lbl}</div><div class="val num ${c}">${val}</div>${sub ? `<div class="small ${c || 'muted'}">${sub}</div>` : ''}</div>`;
  const sideTxt = { buy: '<span class="up">Покупка</span>', sell: '<span class="down">Продажа</span>', div: '<span class="warn">Дивиденды</span>' };
  return `
  <div class="topbar" style="margin-bottom:10px"><h2 style="margin:0">Мой портфель <span class="muted small" style="font-weight:500">· видишь только ты</span></h2>
    <button class="btn primary" data-act="trade"><i class="ti ti-plus"></i>Добавить сделку</button></div>
  <div class="summary">
    ${card('Стоимость портфеля', U.money(pf.value), `${pf.positions.length} позиц.`)}
    ${card('Вложено в открытые', U.money(pf.cost))}
    ${card('Прибыль сейчас', U.money(pf.unreal), U.pct(pf.unrealPct), U.cls(pf.unreal))}
    ${card('Зафиксировано', U.money(pf.realized + pf.dividends), `продажи ${U.money(pf.realized)} · дивиденды ${U.money(pf.dividends)}`, U.cls(pf.realized + pf.dividends))}
    ${card('Итого заработано', U.money(pf.total), `комиссии ${U.money(pf.fees)}`, U.cls(pf.total))}
  </div>
  ${pf.positions.length ? `<div class="alloc">${pf.positions.map((p, i) => `<div title="${esc(p.ticker)}" style="width:${(p.value || 0) / (pf.value || 1) * 100}%;background:${colors[i % colors.length]}"></div>`).join('')}</div>` : ''}
  <div class="panel positions">
    <div class="row head"><span>Актив</span><span>Кол-во</span><span>Средняя</span><span>Текущая</span><span>Стоимость</span><span>Прибыль</span></div>
    ${pf.positions.map((p, i) => `<div class="row" data-act="open" data-t="${esc(p.ticker)}">
      <div class="asset-name"><span style="width:4px;height:30px;border-radius:2px;background:${colors[i % colors.length]}"></span>${tileFor(p.asset || { ticker: p.ticker })}<div style="min-width:0"><div class="t">${esc(p.asset ? p.asset.name : p.ticker)}</div><div class="s">${esc(p.ticker)} · ${U.plain(p.qty, 0)} шт.</div></div></div>
      <div class="num c-hide">${U.plain(p.qty, 0)}</div>
      <div class="num c-hide">${U.money(p.avg)}</div>
      <div class="num c-hide">${U.money(p.price)}</div>
      <div class="num c-hide">${U.money(p.value)}</div>
      <div class="num ${U.cls(p.unreal)}" style="text-align:right">${U.money(p.unreal)}<div class="small">${U.pct(p.unrealPct)}</div></div>
    </div>`).join('') || '<div class="empty">Открытых позиций нет. Добавь первую покупку.</div>'}
  </div>
  <div class="panel pad list" style="margin-top:14px">
    <h2>Мои сделки</h2>
    ${S.trades.map(t => {
      const sum = t.side === 'div' ? (t.amount ?? t.qty * t.price) : t.qty * t.price;
      return `<div class="item">
        <span style="flex:1;min-width:0"><b>${esc(t.ticker)}</b> · ${sideTxt[t.side]}<div class="small muted">${U.dateTime(t.at)}${t.side !== 'div' ? ` · ${U.plain(t.qty, 0)} × ${U.money(t.price)}${t.fee ? ' · комиссия ' + U.money(t.fee) : ''}` : ''}</div></span>
        <span class="num ${t.side === 'buy' ? '' : 'up'}">${t.side === 'buy' ? '−' : '+'}${U.money(sum)}</span>
        <button class="btn icon ghost" data-act="del-trade" data-id="${esc(t.id)}" aria-label="Удалить"><i class="ti ti-trash"></i></button>
      </div>`;
    }).join('') || '<div class="muted small">Сделок пока нет.</div>'}
  </div>`;
}

/* ---------------- группа ---------------- */

function viewGroup() {
  const me = S.members.find(m => m.uid === S.user.uid);
  const av = m => `<span class="avatar ${online(m) ? 'on' : ''}">${esc((m.name || '?')[0].toUpperCase())}</span>`;
  const reqs = isOwner() ? pending() : [];
  return `
  <div class="grid2" style="margin-top:0">
    <div>
      ${reqs.length ? `<div class="panel pad list" style="margin-bottom:14px;border-color:var(--yellow)">
        <h2>Заявки на вступление</h2>
        ${reqs.map(m => `<div class="item">
          <span style="display:flex;align-items:center;gap:10px">${av(m)}<span>${esc(m.name)}<div class="small muted">${U.ago(m.requestedAt || m.lastSeen)} назад</div></span></span>
          <span style="display:flex;gap:6px"><button class="btn primary" data-act="approve" data-uid="${esc(m.uid)}">Принять</button><button class="btn danger" data-act="remove" data-uid="${esc(m.uid)}" data-name="${esc(m.name)}">Отклонить</button></span>
        </div>`).join('')}
      </div>` : ''}
      <div class="panel pad list">
        <h2>Участники</h2>
        ${approved().sort((a, b) => online(b) - online(a)).map(m => `<div class="item">
          <span style="display:flex;align-items:center;gap:10px">${av(m)}${esc(m.name)}${m.uid === S.user.uid ? ' <span class="muted small">(ты)</span>' : ''}${m.uid === S.group.owner ? ' <span class="muted small">· создатель</span>' : ''}</span>
          <span style="display:flex;gap:6px;align-items:center"><span class="small ${online(m) ? 'up' : 'muted'}">${online(m) ? 'онлайн' : 'был ' + U.ago(m.lastSeen) + ' назад'}</span>
          ${isOwner() && m.uid !== S.user.uid ? `<button class="btn icon ghost" data-act="remove" data-uid="${esc(m.uid)}" data-name="${esc(m.name)}" aria-label="Исключить"><i class="ti ti-user-minus"></i></button>` : ''}</span>
        </div>`).join('')}
      </div>
    </div>
    <div>
      <div class="panel pad">
        <h2>Пригласить друзей</h2>
        <div class="hint" style="margin-bottom:10px">Отправь ссылку другу. Он войдёт через Google и отправит заявку, а ${isOwner() ? 'ты примешь её здесь' : 'создатель группы её примет'}. Пока заявку не приняли, человек не видит ни цен, ни участников. Портфель у каждого свой.</div>
        <div style="display:flex;gap:8px"><input class="input" readonly value="${esc(store.inviteLink())}" id="invite"><button class="btn" data-act="copy-invite"><i class="ti ti-copy"></i></button></div>
      </div>
      <div class="panel pad" style="margin-top:14px">
        <h2>Мой профиль</h2>
        <div class="field"><label>Ник в таблице</label><div style="display:flex;gap:8px"><input class="input" id="myname" value="${esc(me ? me.name : S.user.name)}" maxlength="24"><button class="btn" data-act="rename">Сохранить</button></div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" data-act="notify"><i class="ti ti-bell"></i>Уведомления</button>
          ${DEMO ? '' : '<button class="btn" data-act="signout"><i class="ti ti-logout"></i>Выйти из аккаунта</button>'}
        </div>
      </div>
      <div class="panel pad" style="margin-top:14px;border-color:#4a2330">
        <h2>${isOwner() ? 'Удалить группу' : 'Выйти из группы'}</h2>
        <div class="hint" style="margin-bottom:10px">${isOwner()
          ? 'Удалятся все активы, история цен и индексы группы, а участники потеряют к ней доступ. Портфели участников останутся у них. Вернуть нельзя.'
          : 'Ты перестанешь видеть общую таблицу. Чтобы вернуться, понадобится новая заявка.'}</div>
        <button class="btn danger" data-act="${isOwner() ? 'delete-group' : 'exit-group'}"><i class="ti ti-${isOwner() ? 'trash' : 'door-exit'}"></i>${isOwner() ? 'Удалить группу' : 'Выйти из группы'}</button>
      </div>
    </div>
  </div>`;
}

function openDeleteGroup() {
  const close = modal('Удалить группу', `
    <div class="hint" style="margin-bottom:12px">Это удалит группу «${esc(S.group.name)}» у всех участников вместе с ценами и историей. Чтобы подтвердить, впиши её название.</div>
    <div class="field"><input class="input" id="dg-name" placeholder="${esc(S.group.name)}"></div>
    <button class="btn danger block" data-del>Удалить навсегда</button>`);
  close.el.querySelector('[data-del]').addEventListener('click', async e => {
    const inp = $('#dg-name', close.el);
    if (inp.value.trim() !== S.group.name) return fieldErr(inp, 'Название не совпадает');
    e.target.disabled = true;
    e.target.textContent = 'Удаляю…';
    try {
      unsubs.forEach(u => u()); unsubs = [];
      await store.deleteGroup();
      close();
      if (DEMO) return location.reload();
      S.group = null;
      history.replaceState(null, '', location.pathname);
      renderGroupPicker();
      toast('Группа удалена');
    } catch (err) {
      console.error(err);
      e.target.disabled = false;
      e.target.textContent = 'Удалить навсегда';
      fieldErr(inp, 'Не получилось: ' + (err.message || err));
    }
  });
}

/* ---------------- вход и выбор группы ---------------- */

function renderLogin(err, mode = 'in') {
  const up = mode === 'up';
  $('#app').innerHTML = `<div class="login panel pad">
    <div class="logo"><i class="ti ti-chart-line"></i></div>
    <h2 style="font-size:20px">Общая биржа</h2>
    <p class="muted">Общая таблица цен NC Exchange для тебя и друзей. Войди, чтобы видеть цены и свой портфель.</p>
    <form id="login-form" style="text-align:left" novalidate>
      <div class="field"><label>Логин</label><input class="input" id="l-login" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="20" placeholder="Vlad_Kir"></div>
      <div class="field"><label>Пароль</label><input class="input" id="l-pass" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" placeholder="${up ? 'не короче 6 символов' : ''}"></div>
      ${up ? '<div class="field"><label>Пароль ещё раз</label><input class="input" id="l-pass2" type="password" autocomplete="new-password"></div><div class="hint" style="margin-bottom:10px">Логин — латиница, цифры, _ и -. Запомни пароль: восстановить его без почты нельзя.</div>' : ''}
      <button class="btn primary block" type="submit">${up ? 'Создать аккаунт' : 'Войти'}</button>
    </form>
    <div style="margin-top:10px">
      <button class="btn ghost small" data-act="login-mode" data-mode="${up ? 'in' : 'up'}">${up ? 'Уже есть аккаунт — войти' : 'Нет аккаунта? Создать'}</button>
    </div>
    <div class="err" id="l-err">${esc(err || '')}</div>
    <div class="hint" style="margin:16px 0 8px">или</div>
    <button class="btn block" data-act="signin"><i class="ti ti-brand-google"></i>Войти через Google</button>
    <div class="hint" style="margin-top:8px">На iPhone в Safari вход через Google может не открыться — входи по логину.</div>
  </div>`;
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const login = $('#l-login').value.trim(), pass = $('#l-pass').value;
    if (!LOGIN_RE.test(login)) return fieldErr($('#l-login'), 'Латиница, цифры, _ и -, от 3 до 20 символов');
    if (pass.length < 6) return fieldErr($('#l-pass'), 'Не короче 6 символов');
    if (up && $('#l-pass2').value !== pass) return fieldErr($('#l-pass2'), 'Пароли не совпадают');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (up) await store.signUpLogin(login, pass); else await store.signInLogin(login, pass);
      location.reload();
    } catch (err) {
      btn.disabled = false;
      $('#l-err').textContent = err.message;
    }
  });
}

function renderGroupPicker(err) {
  $('#app').innerHTML = `<div class="login panel pad" style="text-align:left">
    <h2 style="font-size:18px">Привет, ${esc(S.user.name)}</h2>
    <p class="muted small">Открой ссылку-приглашение от друга или создай свою группу.</p>
    <div class="field"><label>Название группы</label><input class="input" id="gname" placeholder="Биржа сервера #1" maxlength="40"></div>
    <button class="btn primary block" data-act="create-group">Создать группу</button>
    <div class="field" style="margin-top:16px"><label>Или код из ссылки-приглашения</label><input class="input" id="gcode" placeholder="a7k2m9x4pq3z"></div>
    <button class="btn block" data-act="join-group">Вступить</button>
    <div class="err" id="gerr">${esc(err || '')}</div>
    <button class="btn ghost block" style="margin-top:12px" data-act="signout">Выйти</button>
  </div>`;
}

/* ---------------- сигналы ---------------- */

function alertHit(a, al) {
  if (!al || a.price == null) return false;
  return (al.below && a.price <= al.below) || (al.above && a.price >= al.above);
}
function hitText(al, a) {
  return al.below && a.price <= al.below ? 'ниже ' + U.money(al.below) : 'выше ' + U.money(al.above);
}

function checkAlerts() {
  const seen = lsGet('ncx-notified', {});
  for (const a of S.assets) {
    const al = S.alerts[a.ticker];
    if (!alertHit(a, al) || seen[a.ticker] === a.updatedAt) continue;
    seen[a.ticker] = a.updatedAt;
    const msg = `${a.ticker}: ${U.money(a.price)} — ${hitText(al, a)}`;
    toast('<i class="ti ti-bell"></i> ' + esc(msg), 'alert', 8000);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      navigator.serviceWorker?.ready.then(r => r.showNotification('Сигнал по ' + a.ticker, { body: msg, icon: 'icons/icon-192.png', tag: a.ticker }))
        .catch(() => new Notification('Сигнал по ' + a.ticker, { body: msg }));
    }
  }
  lsSet('ncx-notified', seen);
}

/* ---------------- модальные окна ---------------- */

function toast(html, kind = '', ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = html;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

function modal(title, body, { wide } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${title}</h2><button class="btn icon ghost" data-close aria-label="Закрыть"><i class="ti ti-x"></i></button></div>
    <div class="modal-body">${body}</div></div></div>`;
  const ov = root.firstElementChild;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); close.onclose && close.onclose(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
  const first = ov.querySelector('input:not([type=checkbox]):not([readonly]), select');
  first && setTimeout(() => first.focus(), 30);
  close.el = ov;
  return close;
}

function fieldErr(input, msg) {
  let e = input.parentElement.querySelector('.err');
  if (!e) { e = document.createElement('div'); e.className = 'err'; input.parentElement.append(e); }
  e.textContent = msg;
  input.addEventListener('input', () => e.remove(), { once: true });
}

function sortedAssets() { return [...S.assets].sort((a, b) => a.ticker.localeCompare(b.ticker)); }

function openManual() {
  const close = modal('Внести цены', `
    <div class="hint" style="margin-bottom:10px">Заполни только те, что видишь сейчас. Пустые не изменятся.</div>
    <div class="review">
      ${sortedAssets().map(a => `<div class="r" style="grid-template-columns:minmax(0,1fr) 130px 90px">
        <span><b>${esc(a.ticker)}</b> <span class="muted small">${esc(a.name)}</span><div class="small muted">сейчас ${U.money(a.price)}</div></span>
        <input class="input num" inputmode="decimal" data-t="${esc(a.ticker)}" data-k="price" placeholder="цена">
        <input class="input num" inputmode="decimal" data-t="${esc(a.ticker)}" data-k="change" placeholder="изм. %">
      </div>`).join('')}
    </div>
    <h3>Экономика</h3>
    <div class="row2">
      <select class="input" id="e-status">${['', 'Рост', 'Стабильность', 'Спад', 'Кризис'].map(s => `<option value="${s}" ${(S.group.economy?.status || '') === s ? 'selected' : ''}>${s || 'не менять'}</option>`).join('')}</select>
      <div class="row2"><input class="input num" id="e-dem" inputmode="decimal" placeholder="спрос %"><input class="input num" id="e-cost" inputmode="decimal" placeholder="расходы %"></div>
    </div>
    <h3>Новый актив</h3>
    <div class="row2"><input class="input" id="n-ticker" placeholder="Тикер, например NCBANK" maxlength="10"><input class="input" id="n-name" placeholder="Название"></div>
    <div class="row2" style="margin-top:8px"><select class="input" id="n-type"><option value="stock">Акции</option><option value="crypto">Крипто</option></select><input class="input num" id="n-price" inputmode="decimal" placeholder="Цена"></div>
    <button class="btn primary block" style="margin-top:14px" data-save>Сохранить для всех</button>`);
  close.el.querySelector('[data-save]').addEventListener('click', async () => {
    const items = {};
    let bad = false;
    close.el.querySelectorAll('input[data-t]').forEach(inp => {
      if (!inp.value.trim()) return;
      const v = U.parseNum(inp.value);
      if (v == null || (inp.dataset.k === 'price' && v <= 0)) { fieldErr(inp, 'Не число'); bad = true; return; }
      (items[inp.dataset.t] ||= { ticker: inp.dataset.t })[inp.dataset.k] = v;
    });
    const nt = $('#n-ticker', close.el), np = $('#n-price', close.el);
    if (nt.value.trim()) {
      const ticker = nt.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      const price = np.value.trim() ? U.parseNum(np.value) : null;
      if (!ticker) { fieldErr(nt, 'Латиница и цифры'); bad = true; }
      else if (np.value.trim() && !(price > 0)) { fieldErr(np, 'Не число'); bad = true; }
      else items[ticker] = { ticker, name: $('#n-name', close.el).value.trim() || ticker, type: $('#n-type', close.el).value, price };
    }
    let economy = null;
    const st = $('#e-status', close.el).value;
    for (const [id, k] of [['e-dem', 'demand'], ['e-cost', 'costs']]) {
      const inp = $('#' + id, close.el);
      if (!inp.value.trim()) continue;
      const v = U.parseNum(inp.value);
      if (v == null) { fieldErr(inp, 'Не число'); bad = true; continue; }
      (economy ||= {})[k] = v;
    }
    if (st) (economy ||= {}).status = st;
    if (bad) return;
    const list = Object.values(items).filter(i => i.price != null || !S.assets.some(a => a.ticker === i.ticker));
    if (!list.length && !economy) return toast('Ничего не введено');
    for (const i of list) if (i.price == null) delete i.price;
    await store.saveSnapshot({ assets: list, economy: economy && { ...(S.group.economy || {}), ...economy } }, 'manual');
    close();
    toast(`<i class="ti ti-check up"></i> Сохранено: ${list.length}`);
  });
}

function openPriceOne(t) {
  const a = S.assets.find(x => x.ticker === t);
  const close = modal(`Новая цена · ${esc(t)}`, `
    <div class="field"><label>Цена</label><input class="input bigprice num" inputmode="decimal" id="p" placeholder="${a.price ?? ''}"></div>
    <div class="hint" id="diff">Было ${U.money(a.price)}</div>
    <button class="btn primary block" style="margin-top:14px" data-save>Сохранить для всех</button>`);
  const p = $('#p', close.el);
  p.addEventListener('input', () => {
    const v = U.parseNum(p.value);
    $('#diff', close.el).innerHTML = `Было ${U.money(a.price)}${v && a.price ? ` · <span class="${U.cls(v - a.price)}">${U.pct((v / a.price - 1) * 100)}</span>` : ''}`;
  });
  const save = async () => {
    const v = U.parseNum(p.value);
    if (!(v > 0)) return fieldErr(p, 'Введи цену');
    await store.saveSnapshot({ assets: [{ ticker: t, price: v }] }, 'manual');
    close();
  };
  p.addEventListener('keydown', e => e.key === 'Enter' && save());
  close.el.querySelector('[data-save]').addEventListener('click', save);
}

function openEditAsset(t) {
  const a = S.assets.find(x => x.ticker === t);
  const dv = a.dividend || {};
  const f = (id, label, v) => `<div class="field"><label>${label}</label><input class="input num" inputmode="decimal" id="${id}" value="${v ?? ''}"></div>`;
  const close = modal(`Данные компании · ${esc(t)}`, `
    <div class="row2"><div class="field"><label>Название</label><input class="input" id="e-name" value="${esc(a.name)}"></div>
    <div class="field"><label>Тип</label><select class="input" id="e-type"><option value="stock" ${a.type !== 'crypto' ? 'selected' : ''}>Акции</option><option value="crypto" ${a.type === 'crypto' ? 'selected' : ''}>Крипто</option></select></div></div>
    <div class="row2">${f('e-fund', 'Фундаментальная цена', a.fundamental)}${f('e-rev', 'Выручка', a.revenue)}</div>
    <div class="row2">${f('e-prof', 'Чистая прибыль', a.profit)}${f('e-cap', 'Капитал компании', a.capital)}</div>
    <h3>Дивиденды</h3>
    <div class="row2">${f('e-rep', 'Номер отчёта', dv.report)}${f('e-div', 'На акцию, $', dv.perShare)}</div>
    ${f('e-next', 'Следующий отчёт №', dv.next)}
    <div style="display:flex;gap:8px;justify-content:space-between">
      ${S.group.owner === S.user.uid ? '<button class="btn danger" data-del>Удалить актив</button>' : '<span></span>'}
      <button class="btn primary" data-save>Сохранить</button>
    </div>`);
  const num = id => { const v = $('#' + id, close.el).value; return v.trim() ? U.parseNum(v) : null; };
  close.el.querySelector('[data-save]').addEventListener('click', async () => {
    const item = { ticker: t, name: $('#e-name', close.el).value.trim() || t, type: $('#e-type', close.el).value };
    for (const [id, k] of [['e-fund', 'fundamental'], ['e-rev', 'revenue'], ['e-prof', 'profit'], ['e-cap', 'capital']]) {
      const v = num(id); if (v != null) item[k] = v;
    }
    const rep = num('e-rep'), per = num('e-div'), next = num('e-next');
    if (rep != null || per != null || next != null) item.dividend = { report: rep, perShare: per, next };
    await store.saveSnapshot({ assets: [item] }, 'manual');
    close();
  });
  close.el.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!confirm(`Удалить ${t} у всех участников?`)) return;
    await store.deleteAsset(t);
    close();
    location.hash = '#/market';
  });
}

function openTrade(t, side = 'buy') {
  const assets = sortedAssets();
  if (!assets.length) return toast('Сначала добавь активы');
  t ||= assets[0].ticker;
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  const close = modal('Сделка', `
    <div class="seg"><button data-side="buy" class="buy">Покупка</button><button data-side="sell" class="sell">Продажа</button><button data-side="div">Дивиденды</button></div>
    <div class="field"><label>Актив</label><select class="input" id="t-asset">${assets.map(a => `<option value="${esc(a.ticker)}" ${a.ticker === t ? 'selected' : ''}>${esc(a.ticker)} · ${esc(a.name)}</option>`).join('')}</select></div>
    <div class="row2">
      <div class="field"><label id="t-qty-l">Количество</label><input class="input num" inputmode="numeric" id="t-qty" placeholder="0"></div>
      <div class="field"><label id="t-price-l">Цена за штуку</label><input class="input num" inputmode="decimal" id="t-price"></div>
    </div>
    <div class="row2">
      <div class="field" id="t-fee-f"><label>Комиссия (0,15%)</label><input class="input num" inputmode="decimal" id="t-fee"></div>
      <div class="field"><label>Когда</label><input class="input" type="datetime-local" id="t-at" value="${nowLocal}"></div>
    </div>
    <div class="calc" id="t-calc"></div>
    <button class="btn primary block" data-save>Сохранить</button>
    <div class="hint" style="margin-top:8px;text-align:center">Сделки видишь только ты.</div>`);
  const el = id => $('#' + id, close.el);
  let feeTouched = false;
  const setSide = s => {
    side = s;
    close.el.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.side === s));
    el('t-fee-f').classList.toggle('hidden', s === 'div');
    el('t-qty-l').textContent = s === 'div' ? 'Акций на руках' : 'Количество';
    el('t-price-l').textContent = s === 'div' ? 'Дивиденд на акцию' : 'Цена за штуку';
    fillPrice();
  };
  const fillPrice = () => {
    const a = S.assets.find(x => x.ticker === el('t-asset').value);
    if (side === 'div') {
      el('t-price').value = a?.dividend?.perShare ?? '';
      const pos = U.buildPortfolio(S.trades.filter(x => x.ticker === a.ticker), S.assets).positions[0];
      if (pos && !el('t-qty').value) el('t-qty').value = Math.round(pos.qty);
    } else el('t-price').value = a?.price ?? '';
    calc();
  };
  const calc = () => {
    const q = U.parseNum(el('t-qty').value) || 0, p = U.parseNum(el('t-price').value) || 0;
    if (!feeTouched) el('t-fee').value = side === 'div' || !q ? '' : (q * p * U.COMMISSION).toFixed(2);
    const fee = U.parseNum(el('t-fee').value) || 0;
    const sum = q * p;
    el('t-calc').innerHTML = side === 'div'
      ? `<div><span class="muted">Получено</span><b class="up">${U.money(sum)}</b></div>`
      : `<div><span class="muted">Сумма</span><span>${U.money(sum)}</span></div><div><span class="muted">${side === 'buy' ? 'Списано всего' : 'Получено на руки'}</span><b>${U.money(side === 'buy' ? sum + fee : sum - fee)}</b></div>`;
  };
  close.el.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => setSide(b.dataset.side)));
  el('t-asset').addEventListener('change', fillPrice);
  el('t-qty').addEventListener('input', calc);
  el('t-price').addEventListener('input', calc);
  el('t-fee').addEventListener('input', () => { feeTouched = true; calc(); });
  setSide(side);
  setTimeout(() => el('t-qty').focus(), 40);
  close.el.querySelector('[data-save]').addEventListener('click', async () => {
    const q = U.parseNum(el('t-qty').value), p = U.parseNum(el('t-price').value), fee = U.parseNum(el('t-fee').value) || 0;
    if (!(q > 0)) return fieldErr(el('t-qty'), 'Введи количество');
    if (!(p > 0)) return fieldErr(el('t-price'), 'Введи цену');
    const ticker = el('t-asset').value;
    if (side === 'sell') {
      const pos = U.buildPortfolio(S.trades.filter(x => x.ticker === ticker), S.assets).positions[0];
      if (!pos || pos.qty + 1e-9 < q) return fieldErr(el('t-qty'), `У тебя только ${pos ? U.plain(pos.qty, 0) : 0} шт.`);
    }
    const at = new Date(el('t-at').value).getTime() || Date.now();
    const trade = side === 'div'
      ? { ticker, side, qty: q, price: p, amount: Math.round(q * p * 100) / 100, fee: 0, at }
      : { ticker, side, qty: q, price: p, fee, at };
    await store.addTrade(trade);
    close();
    toast('<i class="ti ti-check up"></i> Сделка добавлена');
  });
}

function openAlert(t) {
  const al = S.alerts[t] || {};
  const a = S.assets.find(x => x.ticker === t);
  const close = modal(`Сигнал · ${esc(t)}`, `
    <div class="hint" style="margin-bottom:12px">Сейчас ${U.money(a.price)}. Когда кто-то внесёт цену за уровнем, придёт уведомление.</div>
    <div class="row2">
      <div class="field"><label>Цена ниже</label><input class="input num" inputmode="decimal" id="a-below" value="${al.below ?? ''}"></div>
      <div class="field"><label>Цена выше</label><input class="input num" inputmode="decimal" id="a-above" value="${al.above ?? ''}"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:space-between">
      ${S.alerts[t] ? '<button class="btn danger" data-del>Убрать</button>' : '<span></span>'}
      <button class="btn primary" data-save>Сохранить</button>
    </div>`);
  close.el.querySelector('[data-save]').addEventListener('click', async () => {
    const bi = $('#a-below', close.el), ai = $('#a-above', close.el);
    const below = bi.value.trim() ? U.parseNum(bi.value) : null;
    const above = ai.value.trim() ? U.parseNum(ai.value) : null;
    if (bi.value.trim() && !(below > 0)) return fieldErr(bi, 'Не число');
    if (ai.value.trim() && !(above > 0)) return fieldErr(ai, 'Не число');
    if (below == null && above == null) return fieldErr(bi, 'Укажи хотя бы один уровень');
    await store.saveAlert(t, { below, above });
    askNotify();
    close();
  });
  close.el.querySelector('[data-del]')?.addEventListener('click', async () => { await store.saveAlert(t, null); close(); });
}

function askNotify() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

/* ---------------- распознавание ---------------- */

function openScan(file) {
  const close = modal('Распознать скриншот', `
    <div id="scan-step">
      <label class="drop" id="drop"><i class="ti ti-photo-up"></i><b>Выбери скриншот планшета</b><div class="small">или перетащи сюда, или вставь Ctrl+V</div>
        <input type="file" accept="image/*" id="file" hidden></label>
      <div class="hint" style="margin-top:10px">Открой в игре вкладку «Рынок» на NC Exchange и сделай скриншот (F12 в Steam, Win+Shift+S или фото экрана телефоном). Распознавание идёт на твоём устройстве.</div>
    </div>`, { wide: true });
  const drop = $('#drop', close.el);
  const onPaste = e => {
    const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
    if (f) run(f);
  };
  document.addEventListener('paste', onPaste);
  close.onclose = () => document.removeEventListener('paste', onPaste);
  $('#file', close.el).addEventListener('change', e => e.target.files[0] && run(e.target.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; f && run(f); });
  if (file) run(file);

  async function run(f) {
    const url = URL.createObjectURL(f);
    const step = $('#scan-step', close.el);
    step.innerHTML = `<img class="preview-img" src="${url}" alt=""><div class="small" id="st">Загружаю распознавание…</div><div class="progress"><div id="pb"></div></div>`;
    try {
      const { recognize } = await import('./ocr.js');
      const res = await recognize(f, { assets: S.assets, indices: S.indices }, (msg, p) => {
        const st = $('#st', close.el), pb = $('#pb', close.el);
        if (st) st.textContent = msg;
        if (pb) pb.style.width = Math.round(p * 100) + '%';
      });
      showReview(step, url, res);
    } catch (e) {
      console.error(e);
      step.innerHTML = `<img class="preview-img" src="${url}" alt=""><div class="err">Не получилось распознать: ${esc(e.message)}. Проверь интернет: при первом запуске скачивается модель (около 10 МБ).</div>`;
    }
  }

  function showReview(step, url, res) {
    const known = Object.fromEntries(S.assets.map(a => [a.ticker, a]));
    if (!res.assets.length && !res.indices.length) {
      step.innerHTML = `<img class="preview-img" src="${url}" alt=""><div class="err">Цены на скриншоте не найдены. Нужен скриншот вкладки «Рынок» с открытым планшетом, лучше без обрезки.</div>
        <details style="margin-top:10px"><summary class="small muted">Что увидело распознавание</summary><pre class="small muted" style="white-space:pre-wrap">${esc(res.text)}</pre></details>`;
      return;
    }
    const chk = '<i class="ti ti-alert-triangle"></i>';
    const rowA = (a, i) => {
      const old = known[a.ticker];
      const bad = k => (a.unsure || []).includes(k) ? ' style="border-color:var(--yellow)"' : '';
      const warn = !old ? `<span class="warn small">${a.guess ? chk + ' тикер не прочитался, впиши его' : 'новый актив, проверь тикер'}</span>`
        : a.unsure?.includes('price') ? `<span class="warn small">${chk} проверь цену · было ${U.money(old.price)}</span>`
        : `<span class="small muted">было ${U.money(old.price)}</span>`;
      const extra = [a.fundamental && 'фунд. ' + U.money(a.fundamental), a.revenue && 'показатели', a.dividend && 'дивиденды']
        .filter(Boolean).join(' · ') + (['fundamental', 'revenue', 'profit', 'capital'].some(k => a.unsure?.includes(k)) ? ` <span class="warn">${chk} проверь в карточке</span>` : '');
      return `<div class="r"><input type="checkbox" checked data-i="${i}">
        <span style="min-width:0">${old ? `<b>${esc(a.ticker)}</b> <span class="muted small">${esc(old.name)}</span>`
          : `<input class="input" style="width:110px;display:inline-block${a.guess ? ';border-color:var(--yellow)' : ''}" data-i="${i}" data-k="ticker" value="${esc(a.ticker)}"> <span class="muted small">${esc(a.name || '')}</span>`}
          <div>${warn}${extra ? ` <span class="small muted">· ${extra}</span>` : ''}</div>
          <select class="input" data-i="${i}" data-k="type" style="width:auto;padding:3px 8px;margin-top:4px;font-size:12px">
            ${[['stock', 'Акции'], ['crypto', 'Крипто']].map(([v, l]) => `<option value="${v}" ${(a.type || old?.type || res.pageType || 'stock') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></span>
        <input class="input num" inputmode="decimal" data-i="${i}" data-k="price" value="${a.price != null ? U.plain(a.price) : ''}"${bad('price')}>
        <input class="input num" inputmode="decimal" data-i="${i}" data-k="change" value="${a.change != null ? U.plain(a.change) : ''}" placeholder="изм. %"${bad('change')}>
      </div>`;
    };
    const ec = res.economy;
    step.innerHTML = `
      <img class="preview-img" src="${url}" alt="">
      <div class="hint" style="margin-bottom:6px">${res.pageType ? `Похоже на вкладку «${res.pageType === 'crypto' ? 'Крипто' : 'Акции'}». ` : 'Не понял, акции это или крипта — выбери тип у каждого актива. '}Проверь цифры перед сохранением, их можно поправить.</div>
      <div class="review">${res.assets.map(rowA).join('')}
      ${res.indices.map((ix, j) => `<div class="r"><input type="checkbox" ${ix.unsure ? '' : 'checked'} data-ix="${j}">
        <span><b>Индекс ${esc(ix.code)}</b>${ix.unsure ? `<div class="warn small">${chk} проверь</div>` : ''}</span>
        <input class="input num" inputmode="decimal" data-ix="${j}" data-k="value" value="${U.plain(ix.value)}"${ix.unsure ? ' style="border-color:var(--yellow)"' : ''}>
        <input class="input num" inputmode="decimal" data-ix="${j}" data-k="change" value="${ix.change != null ? U.plain(ix.change) : ''}" placeholder="изм. %">
      </div>`).join('')}
      ${ec ? `<div class="r"><input type="checkbox" checked id="ec-on"><span><b>Экономика${ec.status ? ': ' + esc(ec.status) : ''}</b><div class="small muted">${ec.demand != null ? 'спрос ' + U.pct(ec.demand) : ''}${ec.costs != null ? ' · расходы ' + U.pct(ec.costs) : ''}</div></span><span></span><span></span></div>` : ''}
      </div>
      <button class="btn primary block" style="margin-top:14px" data-save>Сохранить для всех</button>
      <details style="margin-top:10px"><summary class="small muted">Распознанный текст</summary><pre class="small muted" style="white-space:pre-wrap">${esc(res.text)}</pre></details>`;
    close.el.querySelector('[data-save]').addEventListener('click', async () => {
      let bad = false;
      const out = [];
      const val = (sel, inp = close.el.querySelector(sel)) => {
        const v = inp.value.trim() ? U.parseNum(inp.value) : null;
        if (inp.value.trim() && v == null) { fieldErr(inp, 'Не число'); bad = true; }
        return v;
      };
      res.assets.forEach((a, i) => {
        if (!close.el.querySelector(`input[type=checkbox][data-i="${i}"]`).checked) return;
        const { unsure, guess, ...item } = a;
        if (known[a.ticker]) delete item.name; // название известной акции не трогаем — OCR его искажает
        item.type = close.el.querySelector(`select[data-i="${i}"][data-k="type"]`).value;
        const ti = close.el.querySelector(`input[data-i="${i}"][data-k="ticker"]`);
        if (ti) {
          item.ticker = ti.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (!item.ticker) { fieldErr(ti, 'Тикер'); bad = true; }
        }
        item.price = val(`input[data-i="${i}"][data-k="price"]`);
        item.change = val(`input[data-i="${i}"][data-k="change"]`);
        if (item.price == null) delete item.price;
        out.push(item);
      });
      const indices = [];
      res.indices.forEach((ix, j) => {
        if (!close.el.querySelector(`input[type=checkbox][data-ix="${j}"]`).checked) return;
        const value = val(`input[data-ix="${j}"][data-k="value"]`);
        if (value != null) indices.push({ code: ix.code, value, change: val(`input[data-ix="${j}"][data-k="change"]`), order: ix.order });
      });
      if (bad) return;
      const snap = { assets: out, indices };
      if ($('#ec-on', close.el)?.checked) {
        snap.economy = { ...(S.group.economy || {}) };
        for (const [k, v] of Object.entries(res.economy)) if (v != null) snap.economy[k] = v;
      }
      await store.saveSnapshot(snap, 'screenshot');
      close();
      toast(`<i class="ti ti-check up"></i> Сохранено: ${out.length} актив(ов)`);
    });
  }
}

/* ---------------- действия ---------------- */

document.addEventListener('click', async e => {
  if (e.target.classList.contains('preview-img')) return window.open(e.target.src, '_blank');
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, t } = el.dataset;
  try {
    switch (act) {
      case 'open': if (!e.target.closest('.star')) location.hash = '#/asset/' + encodeURIComponent(t); break;
      case 'fav':
        e.stopPropagation();
        S.favs.has(t) ? S.favs.delete(t) : S.favs.add(t);
        lsSet('ncx-favs', [...S.favs]); render();
        if (route().view === 'asset') toast(S.favs.has(t) ? '<i class="ti ti-star warn"></i> Добавлено в избранное' : 'Убрано из избранного');
        break;
      case 'filter': S.filter = el.dataset.f; lsSet('ncx-filter', S.filter); render(); break;
      case 'range': S.range = el.dataset.r; render(); break;
      case 'manual': openManual(); break;
      case 'scan': openScan(); break;
      case 'price-one': openPriceOne(t); break;
      case 'edit-asset': openEditAsset(t); break;
      case 'trade': openTrade(t, el.dataset.side); break;
      case 'alert': openAlert(t); break;
      case 'del-trade': if (confirm('Удалить сделку?')) await store.deleteTrade(el.dataset.id); break;
      case 'del-hist': if (confirm('Удалить эту запись цены?')) await store.deleteHistory(t, el.dataset.id); break;
      case 'copy-invite': await navigator.clipboard.writeText(store.inviteLink()); toast('Ссылка скопирована'); break;
      case 'rename': {
        const v = $('#myname').value.trim();
        if (!v) return fieldErr($('#myname'), 'Введи ник');
        await store.renameMe(v); S.user.name = v; toast('Ник сохранён'); break;
      }
      case 'notify':
        if (!('Notification' in window)) return toast('Браузер не поддерживает уведомления');
        toast((await Notification.requestPermission()) === 'granted' ? 'Уведомления включены' : 'Уведомления запрещены в настройках браузера');
        break;
      case 'select-mode': S.selecting = true; S.sel.clear(); render(); break;
      case 'select-cancel': S.selecting = false; S.sel.clear(); render(); break;
      case 'toggle-sel': S.sel.has(t) ? S.sel.delete(t) : S.sel.add(t); render(); break;
      case 'select-all': {
        const shown = [...document.querySelectorAll('.market .row[data-t]')].map(r => r.dataset.t);
        const all = shown.every(x => S.sel.has(x));
        shown.forEach(x => all ? S.sel.delete(x) : S.sel.add(x));
        render(); break;
      }
      case 'delete-selected': {
        if (!S.sel.size) return toast('Ничего не выбрано');
        const list = [...S.sel];
        if (!confirm(`Удалить у всех участников: ${list.join(', ')}? История цен тоже удалится.`)) break;
        for (const x of list) await store.deleteAsset(x);
        S.selecting = false; S.sel.clear(); render();
        toast(`<i class="ti ti-check up"></i> Удалено: ${list.length}`);
        break;
      }
      case 'delete-asset':
        if (!confirm(`Удалить ${t} у всех участников? История цен тоже удалится.`)) break;
        await store.deleteAsset(t);
        location.hash = '#/market';
        toast(`<i class="ti ti-check up"></i> ${esc(t)} удалён`);
        break;
      case 'delete-group': openDeleteGroup(); break;
      case 'exit-group':
        if (!confirm(`Выйти из группы «${S.group.name}»?`)) break;
        unsubs.forEach(u => u()); unsubs = [];
        await store.exitGroup();
        S.group = null; history.replaceState(null, '', location.pathname);
        renderGroupPicker();
        break;
      case 'approve': await store.approveMember(el.dataset.uid); toast('<i class="ti ti-check up"></i> Участник принят'); break;
      case 'remove':
        if (confirm(`Убрать ${el.dataset.name} из группы? Он перестанет видеть общую таблицу.`)) await store.removeMember(el.dataset.uid);
        break;
      case 'reset-demo': if (confirm('Вернуть демо-данные к началу?')) store.reset(); break;
      case 'signin':
        try { await store.signIn(); location.reload(); }
        catch (err) { const e2 = $('#l-err'); if (e2) e2.textContent = err.message; else throw err; }
        break;
      case 'login-mode': renderLogin('', el.dataset.mode); break;
      case 'signout': await store.signOut(); location.reload(); break;
      case 'create-group': {
        const name = $('#gname').value.trim();
        if (!name) return fieldErr($('#gname'), 'Введи название');
        S.group = await store.createGroup(name);
        history.replaceState(null, '', location.pathname);
        enter(); break;
      }
      case 'join-group': {
        const code = $('#gcode').value.trim().replace(/.*[?&]g=/, '');
        if (!code) return fieldErr($('#gcode'), 'Вставь код или ссылку');
        S.group = await store.joinGroup(code);
        enter(); break;
      }
    }
  } catch (err) {
    console.error(err);
    toast('Ошибка: ' + esc(err.message || err));
  }
});

// Вставка скриншота из буфера прямо на главном экране
document.addEventListener('paste', e => {
  if ($('#modal-root').children.length || !S.group) return;
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
  if (f) openScan(f);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch(e => {
  console.error(e);
  $('#app').innerHTML = `<div class="login panel pad"><h2>Не удалось запуститься</h2><div class="err">${esc(e.message)}</div></div>`;
});
