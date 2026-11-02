// Связь с программой-помощником для ПК (download/NCXHelper.exe). Помощник по горячей
// клавише снимает из окна MTA шапку и карточки выбранного актива и держит снимки у себя
// на 127.0.0.1; сайт забирает их, распознаёт и сохраняет, а итог отправляет обратно —
// помощник показывает его уведомлением поверх игры.
// другой порт — только для проверки сайта рядом с запущенным помощником
const BASE = 'http://127.0.0.1:' + (localStorage.getItem('ncx-helper-port') || 47615);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let running = false;
export const helper = { connected: false, game: false };

// handle(job) → { status: 'ok' | 'check' | 'error', title, text }
export function startHelper({ handle, onChange }) {
  if (running) return;
  running = true;
  const set = (on, game = helper.game) => {
    if (helper.connected === on && helper.game === game) return;
    helper.connected = on; helper.game = game;
    onChange();
  };
  (async () => {
    while (running) {
      try {
        const st = await fetch(BASE + '/status', { cache: 'no-store' }).then(r => r.json());
        set(true, st.game);
        // длинный опрос: помощник держит запрос, пока не появится снимок (до 25 с).
        // Цикл на ответах, а не на таймерах — не засыпает во вкладке в фоне.
        while (running) {
          const r = await fetch(BASE + '/next', { cache: 'no-store' });
          if (r.status === 204) continue;
          if (!r.ok) throw new Error('helper ' + r.status);
          const job = await r.json();
          let res;
          try { res = await handle(job); } catch (e) { console.error(e); res = { status: 'error', title: 'Не получилось распознать', text: e.message }; }
          await fetch(BASE + '/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, ...res }) }).catch(() => {});
        }
      } catch {
        set(false);
        await sleep(5000);
      }
    }
  })();
}

export function stopHelper() { running = false; helper.connected = false; }

// Снимки помощника (шапка, карточки) — одной картинкой друг под другом, как на экране.
export async function composeJob(job, k = 1) {
  const bmps = await Promise.all(job.images.map(async im => {
    const blob = await fetch('data:image/png;base64,' + im.data).then(r => r.blob());
    return createImageBitmap(blob);
  }));
  const gap = 24;
  const c = document.createElement('canvas');
  const W = b => Math.round(b.width * k), H = b => Math.round(b.height * k);
  c.width = Math.max(...bmps.map(W));
  c.height = bmps.reduce((s, b) => s + H(b), 0) + gap * (bmps.length - 1);
  const g = c.getContext('2d');
  g.fillStyle = '#121722';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  let y = 0;
  for (const b of bmps) { g.drawImage(b, 0, y, W(b), H(b)); y += H(b) + gap; }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new File([blob], `helper-${job.id}.png`, { type: 'image/png' });
}

// Рамки (в пикселях) со снимка всего экрана — той же картинкой, что присылает программа.
export async function cropFrames(file, rects) {
  const bmp = await createImageBitmap(file);
  const images = rects.filter(Boolean).map((r, i) => {
    const c = document.createElement('canvas');
    c.width = Math.round(r.w); c.height = Math.round(r.h);
    c.getContext('2d').drawImage(bmp, -Math.round(r.x), -Math.round(r.y));
    return { name: i ? 'cards' : 'header', data: c.toDataURL('image/png').split(',')[1] };
  });
  return composeJob({ id: 'frames', images });
}

// Как значение выглядит на экране игры — так его ждёт обучение эталонов цифр (dev/train.js)
const KIND = {
  price: 'money', fundamental: 'money', revenue: 'money', profit: 'money', capital: 'money', debt: 'money',
  circulating: 'int', maxSupply: 'int', activity: 'pct1', adoption: 'pct1', risk: 'pct2', orderFlow: 'pct2',
};
function gameText(v, kind, sign = false) {
  const dec = kind === 'money' || kind === 'pct2' ? 2 : kind === 'pct1' ? 1 : 0;
  const [i, f] = Math.abs(v).toFixed(dec).split('.');
  const n = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f ? ',' + f : '');
  if (kind === 'money') return (v < 0 ? '-' : '') + '$' + n;
  if (kind === 'int') return n;
  return (v < 0 ? '-' : sign && v > 0 ? '+' : '') + n + '%';
}

// Снимок с правильными значениями — программа складывает такие в папку для дообучения.
// verified: значения проверил человек (иначе — уверенно прочитанные автоматически).
export async function sendSample(id, file, item, verified) {
  if (!helper.connected || item.price == null) return;
  try {
    const image = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(file); });
    const cards = {};
    for (const [k, kind] of Object.entries(KIND)) if (k !== 'price' && item[k] != null) cards[k] = gameText(item[k], kind);
    const truth = { header: [item.ticker, gameText(item.price, 'money'), item.change != null ? gameText(item.change, 'pct2', true) : null], cards, rows: [], verified };
    await fetch(BASE + '/sample', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, image, truth }) });
  } catch { /* образец не обязателен */ }
}
