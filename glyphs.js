// Чтение цифр шрифтом NC Exchange по эталонам.
// Tesseract — универсальный распознаватель и путает жирные цифры игры (5↔8, 0↔C),
// а разрезать строку на знаки ненадёжно: жирные цифры слипаются, «1» тонкая.
// Поэтому эталоны знаков прикладываются к строке во всех позициях, и подбирается
// последовательность знаков, лучше всего объясняющая всю строку (динамическое
// программирование, как в старых распознавателях номеров).
// Эталоны (templates.js) собираются со скриншотов с известными значениями: dev/train.js.

const CAP = 16;        // высота цифры после приведения
const NH = 31;         // высота строки: выше цифр — верх «$», ниже — хвост запятой и «$»
const TOPPAD = 8;      // сколько пикселей над цифрами
const EPS = 0.04;

// Привести вырезку (тёмный текст на светлом) к высоте цифр CAP. Возвращает бинарную картинку.
export function normalize(canvas) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) ink[i] = d[i * 4] < 128 ? 1 : 0;
  // полоса цифр — самый длинный отрезок строк, где закрашено заметно
  const rows = new Array(H).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rows[y] += ink[y * W + x];
  const maxRow = Math.max(...rows);
  if (!maxRow) return null;
  let best = null, start = -1;
  for (let y = 0; y <= H; y++) {
    const on = y < H && rows[y] >= maxRow * 0.2;
    if (on && start < 0) start = y;
    if (!on && start >= 0) { if (!best || y - start > best[1] - best[0]) best = [start, y]; start = -1; }
  }
  const top = best[0], capH = Math.max(3, best[1] - best[0]);
  const k = CAP / capH;
  // столбцы с текстом (без пустых краёв)
  let xa = W, xb = -1;
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (ink[y * W + x]) { if (x < xa) xa = x; if (x > xb) xb = x; break; }
  if (xb < 0) return null;
  const NW = Math.max(1, Math.round((xb - xa + 1) * k));
  const img = new Uint8Array(NW * NH);
  for (let ny = 0; ny < NH; ny++) {
    const sy0 = top + (ny - TOPPAD) / k, sy1 = top + (ny - TOPPAD + 1) / k;
    for (let nx = 0; nx < NW; nx++) {
      const sx0 = xa + nx / k, sx1 = xa + (nx + 1) / k;
      let n = 0, on = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) {
        if (y < 0 || y >= H) continue;
        for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) { if (x < 0 || x >= W) continue; n++; on += ink[y * W + x]; }
      }
      img[ny * NW + nx] = n && on / n >= 0.5 ? 1 : 0;
    }
  }
  return { img, W: NW };
}

let TPL = null;
export function setTemplates(t) {
  if (!t) { TPL = null; return; }
  if (t.sure) setSure(t.sure[0], t.sure[1]);
  TPL = { spaceGap: t.spaceGap, items: [] };
  for (const it of t.items) {
    const p = Float32Array.from(it.p, ch => Math.min(1 - EPS, Math.max(EPS, parseInt(ch, 36) / 35)));
    const base = { c: it.c, style: it.s, w: it.w, lp1: p.map(Math.log), lp0: p.map(v => Math.log(1 - v)) };
    TPL.items.push(base);
  }
}
export const hasTemplates = () => !!(TPL && TPL.items.length);

// Сумма логарифмов правдоподобия: шаблон t в столбцах [x, x+w), со сдвигом по вертикали dy.
function matchScore(n, t, x, dy) {
  let s = 0;
  for (let ty = 0; ty < NH; ty++) {
    const y = ty + dy;
    for (let tx = 0; tx < t.w; tx++) {
      const v = y >= 0 && y < NH ? n.img[y * n.W + x + tx] : 0;
      s += v ? t.lp1[ty * t.w + tx] : t.lp0[ty * t.w + tx];
    }
  }
  return s;
}

const BLANK1 = Math.log(EPS), BLANK0 = Math.log(1 - EPS);
// штраф за каждый поставленный знак — иначе строку выгодно «дробить» на лишние знаки
const PER_CHAR = -6;
// пороги уверенности — подобраны на обучающих скриншотах (dev/train.js печатает статистику)
let SURE_WORST = -0.32, SURE_LEFTOVER = 3;
export function setSure(w, l) { SURE_WORST = w; SURE_LEFTOVER = l; }

