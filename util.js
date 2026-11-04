// Форматирование чисел и расчёт портфеля. Без зависимостей от DOM.

export const COMMISSION = 0.0015; // комиссия биржи NC Exchange, 0,15%

const nf = d => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const nf2 = nf(2);

export function money(n, d = 2) {
  if (n == null || !isFinite(n)) return '—';
  const s = (d === 2 ? nf2 : nf(d)).format(Math.abs(n));
  return (n < 0 ? '−' : '') + '$' + s;
}

export function compact(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return money(n / 1e9, 2).replace(/$/, ' млрд');
  if (a >= 1e6) return money(n / 1e6, 2).replace(/$/, ' млн');
  if (a >= 1e4) return money(n / 1e3, 1).replace(/$/, ' тыс');
  return money(n);
}

export function plain(n, d = 2) {
  return n == null || !isFinite(n) ? '—' : nf(d).format(n);
}

export function pct(n, sign = true) {
  if (n == null || !isFinite(n)) return '—';
  const s = nf2.format(Math.abs(n)) + '%';
  if (!sign) return s;
  return (n > 0 ? '+' : n < 0 ? '−' : '') + s;
}

export function cls(n) {
  return n > 0 ? 'up' : n < 0 ? 'down' : 'muted';
}

// "1 327,86", "$285.98", "−6,9" → число. Последний из ',' '.' считается дробным.
export function parseNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).replace(/[$\s  ]/g, '').replace(/[−–]/g, '-');
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  const dec = Math.max(lc, ld);
  if (dec >= 0) {
    const intPart = s.slice(0, dec).replace(/[.,]/g, '');
    s = intPart + '.' + s.slice(dec + 1);
  }
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

export function ago(at, now = Date.now()) {
  if (!at) return '—';
  const m = Math.round((now - at) / 60e3);
  if (m < 1) return 'сейчас';
  if (m < 60) return m + ' мин';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' ч';
  return Math.round(h / 24) + ' д';
}

export function dateTime(at) {
  return new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export const STALE_MS = 60 * 60e3;

// Насколько рыночная цена ниже фундаментальной (в %), если ниже.
// У крипты фундаментальной цены нет — её «Ценовой ориентир» равен текущей цене.
export const hasFund = a => !!(a && a.type !== 'crypto' && a.fundamental);
export function discount(a) {
  if (!hasFund(a) || !a.price) return null;
  return (1 - a.price / a.fundamental) * 100;
}

// Сделки → позиции. Средняя цена считается с учётом комиссии покупки.
export function buildPortfolio(trades, assets) {
  const byT = Object.fromEntries(assets.map(a => [a.ticker, a]));
  const pos = {};
  let realized = 0, dividends = 0, fees = 0;
  for (const t of [...trades].sort((a, b) => a.at - b.at)) {
    const p = pos[t.ticker] ||= { ticker: t.ticker, qty: 0, cost: 0, realized: 0, dividends: 0, bought: 0 };
    const fee = t.fee || 0;
    if (t.side === 'buy') {
      p.qty += t.qty;
      p.cost += t.qty * t.price + fee;
      p.bought += t.qty * t.price + fee;
      fees += fee;
    } else if (t.side === 'sell') {
      const avg = p.qty ? p.cost / p.qty : 0;
      const q = Math.min(t.qty, p.qty);
      const r = q * t.price - fee - avg * q;
      p.cost -= avg * q;
      p.qty -= q;
      p.realized += r;
      realized += r;
      fees += fee;
    } else if (t.side === 'div') {
      const amt = t.amount ?? (t.qty || 0) * (t.price || 0);
      p.dividends += amt;
      dividends += amt;
    }
  }
  const positions = Object.values(pos).map(p => {
    const a = byT[p.ticker];
    const price = a && a.price != null ? a.price : null;
    const value = price != null ? p.qty * price : null;
    const avg = p.qty > 0 ? p.cost / p.qty : null;
    const unreal = value != null ? value - p.cost : null;
    return { ...p, asset: a, price, value, avg, unreal, unrealPct: unreal != null && p.cost ? unreal / p.cost * 100 : null };
  });
  const open = positions.filter(p => p.qty > 1e-9);
  const value = open.reduce((s, p) => s + (p.value || 0), 0);
  const cost = open.reduce((s, p) => s + p.cost, 0);
  const unreal = value - cost;
  return {
    positions: open.sort((a, b) => (b.value || 0) - (a.value || 0)),
    closed: positions.filter(p => p.qty <= 1e-9 && (p.realized || p.dividends)),
    value, cost, unreal, unrealPct: cost ? unreal / cost * 100 : null,
    realized, dividends, fees, total: unreal + realized + dividends,
  };
}
