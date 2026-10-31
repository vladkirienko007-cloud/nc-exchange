// Распознавание скриншота планшета NC Exchange прямо в браузере (Tesseract.js).
// Игру не трогаем: читаем только картинку, которую дал пользователь.

import { readGlyphs, setTemplates, hasTemplates } from './glyphs.js';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

// Эталоны цифр шрифта игры (собираются из dev/truth.json). Нет файла — читаем только Tesseract.
const templatesReady = import('./templates.js').then(m => setTemplates(m.TEMPLATES)).catch(() => {});

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
  const scale = opt.scale || Math.min(3, Math.max(1, 3840 / bmp.width));
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
  const parts = { name: cut(0, s1 || W, band1), price: s1 ? cut(s1, W, band1) : null, top: cut(0, W, band1), boxes: {} };
  // где цена и процент на вырезке строки — чтобы прочитать их по эталонам из исходных пикселей
  if (s1) parts.boxes.price = [s1, band1[0], Math.min(W, lastInk(band1) + 3), band1[1]];
  if (band2) {
    const s2 = splitX(band2);
    parts.ticker = cut(0, s2 || W, band2);
    parts.pct = s2 ? cut(s2, W, band2) : null;
    if (s2) parts.boxes.pct = [s2, band2[0], Math.min(W, lastInk(band2) + 3), band2[1]];
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
  // сначала эталоны шрифта игры — если все знаки уверенно похожи, это точное значение
  rows.forEach((r, i) => {
    const bx = rowBoxes(r);
    const gp = readGlyphs(glyphCanvas(bmp, bx.price), { style: 'b', freePrefix: true });
    if (gp && gp.sure && /\$\d/.test(gp.text)) out[i].gPrice = gp.text;
    const gc = glyphPct(bmp, bx.pct);
    if (gc) out[i].gPct = gc;
  });
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
  // верхняя строка целиком: если название вплотную к цене, разрезка может задеть цену —
  // тогда цену берём после знака $
  await ew.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
  for (const ps of parts) {
    for (let i = 0; i < rows.length; i++) {
      if (!ps[i] || !ps[i].top) continue;
      const { data } = await ew.recognize(ps[i].top);
      const m = /\$\s?([\d][\d ,.]*)/.exec(data.text);
      if (m) out[i].prices.push('$' + m[1].trim());
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

/* ---------------- карточки показателей выбранного актива ---------------- */

// Подпись карточки → что под ней. kind: money — $ и копейки, int — целое, pct — проценты.
// sub — что лежит во второй строке карточки (у части карточек там тоже число).
const CARDS = [
  // подписи карточек с большой буквы: строчные «активности», «капитала», «рыночный» есть
  // в других местах экрана
  { re: /^Фундамент/, key: 'fundamental', kind: 'money' },
  { re: /^Ценов/, key: 'fundamental', kind: 'money' },
  { re: /^Выручк/, key: 'revenue', kind: 'money' },
  { re: /^Чист/, key: 'profit', kind: 'money' },
  { re: /^[KК]апитал/, key: 'capital', kind: 'money', sub: 'debt', subKind: 'money' },
  { re: /^обращ/, key: 'circulating', kind: 'int', sub: 'maxSupply', subKind: 'int', leftWord: true },
  { re: /^[AА]ктивн/, key: 'activity', kind: 'pct1', sub: 'adoption', subKind: 'pct1' },
  { re: /^[PР]ыночн/, key: 'risk', kind: 'pct2', sub: 'orderFlow', subKind: 'pct2' },
];

// Вырезать прямоугольник из исходной картинки, увеличить и инвертировать (светлый текст → тёмный).
function cropBox(bmp, b, k) {
  const c = document.createElement('canvas');
  const pad = 10;
  c.width = Math.round(b.w * k) + pad * 2;
  c.height = Math.round(b.h * k) + pad * 2;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, b.x, b.y, b.w, b.h, pad, pad, c.width - pad * 2, c.height - pad * 2);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(d[i], d[i + 1], d[i + 2]);
    const s = v >= 120 ? 0 : v >= 75 ? 255 - (v - 75) * 5.6 : 255; // серые подписи тоже делаем тёмными
    d[i] = d[i + 1] = d[i + 2] = s;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Вырезка для чтения по эталонам: увеличение без размытия краёв в «кашу» и порог
// относительно яркости самого текста — остаются середины линий, жирные цифры не слипаются.
export function glyphCanvas(bmp, b, k = 3, rel = 0.5) {
  const c = document.createElement('canvas');
  const pad = 4;
  c.width = Math.max(1, Math.round(b.w * k)) + pad * 2;
  c.height = Math.max(1, Math.round(b.h * k)) + pad * 2;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, b.x, b.y, b.w, b.h, pad, pad, c.width - pad * 2, c.height - pad * 2);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const vs = new Uint8Array(d.length / 4);
  for (let i = 0; i < vs.length; i++) vs[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  const sorted = Array.from(vs).sort((x, y) => x - y);
  const bg = sorted[Math.floor(sorted.length * 0.3)];
  // яркость самого текста — середина среди заметно светлых пикселей (у цветных процентов
  // она ниже, чем у белой цены, случайно задетой сверху)
  const textPx = sorted.filter(v => v > bg + 40);
  const textV = textPx.length ? textPx[Math.floor(textPx.length * 0.6)] : sorted[sorted.length - 1];
  const T = bg + (textV - bg) * rel;
  const CW = c.width, CH = c.height;
  const on = new Uint8Array(vs.length);
  for (let i = 0; i < vs.length; i++) on[i] = vs[i] >= T ? 1 : 0;
  // рамка выделенной строки и полоса прокрутки — длинные линии, не текст
  for (let x = 0; x < CW; x++) { let n = 0; for (let y = 0; y < CH; y++) n += on[y * CW + x]; if (n > CH * 0.8) for (let y = 0; y < CH; y++) on[y * CW + x] = 0; }
  for (let y = 0; y < CH; y++) { let n = 0; for (let x = 0; x < CW; x++) n += on[y * CW + x]; if (n > CW * 0.8) for (let x = 0; x < CW; x++) on[y * CW + x] = 0; }
  for (let i = 0; i < vs.length; i++) { const v = on[i] ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
  g.putImageData(img, 0, 0);
  return c;
}

// Где в строке списка цена и процент: правая часть верхней и нижней половины строки.
// Название слева при чтении пропускается как «мусор», цена начинается со знака $.
function rowBoxes(r) {
  const th = r.height / 1.25, ty = r.top + th * 0.12; // плашка-иконка строки
  return {
    // у процента справа не захватываем зелёную полосу прокрутки списка — она путает знак по цвету
    price: { x: r.left + r.width * 0.4, y: ty - th * 0.05, w: r.width * 0.6, h: th * 0.5 },
    pct: { x: r.left + r.width * 0.5, y: ty + th * 0.52, w: r.width * 0.43, h: th * 0.4 },
  };
}

// Знак процента по цвету текста: красный — падение, зелёный — рост, серый — 0.
// Минус в игре мелкий и тонкий, по цвету надёжнее.
export function colorSign(bmp, b) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(b.w)); c.height = Math.max(1, Math.round(b.h));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let r = 0, gr = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.max(d[i], d[i + 1], d[i + 2]) < 110) continue;
    r += d[i]; gr += d[i + 1];
  }
  if (r > gr * 1.25) return -1;
  if (gr > r * 1.25) return 1;
  return 0;
}