// Прочитать строку. style — набор эталонов ('b' жирные значения, 'p' проценты, 'r' мелкий
// серый текст). freePrefix — слева могут быть слова или стрелка, их можно пропустить.
export function readGlyphs(canvas, { style = 'b', freePrefix = false } = {}) {
  if (!hasTemplates()) return null;
  const n = normalize(canvas);
  if (!n) return null;
  // эталоны нужного стиля; знаки, которых в этом стиле не было при обучении, — из других
  const own = TPL.items.filter(t => t.style === style);
  const have = new Set(own.map(t => t.c));
  const tpls = [...own, ...TPL.items.filter(t => t.style !== style && !have.has(t.c))];
  if (!tpls.length) return null;
  const W = n.W;
  const colInk = new Array(W).fill(0);
  for (let x = 0; x < W; x++) for (let y = 0; y < NH; y++) colInk[x] += n.img[y * W + x];
  // пустой столбец между знаками почти бесплатен, закрашенный пропустить дорого
  const blank = x => colInk[x] * BLANK1 + (NH - colInk[x]) * BLANK0;
  // «мусор» слева (слова, стрелка): пропустить дешевле, чем плохо совпавшая цифра
  const junk = x => colInk[x] * -1.2 + (NH - colInk[x]) * BLANK0;
  // dpJ — ещё ни одного знака (только мусор слева), dpC — знаки уже пошли
  const dpJ = new Float64Array(W + 1).fill(-Infinity), dpC = new Float64Array(W + 1).fill(-Infinity);
  const backC = new Array(W + 1);
  dpJ[0] = 0;
  for (let x = 1; x <= W; x++) {
    if (freePrefix) dpJ[x] = dpJ[x - 1] + junk(x - 1);
    const sb = dpC[x - 1] + blank(x - 1);
    if (sb > dpC[x]) { dpC[x] = sb; backC[x] = { from: x - 1, prev: 'C' }; }
    for (const t of tpls) {
      if (x < t.w) continue;
      const from = x - t.w;
      const prevBest = Math.max(dpC[from], dpJ[from]);
      if (prevBest === -Infinity) continue;
      let m = -Infinity;
      for (const dy of [-1, 0, 1]) m = Math.max(m, matchScore(n, t, from, dy));
      const s = prevBest + m + PER_CHAR;
      if (s > dpC[x]) { dpC[x] = s; backC[x] = { from, c: t.c, score: m / (t.w * NH), prev: dpC[from] >= dpJ[from] ? 'C' : 'J' }; }
    }
  }
  // восстановить путь
  const chars = [];
  for (let x = W, state = 'C'; x > 0 && state === 'C';) {
    const b = backC[x];
    if (!b) break;
    if (b.c) chars.unshift({ c: b.c, x0: b.from, x1: x, score: b.score });
    state = b.prev;
    x = b.from;
  }
  if (!chars.length) return null;
  let text = '';
  chars.forEach((ch, i) => {
    if (i && ch.x0 - chars[i - 1].x1 > TPL.spaceGap * CAP) text += ' ';
    text += ch.c;
  });
  // уверенность: каждый знак хорошо совпал с эталоном, и не осталось непрочитанной краски
  const worst = Math.min(...chars.map(ch => ch.score));
  let leftover = 0;
  const covered = new Uint8Array(W);
  for (const ch of chars) for (let x = ch.x0; x < ch.x1; x++) covered[x] = 1;
  // непрочитанная краска внутри числа (между первым и последним знаком)
  for (let x = chars[0].x0; x < chars[chars.length - 1].x1; x++) if (!covered[x]) leftover += colInk[x];
  return { text, worst, leftover, sure: worst > SURE_WORST && leftover <= SURE_LEFTOVER };
}

/* ---------------- обучение ---------------- */

