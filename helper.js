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
export async function composeJob(job) {
  const bmps = await Promise.all(job.images.map(async im => {
    const blob = await fetch('data:image/png;base64,' + im.data).then(r => r.blob());
    return createImageBitmap(blob);
  }));
  const gap = 24;
  const c = document.createElement('canvas');
  c.width = Math.max(...bmps.map(b => b.width));
  c.height = bmps.reduce((s, b) => s + b.height, 0) + gap * (bmps.length - 1);
  const g = c.getContext('2d');
  g.fillStyle = '#121722';
  g.fillRect(0, 0, c.width, c.height);
  let y = 0;
  for (const b of bmps) { g.drawImage(b, 0, y); y += b.height + gap; }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new File([blob], `helper-${job.id}.png`, { type: 'image/png' });
}