// Процент по эталонам: цифры — эталоны, знак — цвет.
function glyphPct(bmp, box) {
  // слева от процента может быть знак, стрелка или край карточки — пропускаются
  const g = readGlyphs(glyphCanvas(bmp, box), { style: 'p', freePrefix: true });
  if (!g || !g.sure || !/%/.test(g.text)) return null;
  const v = digitsValue(g.text, 'pct2');
  if (v == null || v > 100) return null;
  const sign = colorSign(bmp, box);
  return { v: v === 0 ? 0 : (sign || (/^[-−]/.test(g.text) ? -1 : 1)) * v, exact: v === 0 || sign !== 0, text: g.text };
}

// Прямоугольник куска строки списка (в координатах вырезки cropRow с увеличением k) → исходная картинка.
function rowPartBox(r, box, k = 2.2) {
  const [x0, y0, x1, y1] = box;
  return { x: r.left + x0 / k - 1, y: r.top + y0 / k - 1, w: (x1 - x0) / k + 2, h: (y1 - y0) / k + 2 };
}

function parseKind(t, kind) {
  // в цифрах этого шрифта OCR путает 0 с O и C
  t = (t || '').replace(/[OoCcСсОо]/g, '0').replace(/[^\d ,.%-]/g, ' ').trim();
  if (kind === 'int') {
    const m = t.match(/\d[\d ]*\d|\d/g);
    if (!m) return null;
    const v = +m[m.length - 1].replace(/ /g, '');
    return isFinite(v) ? { v, exact: true } : null;
  }
  if (kind === 'pct' || kind === 'pct1' || kind === 'pct2') {
    const m = /(\d{1,3})[.,](\d{1,2})\s*%?|(\d{2,4})\s*%/.exec(t);
    if (!m) return null;
    if (m[1] != null) return { v: +(m[1] + '.' + m[2]), exact: true };
    // запятая не прочиталась: "090%" — в игре два знака после запятой у риска, один у активности
    return { v: +m[3] / (m[3].length >= 3 ? 100 : 10), exact: false };
  }
  const m = t.match(/\d[\d .,]*\d/g);
  return m ? readNum(m[m.length - 1].trim()) : null;
}