// Разбить нормализованную строку на знаки: связные пятна; части одного знака (кружки и
// черта у %) склеиваются, слипшиеся знаки режутся по тонкой «шейке». Нужно только для
// первых образцов при обучении: используются строки, где число кусков совпало с ответом.
function cutColumns(n) {
  const W = n.W, ink = n.img;
  const label = new Int32Array(W * NH).fill(-1);
  const comps = [];
  for (let i = 0; i < W * NH; i++) {
    if (!ink[i] || label[i] >= 0) continue;
    const c = { x0: W, x1: 0, px: [] };
    const st = [i]; label[i] = comps.length;
    while (st.length) {
      const p = st.pop(), x = p % W, y = (p / W) | 0;
      c.px.push(p); if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= NH) continue;
        const q = ny * W + nx;
        if (ink[q] && label[q] < 0) { label[q] = comps.length; st.push(q); }
      }
    }
    comps.push(c);
  }
  const big = comps.filter(c => c.px.length >= 3).sort((a, b) => a.x0 - b.x0);
  const merged = [];
  for (const c of big) {
    const m = merged.find(o => {
      const ov = Math.min(o.x1, c.x1) - Math.max(o.x0, c.x0) + 1;
      return ov > 0 && ov >= Math.min(o.x1 - o.x0 + 1, c.x1 - c.x0 + 1) * 0.5;
    });
    if (m) { m.x0 = Math.min(m.x0, c.x0); m.x1 = Math.max(m.x1, c.x1); m.px.push(...c.px); } else merged.push({ ...c, px: [...c.px] });
  }
  const out = [];
  const split = c => {
    const w = c.x1 - c.x0 + 1;
    if (w > CAP * 0.45) {
      const col = new Array(w).fill(0);
      for (const p of c.px) col[(p % W) - c.x0]++;
      let cut = -1, min = Infinity;
      for (let x = Math.max(2, Math.round(w * 0.2)); x <= Math.min(w - 3, Math.round(w * 0.8)); x++) if (col[x] < min) { min = col[x]; cut = x; }
      if (cut > 0 && (w > CAP * 1.05 || min <= 2)) {
        const L = { x0: c.x0, x1: c.x0 + cut - 1, px: c.px.filter(p => (p % W) - c.x0 < cut) };
        const R = { x0: c.x0 + cut, x1: c.x1, px: c.px.filter(p => (p % W) - c.x0 >= cut) };
        split(L); split(R); return;
      }
    }
    out.push([c.x0, c.x1 + 1]);
  };
  merged.sort((a, b) => a.x0 - b.x0).forEach(split);
  return out;
}

// Образцы знаков из строки с известным ответом. fromRight — сопоставлять с конца
// (слева могут быть слова или стрелка).
export function samples(canvas, truth, { style = 'b', fromRight = false } = {}) {
  const n = normalize(canvas);
  if (!n) return null;
  const chars = [...truth.replace(/ /g, '')];
  let parts = cutColumns(n);
  if (fromRight) { if (parts.length < chars.length) return null; parts = parts.slice(parts.length - chars.length); }
  else if (parts.length !== chars.length) return null;
  const items = parts.map(([x0, x1], i) => {
    const w = x1 - x0, px = new Uint8Array(w * NH);
    for (let y = 0; y < NH; y++) for (let x = 0; x < w; x++) px[y * w + x] = n.img[y * n.W + x0 + x];
    return { c: chars[i], s: style, w, px };
  });
  // промежутки между знаками: пробел или нет
  const spaced = [];
  let k = 0;
  for (const ch of truth) { if (ch === ' ') spaced[k - 1] = true; else k++; }
  const gaps = [];
  for (let i = 1; i < parts.length; i++) gaps.push({ gap: (parts[i][0] - parts[i - 1][1]) / CAP, space: !!spaced[i - 1] });
  return { items, gaps };
}

