// Распознавание скриншота планшета NC Exchange прямо в браузере (Tesseract.js).
// Игру не трогаем: читаем только картинку, которую дал пользователь.

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

let workerPromise = null;
let progressCb = () => {};

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('не загрузился Tesseract'));
    document.head.append(s);
  });
}

async function getWorker() {
  workerPromise ||= (async () => {
    await loadScript(TESSERACT);
    const w = await window.Tesseract.createWorker(['rus', 'eng'], 1, {
      logger: m => {
        const names = { 'loading tesseract core': 'Загружаю движок…', 'loading language traineddata': 'Загружаю модель языка…', 'initializing api': 'Готовлю…', 'recognizing text': 'Распознаю текст…' };
        progressCb(names[m.status] || 'Работаю…', m.progress || 0);
      },
    });
    await w.setParameters({ preserve_interword_spaces: '1' });
    return w;
  })();
  try { return await workerPromise; } catch (e) { workerPromise = null; throw e; }
}

// Светлый текст на тёмном фоне → тёмный на белом, крупнее в 2–3 раза.
async function preprocess(file, opt = {}) {
  const bmp = await createImageBitmap(file);
  const scale = opt.scale || Math.min(3, Math.max(1, 4600 / bmp.width));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    // Синие плашки с тикерами сбивают разметку Tesseract — делаем их фоном.
    if (b > 120 && b > r + 40 && b > gg + 30) { d[i] = d[i + 1] = d[i + 2] = 255; continue; }
    // яркость по максимуму канала: зелёные и красные цифры тоже станут тёмными
    const inv = 255 - Math.max(r, gg, b);
    // серый текст темнее, фон карточек и страницы белый
    const lo = 150, hi = 185;
    const s = opt.raw ? inv : inv <= lo ? inv * 0.4 : inv >= hi ? 255 : lo * 0.4 + (inv - lo) / (hi - lo) * (255 - lo * 0.4);
    d[i] = d[i + 1] = d[i + 2] = Math.min(255, s);
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Два прохода с разной обработкой: что не прочиталось в одном, часто читается в другом.
export async function recognize(file, known = {}, onProgress = () => {}) {
  const w = await getWorker();
  const passes = [{ raw: false }, { raw: true }];
  const texts = [];
  for (let i = 0; i < passes.length; i++) {
    progressCb = (msg, p) => onProgress(`${msg} (${i + 1}/${passes.length})`, (i + p) / passes.length);
    progressCb('Подготавливаю картинку…', 0);
    const canvas = await preprocess(file, passes[i]);
    const { data } = await w.recognize(canvas);
    texts.push(data.text);
  }
  onProgress('Разбираю цифры…', 1);
  return { ...merge(texts.map(t => parse(t, known.assets)), known), text: texts.join('\n———\n') };
}

/* ---------------- разбор текста ---------------- */

// Число из OCR. exact = был виден дробный разделитель. cents = в этом месте
// у игры всегда два знака после запятой (цены, индексы), так что "28598" → 285,98.
export function readNum(s, cents = true) {
  if (s == null) return null;
  s = String(s).trim().replace(/[  ]/g, ' ');
  let m;
  if ((m = /^(\d[\d ]*)[.,](\d{1,2})$/.exec(s))) return { v: +(m[1].replace(/ /g, '') + '.' + m[2]), exact: true };
  if (cents && (m = /^(\d[\d ]*) (\d{2})$/.exec(s))) return { v: +(m[1].replace(/ /g, '') + '.' + m[2]), exact: false };
  const digits = s.replace(/ /g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (cents && digits.length >= 3) return { v: +digits / 100, exact: false };
  return { v: +digits, exact: !cents };
}

const DOLLAR = /\$\s?(\d+(?:[  ]\d+)*(?:[.,]\d{1,2})?)/g;
const PCT = /([+\-−–*«“‹^])?\s?(\d{1,3}(?:[.,]\d{1,2})?)\s?%/;

function readPct(s) {
  const m = PCT.exec(s || '');
  if (!m) return null;
  const n = readNum(m[2], m[2].length >= 3 && !/[.,]/.test(m[2]));
  if (!n || n.v > 100) return null;
  const sign = m[1] === '+' ? 1 : /[-−–]/.test(m[1] || '') ? -1 : null;
  // знак не прочитался или похож на мусор — значение под сомнением
  return { v: (sign ?? 1) * n.v, exact: n.exact && sign != null };
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');

// Tesseract с русской моделью путает латиницу с похожей кириллицей: РРВОР → PPBOP.
const LOOKALIKE = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I' };
const latin = s => String(s || '').replace(/[АВЕКМНОРСТУХІ]/g, ch => LOOKALIKE[ch]);

// Похожесть строк 0..1 (Левенштейн).
export function similar(a, b) {
  if (!a || !b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}

// Название из строки списка: "|  5 | Pacific Properti.. $472.28" → "Pacific Properti"
function nameFrom(before) {
  const words = before.replace(/[^A-Za-z .&'-]/g, ' ').split(/\s+/).filter(w => /[A-Za-z]{2,}/.test(w));
  while (words.length && !/^[A-Z]/.test(words[0])) words.shift(); // мусор слева от названия
  // хвост из тикера капсом ("NC Fuel NCFUEL") отрезаем
  while (words.length > 1 && /^[A-Z]{3,}$/.test(words[words.length - 1])) words.pop();
  const name = words.join(' ').replace(/\.+$/, '').trim();
  // у настоящих названий есть слово со строчными буквами: "NC Fuel", "All Road"
  return /[A-Z][a-z]{2,}/.test(name) ? name : null;
}

// Найти известный актив по названию (учитывая обрезку "Pacific Properti.." и ошибки OCR).
function matchName(name, known = []) {
  const cand = norm(name);
  if (cand.length < 4) return null;
  let best = null;
  for (const a of known) {
    const n = norm(a.name);
    if (cand === n || cand === norm(a.ticker) || (n.length >= 5 && cand.includes(n))) return a;
    // название в игре обрезается, сравниваем с началом полного
    const s = Math.max(similar(cand, n), cand.length >= 6 ? similar(cand, n.slice(0, cand.length)) : 0);
    if (s >= 0.75 && (!best || s > best.s)) best = { s, a };
  }
  return best && best.a;
}

// Тикер под названием: "PPROP · Акции", "TRIG Arum", "РРВОР О Акция"
function tickerIn(line) {
  const m = /([A-ZА-Я][A-ZА-Я0-9]{1,9})\s*[·•.,:\-—–О0]?\s*(Акци|Акция|Крипт|Akuu|Kpunt|Arum|Axu)/.exec(line || '');
  if (!m) return null;
  const t = latin(m[1]);
  if (!/^[A-Z][A-Z0-9]+$/.test(t)) return null;
  return { ticker: t, type: /крипт|kpunt/i.test(m[2]) ? 'crypto' : 'stock' };
}

// Временный тикер для нового актива, если настоящий не прочитался.
const guessTicker = name => (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || null;

export function parse(text, known = []) {
  const lines = text.split('\n').map(l => l.replace(/[ \t]{2,}/g, '  ').trim()).filter(Boolean);
  const assets = new Map();
  const put = (ticker, data) => {
    ticker = ticker.toUpperCase();
    const a = assets.get(ticker) || { ticker, exact: {} };
    for (const [k, v] of Object.entries(data)) {
      if (v == null) continue;
      const val = v && typeof v === 'object' && 'v' in v ? v : { v, exact: true };
      if (a[k] == null || (!a.exact[k] && val.exact)) { a[k] = val.v; a.exact[k] = val.exact; }
    }
    assets.set(ticker, a);
  };

  const byTicker = t => known.find(a => a.ticker === t)
    || known.map(a => ({ a, s: similar(a.ticker, t) })).filter(x => x.s >= 0.6).sort((x, y) => y.s - x.s)[0]?.a;

  // 1. Список слева: "Pacific Properti.. $472,28" и под ним "PPROP · Акции +1,21%"
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const dollars = [...l.matchAll(DOLLAR)];
    if (dollars.length !== 1 || /NC\s*Exchange|Ориент|Комисс|сч[её]т|счет|портфел|заявк|Доступ|Фундамент/i.test(l)) continue;
    const name = nameFrom(l.slice(0, dollars[0].index));
    if (!name) continue; // цена без названия: подписи графика и т. п.
    const tn = tickerIn(lines[i + 1]) || tickerIn(l);
    const kn = matchName(name, known) || (tn && byTicker(tn.ticker));
    const ticker = kn ? kn.ticker : tn ? tn.ticker : guessTicker(name);
    if (!ticker) continue;
    put(ticker, {
      price: readNum(dollars[0][1]),
      change: readPct(l.slice(dollars[0].index)) || readPct(lines[i + 1]),
      type: tn ? tn.type : null,
      name: kn ? null : name,
      guess: !kn && !tn,
    });
  }

  // 2. Выбранная акция в центре: "NZONE · NC Exchange  $221,28", ниже "NeucZone" и "+1,59%"
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /([A-ZА-Я][A-ZА-Я0-9]{1,9})\s*[·•.,:\-—–]?\s*NC\s*Exchange/.exec(lines[i]);
    if (!m) continue;
    const t = latin(m[1]);
    const kn = byTicker(t);
    current = kn ? kn.ticker : t;
    const rest = [lines[i].slice(m.index + m[0].length), lines[i + 1] || '', lines[i + 2] || ''];
    const price = rest.map(s => [...s.matchAll(DOLLAR)][0]).find(Boolean);
    const nm = [lines[i + 1], lines[i + 2]].map(s => (s || '').replace(/\$.*/, '').match(/([A-Z][A-Za-z0-9&'-]+(?: [A-Z][A-Za-z0-9&'-]+){0,3})\s*$/)).find(Boolean);
    put(current, {
      price: price ? readNum(price[1]) : null,
      change: rest.concat(lines[i + 3] || '').map(readPct).find(Boolean) || null,
      name: kn || !nm ? null : nm[1],
    });
    break;
  }
  // Показатели выбранной компании. Шапка с тикером могла не прочитаться в этом
  // проходе — тогда тикер возьмём из другого прохода (см. merge).
  let company = null;
  {
    const data = {};
    const fields = [['fundamental', /Фундамент/i], ['revenue', /Выручк/i], ['profit', /прибыл/i], ['capital', /Капитал/i]];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (fields.some(([, re]) => re.test(l)) && !/\$/.test(l)) {
        // подписи в одной строке — значения в одной из следующих, по порядку
        const heads = fields.filter(([, re]) => re.test(l)).map(([k]) => k);
        for (const nl of [lines[i + 1], lines[i + 2]]) {
          const vals = [...(nl || '').matchAll(DOLLAR)].map(m => readNum(m[1]));
          if (vals.length === heads.length) { heads.forEach((k, j) => { if (vals[j]) data[k] = vals[j]; }); break; }
          // какое-то значение потерялось — по порядку уже не сопоставить, берём только первое
          if (vals.length && heads[0] === 'fundamental') { data.fundamental = { v: vals[0].v, exact: false }; break; }
        }
      }
      const dv = /№\s*(\d{3,6}).{0,25}?\$\s?(\d+[.,]\d{2})\s*на\s*акци/i.exec(l);
      if (dv) {
        data.dividend = { report: +dv[1], perShare: +dv[2].replace(',', '.'), next: null };
        for (const nl of lines) {
          const nx = /Ближайш.{0,25}?№\s*(\d{3,6})/i.exec(nl);
          if (nx) { data.dividend.next = +nx[1]; break; }
        }
      }
    }
    if (Object.keys(data).length) {
      company = { exact: {} };
      for (const [k, v] of Object.entries(data)) {
        if (v && 'v' in v) { company[k] = v.v; company.exact[k] = v.exact; } else company[k] = v;
      }
    }
  }

  // 3. Индексы: "NCX NCE NCT" / "1 327,86 1 459,08 1 323,07" / "+1,34% +2,37% +1,17%"
  const indices = [];
  for (let i = 0; i < lines.length; i++) {
    const codes = lines[i].match(/\b[NMH]C[A-Z]\b/g);
    if (!codes || codes.length < 2) continue;
    const vals = ((lines[i + 1] || '').match(/\d{1,3}(?: \d{3})+[.,]\d{2}|\d+[.,]\d{2}|\d{4,}/g) || []).map(s => readNum(s));
    const chs = (lines[i + 2] || '').trim().split(/\s{2,}/).map(readPct);
    codes.forEach((code, k) => {
      if (vals[k]) indices.push({ code: code.replace(/^[MH]C/, 'NC'), value: vals[k].v, change: chs[k] ? chs[k].v : null, order: k, exact: vals[k].exact, cexact: !!chs[k]?.exact });
    });
    break;
  }

  // 4. Экономика: "Экономика: Рост" / "Спрос +4,83% · расходы +1,50%"
  let economy = null;
  const eLine = lines.find(l => /Экономик/i.test(l));
  const dLine = lines.find(l => /Спрос/i.test(l)) || '';
  if (eLine || dLine) {
    const st = eLine && /Экономик\S*.{0,6}?(Рост|Спад|Стабильн\S*|Кризис|Падени\S*|Застой|Стагнаци\S*|Бум|Восстановлени\S*)/i.exec(eLine);
    const one = re => { const m = re.exec(dLine); return m ? readPct(m[1].replace(/(\d)[ ](\d{2})\s?%/, '$1,$2%')) : null; };
    economy = {
      status: st ? st[1][0].toUpperCase() + st[1].slice(1).toLowerCase() : null,
      demand: one(/Спрос\s*(\S?\s?\d+[ .,]?\d*\s?%)/i)?.v ?? null,
      costs: one(/расход\S*\s*(\S?\s?\d+[ .,]?\d*\s?%)/i)?.v ?? null,
    };
  }

  return { assets: [...assets.values()], indices, economy, current, company, lines };
}

// Свести результаты нескольких проходов. Где проходы расходятся — берём
// значение с видимой запятой, потом ближайшее к прошлому, и помечаем «проверь».
function pick(cands, ref) {
  cands = cands.filter(c => c && c.v != null);
  if (!cands.length) return null;
  const near = v => !ref || Math.abs(v / ref - 1) < 0.3; // скачок больше 30% — подозрительно
  const agree = cands.find(c => cands.some(o => o !== c && Math.abs(o.v - c.v) < 1e-6));
  if (agree) return { v: agree.v, sure: near(agree.v) };
  const same = ref != null && cands.find(c => Math.abs(c.v - ref) < 1e-6);
  if (same) return { v: same.v, sure: true }; // цена не изменилась
  let pool = cands.filter(c => c.exact);
  if (!pool.length) pool = cands;
  if (ref) pool = [...pool].sort((a, b) => Math.abs(a.v - ref) - Math.abs(b.v - ref));
  const v = pool[0];
  return { v: v.v, sure: cands.length === 1 && v.exact && near(v.v) };
}

export function merge(results, known = {}) {
  const prev = Object.fromEntries((known.assets || []).map(a => [a.ticker, a]));
  const out = [];
  // Новые активы (с названием) группируем по похожему названию: в разных проходах
  // тикер одной и той же акции может прочитаться по-разному (TRIG и CT).
  const all = results.flatMap(r => r.assets);
  // Акции или крипта на всём скриншоте: по подписям под названиями ("BTC · Крипто").
  // Строку вкладок "Акции  Крипто" не считаем — там есть оба слова.
  const typed = all.filter(x => x.type);
  let pageType = null;
  const nCrypto = typed.filter(x => x.type === 'crypto').length, nStock = typed.length - nCrypto;
  if (nCrypto > nStock) pageType = 'crypto';
  else if (nStock > nCrypto) pageType = 'stock';
  else {
    const lines = results.flatMap(r => r.lines || []);
    const c = lines.filter(l => /Крипт|Kpunt/i.test(l) && !/Акци/i.test(l)).length;
    const s = lines.filter(l => /Акци/i.test(l) && !/Крипт|Kpunt/i.test(l)).length;
    pageType = c > s ? 'crypto' : s > c ? 'stock' : null;
  }
  for (const x of all) if (!x.type && pageType) x.type = pageType;
  const current = results.map(r => r.current).find(Boolean);
  if (current) for (const r of results) if (r.company) all.push({ ticker: current, ...r.company });
  const clusters = [];
  for (const x of all) {
    const c = x.name
      ? clusters.find(c => c.name && similar(norm(c.name), norm(x.name)) >= 0.7)
      : clusters.find(c => !c.name && c.list[0].ticker === x.ticker);
    if (c) c.list.push(x); else clusters.push({ name: x.name, list: [x] });
  }
  // правдоподобный тикер похож на начало названия или на его инициалы
  const plaus = (t, name) => {
    const g = guessTicker(name) || '';
    const ini = (name || '').split(/\s+/).map(w => w[0]).join('').toUpperCase();
    return Math.max(similar(t, g.slice(0, t.length)), similar(t, ini)) + (t.length >= 3 ? 0.2 : 0);
  };
  const groups = new Map();
  for (const c of clusters) {
    const real = c.list.filter(x => !x.guess);
    const pool = real.length ? real : c.list;
    const t = c.name ? pool.map(x => x.ticker).sort((p, q) => plaus(q, c.name) - plaus(p, c.name))[0] : c.list[0].ticker;
    groups.set(t, [...(groups.get(t) || []), ...c.list]);
  }
  for (const [t, list] of groups) {
    const a = { ticker: t, unsure: [], guess: list.every(x => x.guess) };
    for (const k of ['price', 'change', 'fundamental', 'revenue', 'profit', 'capital']) {
      let cands = list.map(x => x[k] != null ? { v: x[k], exact: x.exact[k] } : null);
      // фундаментальная цена не бывает в разы дальше рыночной — отсекаем перепутанные колонки
      if (k === 'fundamental' && a.price) cands = cands.filter(c => c && c.v / a.price > 0.5 && c.v / a.price < 2);
      const p = pick(cands, prev[t]?.[k]);
      if (!p) continue;
      a[k] = p.v;
      if (!p.sure) a.unsure.push(k);
    }
    for (const k of ['name', 'type', 'dividend']) {
      const v = list.map(x => x[k]).find(v => v != null);
      if (v != null) a[k] = v;
    }
    if (a.price != null || a.fundamental != null) out.push(a);
  }
  const prevIdx = Object.fromEntries((known.indices || []).map(i => [i.code, i]));
  const indices = [];
  for (const code of new Set(results.flatMap(r => r.indices.map(i => i.code)))) {
    const list = results.map(r => r.indices.find(i => i.code === code)).filter(Boolean);
    const v = pick(list.map(i => ({ v: i.value, exact: i.exact })), prevIdx[code]?.value);
    const c = pick(list.map(i => i.change != null ? { v: i.change, exact: i.cexact } : null));
    indices.push({ code, value: v.v, change: c ? c.v : null, order: list[0].order, unsure: !v.sure || !!(c && !c.sure) });
  }
  indices.sort((a, b) => a.order - b.order);
  let economy = null;
  const econs = results.map(r => r.economy).filter(Boolean);
  if (econs.length) {
    economy = {};
    for (const k of ['status', 'demand', 'costs']) economy[k] = econs.map(e => e[k]).find(v => v != null) ?? null;
    if (economy.status == null && economy.demand == null && economy.costs == null) economy = null;
  }
  return { assets: out, indices, economy, pageType };
}

export const _debug = { preprocess, getWorker };