// Строки текста в прямоугольнике (по вертикали): [[y0, y1], ...] в координатах картинки.
function textRuns(bmp, b, minH = 4) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(b.w)); c.height = Math.max(1, Math.round(b.h));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const runs = [];
  let start = -1;
  for (let y = 0; y <= c.height; y++) {
    let n = 0;
    if (y < c.height) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (Math.max(d[i], d[i + 1], d[i + 2]) >= 65) n++; }
    // строка текста: заметно светлых пикселей, но не сплошная линия рамки
    const isText = n >= 2 && n < c.width * 0.7;
    if (isText && start < 0) start = y;
    if (!isText && start >= 0) { if (y - start >= minH) runs.push([b.y + start, b.y + y]); start = -1; }
  }
  return runs;
}

// Прочитать одно число при нескольких увеличениях и выбрать самое частое.
async function voteBox(w, bmp, box, kind, scales = [3, 4, 2.4], strict = false) {
  const vals = [];
  for (const k of scales) {
    const { data } = await w.recognize(cropBox(bmp, box, k));
    const v = parseKind(data.text, kind);
    if (globalThis.__ocrDebug) globalThis.__ocrDebug.push(`${kind} k${k}: ${data.text.trim()} → ${v && v.v}`);
    if (v) vals.push(v);
  }
  if (!vals.length) return null;
  const count = v => vals.filter(o => Math.abs(o.v - v) < 1e-6).length;
  const best = [...vals].sort((a, b) => count(b.v) - count(a.v) || b.exact - a.exact)[0];
  // strict: уверены, только если совпали все прочтения (для мелких подстрок)
  return { v: best.v, exact: best.exact && (strict ? count(best.v) === scales.length : count(best.v) >= 2) };
}

const toWords = (words, s) => words.map(x => ({ t: x.text, x0: x.bbox.x0 / s, y0: x.bbox.y0 / s, x1: x.bbox.x1 / s, y1: x.bbox.y1 / s }));

// Найти карточки показателей и прямоугольники значения и подстроки в каждой.
// words — слова прохода «разреженный текст» с координатами на увеличенной картинке (s — во сколько раз).
function cardBoxes(bmp, words, s) {
  const W = toWords(words, s);
  // все слова, похожие на подписи карточек (их бывает несколько: «Активные» во вкладках)
  const cands = [];
  W.forEach((w, i) => {
    for (const c of CARDS) {
      if (!c.re.test(w.t)) continue;
      let x0 = w.x0;
      // "В обращении": карточка начинается со слова "В" слева
      if (c.leftWord && i > 0 && W[i - 1].x1 < x0 && x0 - W[i - 1].x1 < (w.y1 - w.y0) * 1.5) x0 = W[i - 1].x0;
      cands.push({ ...c, x0, y0: w.y0, y1: w.y1 });
    }
  });
  if (!cands.length) return [];
  // карточки стоят в один ряд — берём ряд, где больше всего разных подписей
  const near = (a, b) => Math.abs(a.y0 - b.y0) < (b.y1 - b.y0) * 1.5;
  const rowKeys = f => new Set(cands.filter(o => near(o, f)).map(o => o.key)).size;
  const anchor = cands.reduce((a, b) => rowKeys(b) > rowKeys(a) ? b : a);
  const found = [];
  for (const o of cands) if (near(o, anchor) && !found.some(f => f.key === o.key)) found.push(o);
  found.sort((a, b) => a.x0 - b.x0);
  // ширина карточки — до следующей подписи в том же ряду
  const gaps = found.slice(1).map((f, i) => f.x0 - found[i].x0).filter(g => g > 0);
  // если какая-то подпись не нашлась, промежуток между соседними — две карточки;
  // карточка не шире ~17 высот подписи
  const lh = found[0].y1 - found[0].y0;
  const cw = Math.min(gaps.length ? Math.min(...gaps) : Infinity, lh * 17);
  return found.map(f => {
    const h = f.y1 - f.y0;
    // строки значения и подстроки ищем по самому изображению: значение крупнее подписи;
    // хвостики букв подписи (щ, р) — короткие, отбрасываем
    const [valRun, subRun] = textRuns(bmp, { x: f.x0, y: f.y1 + 1, w: cw * 0.9, h: h * 7 }, Math.max(4, h * 0.6));
    return {
      ...f,
      valBox: valRun && { x: f.x0 - 3, y: valRun[0] - 3, w: cw * 0.92, h: valRun[1] - valRun[0] + 6 },
      subBox: f.sub && subRun && { x: f.x0 - 3, y: subRun[0] - 3, w: cw * 0.92, h: subRun[1] - subRun[0] + 6 },
    };
  });
}