// Образцы через «принудительное выравнивание»: ответ известен, ищем, где в строке стоит
// каждый его знак. Знак без эталона подбирается «пустышкой» любой ширины — его место
// определяется соседями. Так собираются образцы даже со слипшихся цифр.
export function alignedSamples(canvas, truth, { style = 'b', freePrefix = false } = {}) {
  const n = normalize(canvas);
  if (!n) return null;
  const chars = [...truth.replace(/ /g, '')];
  const W = n.W, L = chars.length;
  const colInk = new Array(W).fill(0);
  for (let x = 0; x < W; x++) for (let y = 0; y < NH; y++) colInk[x] += n.img[y * W + x];
  const blank = x => colInk[x] * BLANK1 + (NH - colInk[x]) * BLANK0;
  const junk = x => colInk[x] * -1.2 + (NH - colInk[x]) * BLANK0;
  const tplFor = c => {
    const own = (TPL ? TPL.items : []).filter(t => t.c === c && t.style === style);
    if (own.length) return own;
    const any = (TPL ? TPL.items : []).filter(t => t.c === c);
    if (any.length) return any;
    // пустышка: любая ширина, вероятность 0.5 — место знака определят соседи
    const out = [];
    for (let w = 3; w <= 14; w++) out.push({ c, w, lp1: new Float32Array(w * NH).fill(Math.log(0.5)), lp0: new Float32Array(w * NH).fill(Math.log(0.5)) });
    return out;
  };
  const T = chars.map(tplFor);
  // dp[i][x]: поставлены первые i знаков, просмотрено x столбцов
  const dp = Array.from({ length: L + 1 }, () => new Float64Array(W + 1).fill(-Infinity));
  const bk = Array.from({ length: L + 1 }, () => new Array(W + 1));
  dp[0][0] = 0;
  for (let x = 1; x <= W; x++) if (freePrefix) { dp[0][x] = dp[0][x - 1] + junk(x - 1); bk[0][x] = { x: x - 1, i: 0 }; }
  for (let i = 0; i <= L; i++) {
    for (let x = 1; x <= W; x++) {
      if (i > 0) {
        const sb = dp[i][x - 1] + blank(x - 1);
        if (sb > dp[i][x]) { dp[i][x] = sb; bk[i][x] = { x: x - 1, i }; }
        for (const t of T[i - 1]) {
          if (x < t.w || dp[i - 1][x - t.w] === -Infinity) continue;
          let m = -Infinity;
          for (const dy of [-1, 0, 1]) m = Math.max(m, matchScore(n, t, x - t.w, dy));
          const s = dp[i - 1][x - t.w] + m + PER_CHAR;
          if (s > dp[i][x]) { dp[i][x] = s; bk[i][x] = { x: x - t.w, i: i - 1, place: true }; }
        }
      }
    }
  }
  if (dp[L][W] === -Infinity) return null;
  const placed = [];
  for (let i = L, x = W; x > 0 && bk[i][x];) {
    const b = bk[i][x];
    if (b.place) placed.unshift([b.x, x]);
    i = b.i; x = b.x;
  }
  if (placed.length !== L) return null;
  // подрезать каждый кусок до закрашенных столбцов
  const items = placed.map(([x0, x1], k) => {
    while (x0 < x1 - 1 && !colInk[x0]) x0++;
    while (x1 > x0 + 1 && !colInk[x1 - 1]) x1--;
    const w = x1 - x0, px = new Uint8Array(w * NH);
    for (let y = 0; y < NH; y++) for (let x = 0; x < w; x++) px[y * w + x] = n.img[y * n.W + x0 + x];
    return { c: chars[k], s: style, w, px, x0, x1 };
  });
  const spaced = [];
  let k = 0;
  for (const ch of truth) { if (ch === ' ') spaced[k - 1] = true; else k++; }
  const gaps = [];
  for (let i = 1; i < items.length; i++) gaps.push({ gap: (items[i].x0 - items[i - 1].x1) / CAP, space: !!spaced[i - 1] });
  return { items, gaps };
}

// Усреднить образцы одного знака в эталон (вероятность закраски каждого пикселя).
export function buildTemplates(items, spaceGap) {
  const groups = new Map();
  for (const it of items) {
    const key = it.s + '|' + it.c;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const out = [];
  for (const [, list] of groups) {
    const ws = list.map(i => i.w).sort((a, b) => a - b);
    const w = ws[ws.length >> 1];
    // эталоны шириной w-1, w, w+1 — ширина знака на разных скриншотах чуть гуляет
    for (const tw of [w - 1, w, w + 1]) {
      if (tw < 1) continue;
      const acc = new Float32Array(tw * NH);
      for (const it of list) {
        for (let y = 0; y < NH; y++) for (let x = 0; x < tw; x++) {
          const sx = Math.min(it.w - 1, Math.floor(x * it.w / tw));
          acc[y * tw + x] += it.px[y * it.w + sx];
        }
      }
      out.push({ c: list[0].c, s: list[0].s, w: tw, p: Array.from(acc, v => Math.round(v / list.length * 35).toString(36)).join('') });
    }
  }
  return { spaceGap, items: out };
}
