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

// Вторая модель — только английская, для строк списка: названия и тикеры там
// латиницей, а русская модель путает их с кириллицей (NCBTC → МСВТС).
let engPromise = null;
async function getEngWorker() {
  engPromise ||= (async () => {
    await loadScript(TESSERACT);
    const w = await window.Tesseract.createWorker('eng', 1);
    await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    return w;
  })();
  try { return await engPromise; } catch (e) { engPromise = null; throw e; }
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
  c.scale = scale;
  return c;
}

// Синие квадратные плашки с инициалами (NC, PP, TR…) стоят слева от каждой строки
// списка активов. Находим их, чтобы читать каждую строку отдельно: в общем тексте
// страницы строки списка склеиваются с соседними колонками.
async function findRows(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 900 / bmp.width);
  const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const blue = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
    blue[i] = b > 150 && b > r + 50 && b > gg + 30 ? 1 : 0;
  }
  const seen = new Uint8Array(W * H);
  const tiles = [];
  for (let i = 0; i < W * H; i++) {
    if (!blue[i] || seen[i]) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q >= 0 && q < W * H && blue[q] && !seen[q] && Math.abs((q % W) - x) <= 1) { seen[q] = 1; stack.push(q); }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    // квадрат примерно 2–7% ширины скриншота, плотно залитый (внутри только белые буквы)
    if (w > W * 0.015 && w < W * 0.08 && Math.abs(w - h) < Math.max(w, h) * 0.25 && n / (w * h) > 0.55) {
      tiles.push({ x: x0 / k, y: y0 / k, w: w / k, h: h / k });
    }
  }
  // строки списка — плашки одного размера в одной колонке
  const rows = tiles.filter(t => tiles.filter(o => Math.abs(o.x - t.x) < t.w * 0.5 && Math.abs(o.w - t.w) < t.w * 0.25).length >= 2);
  return rows.map(t => ({
    left: t.x + t.w * 1.15, top: t.y - t.h * 0.12,
    // ширина — до правого края карточки, без полосы прокрутки списка
    width: Math.min(t.w * 4.15, bmp.width - t.x - t.w * 1.15), height: t.h * 1.25,
  })).sort((a, b) => a.top - b.top);
}