// Прочитать число по эталонам; null — эталонов нет или знаки не уверенно похожи.
// Число из прочитанных по эталонам знаков. Запятые и пробелы мелкие и иногда теряются,
// поэтому число собирается из одних цифр: у денег в игре всегда 2 знака после запятой,
// у процентов — 1 (активность) или 2 (риск, изменение цены).
export function digitsValue(text, kind) {
  let t = text;
  // формат: у денег есть $, у процентов — знак % и не меньше 2–3 цифр
  if (kind === 'money' && !/\$\s*\d/.test(t)) return null;
  if (kind !== 'money' && kind !== 'int' && !/%/.test(t)) return null;
  const nd = (t.split(kind === 'money' ? '$' : '%')[kind === 'money' ? 1 : 0] || '').replace(/\D/g, '').length;
  if ((kind === 'pct2' || kind === 'money') && nd < 3) return null;
  if (kind === 'pct1' && nd < 2) return null;
  if (kind === 'money') { const i = t.indexOf('$'); if (i >= 0) t = t.slice(i + 1); }
  if (kind === 'pct1' || kind === 'pct2') {
    // процент: берём только число прямо перед %, слева может быть мусор («4 0,00%»)
    const dec = kind === 'pct1' ? 1 : 2;
    t = t.replace(/%.*$/, '').trim();
    const tail = t.split(/\s+/);
    const last = tail.pop() || '';
    const m = new RegExp('(\\d{1,3})[,.]+(\\d{' + dec + '})$').exec(last);
    if (m) return +(m[1] + '.' + m[2]);
    if (new RegExp('^\\d{' + (dec + 1) + ',' + (dec + 3) + '}$').test(last)) return +last / 10 ** dec;
    // запятая прочиталась как пробел: «0 45%»
    const prev = tail.pop() || '';
    if (new RegExp('^\\d{' + dec + '}$').test(last) && /\d$/.test(prev)) return +(prev.replace(/\D/g, '').slice(-2) + '.' + last);
    return null;
  }
  const d = t.replace(/\D/g, '');
  if (!d) return null;
  const div = kind === 'money' || kind === 'pct2' ? 100 : kind === 'pct1' ? 10 : 1;
  return +d / div;
}

function glyphValue(canvas, kind, fromRight = false, style = 'b') {
  // значения карточек — жирный шрифт ('b'), крупная цена в шапке ('h'); подстроки — мелкий серый ('r')
  const g = readGlyphs(canvas, fromRight ? { style: 'r', freePrefix: true } : { style });
  if (!g || !g.sure) return null;
  const v = digitsValue(g.text, kind);
  return v == null ? null : { v, exact: true, text: g.text };
}

async function readCards(bmp, words, s, onStep) {
  const boxes = cardBoxes(bmp, words, s);
  if (!boxes.length) return null;
  const ew = await getEngWorker();
  const out = { exact: {} };
  let n = 0;
  for (const f of boxes) {
    onStep(n++ / boxes.length);
    if (!f.valBox) continue;
    let v = glyphValue(glyphCanvas(bmp, f.valBox), f.kind);
    await ew.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '$0123456789,.% ' });
    const tv = await voteBox(ew, bmp, f.valBox, f.kind, [3]);
    // по эталонам точнее; не совпало с Tesseract — значение по эталонам, но «проверь»
    if (v && tv && Math.abs(tv.v - v.v) > 1e-6) v = { ...v, exact: false };
    if (!v) v = tv;
    if (v) { out[f.key] = v.v; out.exact[f.key] = v.exact; }
    if (f.subBox) {
      // во второй строке перед числом русские слова ("из", "Долг:") — эталоны читают справа,
      // пока знаки похожи на цифры; запасной путь — русская модель Tesseract
      let sv = glyphValue(glyphCanvas(bmp, f.subBox, 3, 0.7), f.subKind, true);
      const rw = await getWorker();
      await rw.setParameters({ tessedit_pageseg_mode: '7' });
      const tsv = await voteBox(rw, bmp, f.subBox, f.subKind, [4.5], true);
      await rw.setParameters({ tessedit_pageseg_mode: '3' });
      // мелкий серый шрифт: уверены, только если эталоны и Tesseract прочитали одно и то же
      if (sv) sv = { ...sv, exact: !!tsv && Math.abs(tsv.v - sv.v) < 1e-6 };
      if (!sv) sv = tsv;
      if (sv) { out[f.sub] = sv.v; out.exact[f.sub] = sv.exact; }
    }
  }
  await ew.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
  return out;
}

// Шапка выбранного актива: "NCBTC · NC Exchange" слева, крупная цена справа, под ней процент.
function headerBoxes(words, s) {
  const W = toWords(words, s);
  // "NC Exchange" на экране два раза: заголовок приложения и шапка актива. Нужен тот,
  // перед которым стоит тикер ("NCBTC · NC Exchange")
  let ex = -1, tw = null, h = 0;
  for (let i = 0; i < W.length && !tw; i++) {
    if (!/Ex[cс]h/i.test(W[i].t)) continue;
    const hh = W[i].y1 - W[i].y0;
    const cand = W.slice(Math.max(0, i - 4), i).reverse().find(x => /^[A-ZА-Я№]{3,10}$/.test(latin(x.t.replace(/[·•.,:-]+$/, ''))) && !/^N[CС]$/.test(x.t) && Math.abs(x.y0 - W[i].y0) < hh);
    if (cand) { ex = i; tw = { ...cand, t: cand.t.replace(/[·•.,:-]+$/, '') }; h = hh; }
  }
  if (!tw) return null;
  const out = { ticker: latin(tw.t) };
  // цена — слово с $ правее, по высоте рядом со строкой тикера (цена крупнее и чуть выше)
  const pw = W.filter(x => /\$/.test(x.t) && x.x0 > W[ex].x1 && x.y0 < W[ex].y1 + h * 2 && x.y1 > W[ex].y0 - h * 2)
    .sort((a, b) => a.y0 - b.y0)[0];
  if (!pw) return out;
  // цена может состоять из нескольких слов ("$242 163,44"): берём подряд идущие числовые
  // слова той же строки, не дальше одного пробела друг от друга
  let x1 = pw.x1;
  for (const x of W.filter(o => Math.abs(o.y0 - pw.y0) < h && o.x0 > pw.x0).sort((a, b) => a.x0 - b.x0)) {
    if (x.x0 - x1 > (pw.y1 - pw.y0) * 0.8 || !/^[\d.,]+$/.test(x.t)) break;
    x1 = x.x1;
  }
  out.priceBox = { x: pw.x0 - 3, y: pw.y0 - 3, w: x1 - pw.x0 + 6, h: pw.y1 - pw.y0 + 6 };
  // процент — под ценой; стрелка ↑/↓ перед ним читается отдельным словом — нужно слово с цифрами
  const cw = W.find(x => /\d/.test(x.t) && /%/.test(x.t) && x.y0 > pw.y1 - 2 && x.y0 < pw.y1 + h * 3 && x.x1 > pw.x0);
  if (cw) { out.pctBox = { x: cw.x0 - 3, y: cw.y0 - 3, w: cw.x1 - cw.x0 + 6, h: cw.y1 - cw.y0 + 6 }; out.pctWord = cw.t; }
  return out;
}