// Вырезать строку списка, увеличить в k раз и перевести в чёрно-белое.
function cropRow(bmp, r, k = 2.2) {
  const c = document.createElement('canvas');
  c.width = Math.round(r.width * k);
  c.height = Math.round(r.height * k);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, r.left, r.top, r.width, r.height, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  // яркость по максимуму канала, инверсия: любой светлый текст становится тёмным на белом
  for (let i = 0; i < d.length; i += 4) {
    // три уровня: яркий текст — чёрный, серый (тикер) — тёмно-серый, фон — белый;
    // полутона по краям букв убираем, иначе жирные цифры слипаются
    const v = Math.max(d[i], d[i + 1], d[i + 2]);
    const s = v >= 170 ? 0 : v >= 85 ? 40 : 255;
    d[i] = d[i + 1] = d[i + 2] = s;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Разрезать строку списка на 4 куска по пустому месту между ними:
//   [название]      [цена]
//   [тикер · тип]   [процент]
// Каждый кусок читается отдельно, цены и проценты — только цифрами.
function splitRow(c) {
  const W = c.width, H = c.height;
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, W, H).data;
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) ink[i] = d[i * 4] < 200 ? 1 : 0;
  // рамки карточки и полосы — линии почти во всю ширину или высоту — не текст
  for (let y = 0; y < H; y++) {
    let n = 0; for (let x = 0; x < W; x++) n += ink[y * W + x];
    if (n > W * 0.6) for (let x = 0; x < W; x++) ink[y * W + x] = 0;
  }
  for (let x = 0; x < W; x++) {
    let n = 0; for (let y = 0; y < H; y++) n += ink[y * W + x];
    if (n > H * 0.6) for (let y = 0; y < H; y++) ink[y * W + x] = 0;
  }
  // строки текста по вертикали
  const runs = [];
  let start = -1, blank = 0;
  for (let y = 0; y <= H; y++) {
    let n = 0; if (y < H) for (let x = 0; x < W; x++) n += ink[y * W + x];
    if (n > 1) { if (start < 0) start = y; blank = 0; }
    else if (start >= 0 && ++blank > H * 0.04) { runs.push([start, y - blank]); start = -1; blank = 0; }
  }
  if (start >= 0) runs.push([start, H - 1]);
  const lines = runs.filter(([a, b]) => b - a > H * 0.06);
  if (!lines.length) return null;
  const band1 = lines[0], band2 = lines.length > 1 ? [lines[1][0], lines[lines.length - 1][1]] : null;
  // правый кусок (цена/процент) отделён от левого пустым промежутком шире ~половины строки
  // столбец с текстом; сплошная вертикальная полоса (край карточки, прокрутка) — не текст
  const colInk = (x, y0, y1) => {
    let n = 0; for (let y = y0; y <= y1; y++) n += ink[y * W + x];
    return n > 0 && n < (y1 - y0 + 1) * 0.8;
  };
  const lastInk = ([y0, y1]) => { let x = W - 1; while (x > 0 && !colInk(x, y0, y1)) x--; return x; };
  const splitX = ([y0, y1]) => {
    let x = lastInk([y0, y1]);
    const gapMin = Math.max(6, (y1 - y0) * 0.55);
    let gap = 0;
    for (; x > 0; x--) {
      if (colInk(x, y0, y1)) gap = 0; else if (++gap >= gapMin) return x + gap;
    }
    return 0;
  };
  const cut = (x0, x1, [y0, y1]) => {
    // правая граница — по последнему столбцу с текстом, без полосы справа
    x1 = Math.min(x1, lastInk([y0, y1]) + 3);
    const pad = 12, h = y1 - y0 + 1, w = x1 - x0;
    if (w < 4 || h < 4) return null;
    const o = document.createElement('canvas');
    o.width = w + pad * 2; o.height = h + pad * 2;
    const og = o.getContext('2d');
    og.fillStyle = '#fff'; og.fillRect(0, 0, o.width, o.height);
    og.drawImage(c, x0, y0, w, h, pad, pad, w, h);
    return o;
  };
  const s1 = splitX(band1);
  const parts = { name: cut(0, s1 || W, band1), price: s1 ? cut(s1, W, band1) : null };
  if (band2) {
    const s2 = splitX(band2);
    parts.ticker = cut(0, s2 || W, band2);
    parts.pct = s2 ? cut(s2, W, band2) : null;
  }
  return parts;
}