async function readHeader(bmp, words, s) {
  const hb = headerBoxes(words, s);
  if (!hb) return null;
  const out = { ticker: hb.ticker, exact: {} };
  const ew = await getEngWorker();
  if (hb.priceBox) {
    let v = glyphValue(glyphCanvas(bmp, hb.priceBox), 'money', false, 'h');
    await ew.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '$0123456789,. ' });
    const tv = await voteBox(ew, bmp, hb.priceBox, 'money', [3]);
    if (v && tv && Math.abs(tv.v - v.v) > 0.005) v = { ...v, exact: false };
    if (!v) v = tv;
    if (v) { out.price = v.v; out.exact.price = v.exact; }
  }
  if (hb.pctBox) {
    let c = glyphPct(bmp, hb.pctBox);
    if (!c) {
      await ew.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '+-0123456789,.%' });
      const { data } = await ew.recognize(cropBox(bmp, hb.pctBox, 4));
      c = readPct(data.text) || readPct(hb.pctWord);
      // минус берём из текста слова: стрелка ↓ читается мусором
      if (c && /^[-−–]/.test(hb.pctWord.replace(/^[^\d+\-−–]*/, '')) && c.v > 0) c = { v: -c.v, exact: c.exact };
    }
    if (c) { out.change = c.v; out.exact.change = c.exact; }
  }
  await ew.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
  return out;
}

// Нижняя плашка: "Цикл крипторынка №249092" / "Следующее обновление сетевого цикла: 31.10, 21:00"
// или "Отчёт №1308 · дивиденды $0,23 на акцию" / "Ближайшее решение: отчёт №1314".
async function readBanner(bmp, words, s) {
  const W = words.map(x => ({ t: x.text, x0: x.bbox.x0 / s, y0: x.bbox.y0 / s, x1: x.bbox.x1 / s, y1: x.bbox.y1 / s }));
  const a = W.find(x => /^(Следующ|Ближайш)/i.test(x.t));
  if (!a) return null;
  const h = a.y1 - a.y0;
  const w = await getWorker();
  await w.setParameters({ tessedit_pageseg_mode: '7' });
  const line = async (y) => {
    const { data } = await w.recognize(cropBox(bmp, { x: a.x0 - h, y, w: h * 45, h: h * 1.9 }, 3));
    return data.text.replace(/\s+/g, ' ').trim();
  };
  const title = await line(a.y0 - h * 2.1);
  const sub = await line(a.y0 - h * 0.45);
  await w.setParameters({ tessedit_pageseg_mode: '3' });
  const out = { text: title + ' / ' + sub };
  if (/Следующ/i.test(a.t)) {
    const n = /(\d{5,7})/.exec(title.replace(/[OoО]/g, '0'));
    const d = /(\d{2})[.,]?(\d{2})[.,]?\s*(\d{2})[:.](\d{2})/.exec(sub);
    out.cycle = { n: n ? +n[1] : null, next: d ? `${d[1]}.${d[2]}, ${d[3]}:${d[4]}` : null };
  } else {
    const r = /№\s*(\d{3,6})/.exec(title), p = /\$\s?(\d+[.,]\d{2})/.exec(title), nx = /№\s*(\d{3,6})/.exec(sub);
    if (r || p) out.dividend = { report: r ? +r[1] : null, perShare: p ? +p[1].replace(',', '.') : null, next: nx ? +nx[1] : null };
  }
  return out;
}

// Два прохода по всей странице с разной обработкой (что не прочиталось в одном, часто
// читается в другом) и отдельное чтение каждой строки списка.
export async function recognize(file, known = {}, onProgress = () => {}) {
  await templatesReady;
  const w = await getWorker();
  // цифры читаются по эталонам, общий текст нужен для названий и тикера — хватит одного прохода
  const passes = [{ raw: false }];
  const steps = passes.length + 1;
  const texts = [];
  let words = [], wordScale = 1;
  await w.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
  for (let i = 0; i < passes.length; i++) {
    progressCb = (msg, p) => onProgress(`${msg} (${i + 1}/${steps})`, (i + p) / steps);
    progressCb('Подготавливаю картинку…', 0);
    const canvas = await preprocess(file, passes[i]);
    const { data } = await w.recognize(canvas);
    texts.push(data.text);
    if (i === 0) {
      // координаты слов для поиска карточек: в режиме «разреженный текст» (11) подписи
      // карточек находятся надёжно, в автоматическом (3) иногда теряются целиком
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      const sparse = await w.recognize(canvas, {}, { text: true, blocks: true });
      await w.setParameters({ tessedit_pageseg_mode: '3' });
      words = sparse.data.words || [];
      wordScale = canvas.scale;
    }
  }
  const results = texts.map(t => parse(t, known.assets));
  const bmp = await createImageBitmap(file);

  // карточки показателей выбранного актива и нижняя плашка (дивиденды / цикл)
  progressCb = () => {};
  onProgress(`Читаю показатели (${steps}/${steps})`, passes.length / steps);
  const cards = await readCards(bmp, words, wordScale, p => onProgress(`Читаю показатели (${steps}/${steps})`, (passes.length + p * 0.4) / steps));
  const banner = await readBanner(bmp, words, wordScale).catch(() => null);
  const header = await readHeader(bmp, words, wordScale).catch(() => null);
  if (header && (header.price != null || header.change != null)) {
    const kn = (known.assets || []).find(a => a.ticker === header.ticker);
    results.push({ assets: [{ ...header, ticker: kn ? kn.ticker : header.ticker }], indices: [], economy: null, current: header.ticker, company: null, lines: [] });
  }
  if (cards || banner?.cycle || banner?.dividend) {
    const company = cards || { exact: {} };
    if (banner?.cycle) company.cycle = banner.cycle;
    if (banner?.dividend) company.dividend = banner.dividend;
    results.push({ assets: [], indices: [], economy: null, current: null, company, lines: [] });
  }

  const rows = await findRows(file);
  const rowTexts = [];
  if (rows.length) {
    progressCb = () => {};
    onProgress(`Читаю строки списка (${steps}/${steps})`, passes.length / steps);
    const ew = await getEngWorker();
    const read = await readRows(ew, bmp, rows, p => onProgress(`Читаю строки списка (${steps}/${steps})`, (passes.length + 0.4 + p * 0.6) / steps));
    rowTexts.push(...read.map(r => [r.name, r.prices.join(' / '), r.ticker, r.pct].join(' | ')));
    // все цены с запятой, прочитанные на странице целиком, — для сверки
    const pagePrices = new Set(texts.flatMap(t => [...t.matchAll(DOLLAR)].map(m => readNum(m[1])).filter(x => x && x.exact).map(x => x.v.toFixed(2))));
    results.push(parseRows(read, known.assets, pagePrices));
  }
  onProgress('Разбираю цифры…', 1);
  return { ...merge(results, known), text: texts.join('\n———\n') + '\n——— строки ———\n' + rowTexts.join('———\n') + (banner ? '\n——— плашка ———\n' + banner.text : '') };
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
    if (dollars.length !== 1 || /NC\s*Exch|Ориент|Комисс|сч[её]т|счет|портфел|заявк|Доступ|Фундамент/i.test(l)) continue;
    const before = l.slice(0, dollars[0].index);
    // "Долг: $52 000 000" и подобные подписи с двоеточием — не строки списка
    if (/[:;]\s*$/.test(before.trim()) || /Долг|Lonr/i.test(before)) continue;
    const name = nameFrom(before);
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
    const m = /([A-ZА-Я№][A-ZА-Я0-9]{1,9})\s*[·•.,:\-—–]?\s*N[CС]\s*Ex[cс]h/.exec(lines[i]); // OCR пишет и «NC Excha ge»
    if (!m) continue;
    const t = latin(m[1]);
    const kn = byTicker(t);
    current = kn ? kn.ticker : t;
    const rest = [lines[i].slice(m.index + m[0].length), lines[i + 1] || '', lines[i + 2] || ''];
    const price = rest.map(s => [...s.matchAll(DOLLAR)][0]).find(Boolean);
    const nm = [lines[i + 1], lines[i + 2]].map(s => (s || '').replace(/\$.*/, '').match(/([A-Z][A-Za-z0-9&'-]+(?: [A-Z][A-Za-z0-9&'-]+){0,3})\s*$/)).find(Boolean);
    // цену и процент шапки по тексту берём только из той же строки, что тикер (неточно —
    // соседние строки склеиваются со списком и подписями графика); точнее их читает readHeader
    const sameLine = [...rest[0].matchAll(DOLLAR)][0];
    const p0 = sameLine ? readNum(sameLine[1]) : null;
    put(current, {
      price: p0 ? { v: p0.v, exact: false } : null,
      change: readPct(rest[0]) || (!/\$/.test(rest[1]) ? readPct(rest[1]) : null),
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
    // по эталонам точнее; Tesseract — перекрёстная проверка: не совпали — «проверь»
    const gp = r.gPrice ? digitsValue(r.gPrice, 'money') : null;
    const tv = votePrice(r.prices || [], pagePrices);
    const price = gp != null ? { v: gp, exact: !tv || Math.abs(tv.v - gp) < 0.005 } : tv;
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
    const tc = readPct(r.pct || '');
    const change = r.gPct ? { v: r.gPct.v, exact: r.gPct.exact && (!tc || Math.abs(Math.abs(tc.v) - Math.abs(r.gPct.v)) < 0.005) } : tc;
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

export const NUM_FIELDS = ['price', 'change', 'fundamental', 'revenue', 'profit', 'capital', 'debt',
  'circulating', 'maxSupply', 'activity', 'adoption', 'risk', 'orderFlow'];

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
  // показатели карточек — в начало: их значения точнее, чем из общего текста
  if (current) for (const r of [...results].reverse()) if (r.company) all.unshift({ ticker: current, ...r.company });
  const clusters = [];
  for (const x of all) {
    // угаданная запись с той же ценой, что у уже найденной — это она же, прочитанная криво
    const twin = x.guess && x.price != null && clusters.find(c => c.list.some(o => !o.guess && o.price === x.price));
    const c = twin || (x.name
      ? clusters.find(c => c.name && (similar(norm(c.name), norm(x.name)) >= 0.7
        // обрезанное название ("Grid" и "Grid Token")
        || (Math.min(norm(c.name).length, norm(x.name).length) >= 4 && (norm(c.name).startsWith(norm(x.name)) || norm(x.name).startsWith(norm(c.name))))))
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
    for (const k of NUM_FIELDS) {
      let cands = list.map(x => x[k] != null ? { v: x[k], exact: x.exact[k] } : null);
      // фундаментальная цена не бывает в разы дальше рыночной — отсекаем перепутанные колонки
      if (k === 'fundamental' && a.price) cands = cands.filter(c => c && c.v / a.price > 0.5 && c.v / a.price < 2);
      const p = pick(cands, prev[t]?.[k]);
      if (!p) continue;
      a[k] = p.v;
      if (!p.sure) a.unsure.push(k);
    }
    for (const k of ['name', 'type', 'dividend', 'cycle']) {
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

// Для обучения эталонов (dev/train.html): все прямоугольники с цифрами на скриншоте.
// cache — чтобы при повторных прогонах не распознавать скриншот заново (долго).
export async function trainingCrops(file, cache = {}) {
  let data, canvas;
  if (cache[file.name]) ({ data, canvas } = cache[file.name]);
  else {
    const w = await getWorker();
    await w.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
    canvas = await preprocess(file, { raw: false });
    ({ data } = await w.recognize(canvas, {}, { text: true, blocks: true }));
    await w.setParameters({ tessedit_pageseg_mode: '3' });
    cache[file.name] = { data: { words: (data.words || []).map(w => ({ text: w.text, bbox: w.bbox })) }, canvas: { scale: canvas.scale } };
  }
  const bmp = await createImageBitmap(file);
  const rws = await findRows(file);
  const rows = rws.map(r => {
    const bx = rowBoxes(r);
    return { price: glyphCanvas(bmp, bx.price), pct: glyphCanvas(bmp, bx.pct) };
  });
  const hb = headerBoxes(data.words || [], canvas.scale);
  const cards = {};
  for (const f of cardBoxes(bmp, data.words || [], canvas.scale)) {
    cards[f.key] = { val: f.valBox && glyphCanvas(bmp, f.valBox) };
    if (f.sub) cards[f.sub] = { sub: f.subBox && glyphCanvas(bmp, f.subBox, 3, 0.7) };
  }
  return {
    rows,
    header: hb && { ticker: hb.ticker, price: hb.priceBox && glyphCanvas(bmp, hb.priceBox), pct: hb.pctBox && glyphCanvas(bmp, hb.pctBox) },
    cards,
  };
}

export const _debug = { preprocess, getWorker, getEngWorker, findRows, cropRow, splitRow, cropBox, readCards, CARDS, textRuns };