const WL = {
  price: { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '$0123456789,. ' },
  pct: { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '+-0123456789,.%' },
  name: { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' },
  ticker: { tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' },
};

// Цены в жирном шрифте NC Exchange Tesseract читает по-разному при разном увеличении
// (5 ↔ 8, пропадает запятая) — цену читаем при нескольких увеличениях, потом голосуем.
const PRICE_SCALES = [2.2, 2.8, 1.6];

async function readRows(ew, bmp, rows, onStep) {
  const parts = PRICE_SCALES.map(k => rows.map(r => splitRow(cropRow(bmp, r, k))));
  const out = rows.map(() => ({ prices: [] }));
  const total = rows.length * (PRICE_SCALES.length + 3);
  let n = 0;
  await ew.setParameters(WL.price);
  for (const ps of parts) {
    for (let i = 0; i < rows.length; i++) {
      onStep(n++ / total);
      if (!ps[i] || !ps[i].price) continue;
      const { data } = await ew.recognize(ps[i].price);
      out[i].prices.push(data.text.replace(/\s+/g, ' ').trim());
    }
  }
  for (const k of ['pct', 'name', 'ticker']) {
    await ew.setParameters(WL[k]);
    for (let i = 0; i < rows.length; i++) {
      onStep(n++ / total);
      const p = parts[0][i];
      if (!p || !p[k]) continue;
      const { data } = await ew.recognize(p[k]);
      out[i][k] = data.text.replace(/\s+/g, ' ').trim();
    }
  }
  await ew.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
  return out;
}

// Выбрать цену из прочтений: сначала ту, что встречается и на всей странице,
// потом самую частую. Уверены, если совпала со страницей или с другим прочтением.
function votePrice(texts, pagePrices) {
  const vals = texts.map(t => t.replace(/^[^\d]*/, '').replace(/[^\d ,.]/g, '').trim()).filter(Boolean).map(t => readNum(t)).filter(Boolean);
  if (!vals.length) return null;
  const count = v => vals.filter(o => Math.abs(o.v - v) < 1e-6).length;
  const inPage = vals.filter(o => pagePrices.has(o.v.toFixed(2)));
  if (inPage.length) return { v: inPage[0].v, exact: true };
  // без совпадений берём прочтение, больше всего похожее на остальные (370,45 среди 3720,48 и 370,48)
  const close = v => vals.reduce((s, o) => s + similar(v.toFixed(2), o.v.toFixed(2)), 0);
  const best = [...vals].sort((a, b) => count(b.v) - count(a.v) || close(b.v) - close(a.v) || b.exact - a.exact)[0];
  return { v: best.v, exact: count(best.v) >= 2 && best.exact };
}

// Два прохода по всей странице с разной обработкой (что не прочиталось в одном, часто
// читается в другом) и отдельное чтение каждой строки списка.
export async function recognize(file, known = {}, onProgress = () => {}) {
  const w = await getWorker();
  const passes = [{ raw: false }, { raw: true }];
  const steps = passes.length + 1;
  const texts = [];
  let firstCanvas = null;
  for (let i = 0; i < passes.length; i++) {
    progressCb = (msg, p) => onProgress(`${msg} (${i + 1}/${steps})`, (i + p) / steps);
    progressCb('Подготавливаю картинку…', 0);
    const canvas = await preprocess(file, passes[i]);
    firstCanvas ||= canvas;
    const { data } = await w.recognize(canvas);
    texts.push(data.text);
  }
  const results = texts.map(t => parse(t, known.assets));

  const rows = await findRows(file);
  const rowTexts = [];
  if (rows.length) {
    progressCb = () => {};
    onProgress(`Читаю строки списка (${steps}/${steps})`, passes.length / steps);
    const ew = await getEngWorker();
    const bmp = await createImageBitmap(file);
    const read = await readRows(ew, bmp, rows, p => onProgress(`Читаю строки списка (${steps}/${steps})`, (passes.length + p) / steps));
    rowTexts.push(...read.map(r => [r.name, r.prices.join(' / '), r.ticker, r.pct].join(' | ')));
    // все цены с запятой, прочитанные на странице целиком, — для сверки
    const pagePrices = new Set(texts.flatMap(t => [...t.matchAll(DOLLAR)].map(m => readNum(m[1])).filter(x => x && x.exact).map(x => x.v.toFixed(2))));
    results.push(parseRows(read, known.assets, pagePrices));
  }
  onProgress('Разбираю цифры…', 1);
  return { ...merge(results, known), text: texts.join('\n———\n') + '\n——— строки ———\n' + rowTexts.join('———\n') };
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
const LOOKALIKE = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', '№': 'N' };
// "NC" в начале тикера OCR часто читает как МС / НС / №С
const latin = s => String(s || '').replace(/[АВЕКМНОРСТУХІ№]/g, ch => LOOKALIKE[ch]).replace(/^(MC|HC|NG)(?=[A-Z]{2})/, 'NC');

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
  const m = /([A-ZА-Я№][A-ZА-Я0-9]{1,9})\s*[·•.,:\-—–О0]?\s*(Акци|Акция|Крипт|Akuu|Akyu|Axu|Arum|Kpunt|Kpun|Kpnt|Kpu)/.exec(line || '');
  if (!m) return null;
  const t = latin(m[1]);
  if (!/^[A-Z][A-Z0-9]+$/.test(t)) return null;
  return { ticker: t, type: /крипт|kp/i.test(m[2]) ? 'crypto' : 'stock' };
}

const inOrder = (t, name) => {
  const s = (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let j = 0;
  for (const ch of s) if (ch === t[j]) j++;
  return j === t.length;
};

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
    const m = /([A-ZА-Я№][A-ZА-Я0-9]{1,9})\s*[·•.,:\-—–]?\s*NC\s*Exchange/.exec(lines[i]);
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
    // у крипты вместо фундаментальной цены — «Ценовой ориентир»
    const fields = [['fundamental', /Фундамент|Ценов\S*\s*ориентир/i], ['revenue', /Выручк/i], ['profit', /прибыл/i], ['capital', /Капитал/i]];
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

// Строки списка, прочитанные по кускам: { name: 'NC Bitcoin', price: '$260 616,70',
// ticker: 'NCBTC · Kpuntoaktne', pct: '+0,34%' }
export function parseRows(rows, known = [], pagePrices = new Set()) {
  const assets = [];
  for (const r of rows) {
    const words = (r.name || '').replace(/\$.*/, '').replace(/[^A-Za-z0-9 .&'-]/g, ' ').split(/\s+/).filter(w => /[A-Za-z]/.test(w));
    while (words.length && !/^[A-Z]/.test(words[0])) words.shift();
    const name = words.join(' ').replace(/\.+$/, '').trim();
    if (name.replace(/[^A-Za-z]/g, '').length < 3) continue;
    const price = votePrice(r.prices || [], pagePrices);
    if (!price) continue;
    // тикер — первое слово капсом; тип — по слову после точки, если прочиталось
    const tm = /\b([A-Z][A-Z0-9]{1,9})\b/.exec(latin(r.ticker || ''));
    // мелкий серый тикер часто читается мусором; верим, только если его буквы по порядку
    // есть в названии: NCBTC ⊂ "NC Bitcoin", NZONE ⊂ "NeucZone"
    const tk = tm && tm[1].length >= 3 && inOrder(tm[1], name) ? tm[1] : null;
    const type = /kp|крипт/i.test(r.ticker || '') ? 'crypto' : /ak|акци/i.test(r.ticker || '') ? 'stock' : null;
    const kn = matchName(name, known) || (tk && known.find(a => a.ticker === tk));
    const ticker = kn ? kn.ticker : tk || guessTicker(name);
    if (!ticker) continue;
    const change = readPct(r.pct || '');
    const a = { ticker, exact: { price: price.exact }, price: price.v, guess: !kn && !tk };
    if (change) { a.change = change.v; a.exact.change = change.exact; }
    if (type) a.type = type;
    if (!kn) a.name = name;
    assets.push(a);
  }
  return { assets, indices: [], economy: null, current: null, company: null, lines: rows.map(r => r.ticker || '') };
}

// Свести результаты нескольких проходов. Где проходы расходятся — берём
// значение с видимой запятой, потом ближайшее к прошлому, и помечаем «проверь».
function pick(cands, ref) {
  cands = cands.filter(c => c && c.v != null);
  if (!cands.length) return null;
  const near = v => !ref || Math.abs(v / ref - 1) < 0.3; // скачок больше 30% — подозрительно
  const agree = cands.find(c => cands.some(o => o !== c && Math.abs(o.v - c.v) < 1e-6));
  if (agree && near(agree.v)) return { v: agree.v, sure: true };
  // совпавшее значение далеко от прошлого, а другое прочтение рядом — вероятнее второе
  const plausible = ref && cands.filter(c => near(c.v)).sort((a, b) => Math.abs(a.v - ref) - Math.abs(b.v - ref))[0];
  if (agree) return plausible ? { v: plausible.v, sure: false } : { v: agree.v, sure: false };
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
    // угаданная запись с той же ценой, что у уже найденной — это она же, прочитанная криво
    const twin = x.guess && x.price != null && clusters.find(c => c.list.some(o => !o.guess && o.price === x.price));
    const c = twin || (x.name
      ? clusters.find(c => c.name && similar(norm(c.name), norm(x.name)) >= 0.7)
      : clusters.find(c => !c.name && c.list[0].ticker === x.ticker));
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

export const _debug = { preprocess, getWorker, getEngWorker, findRows, cropRow, splitRow };
