// MIRRORFALL — extra screens: daily challenge, replays & ghost race.

import { h, clear, copyText, fmtTime } from './dom.js';
import { button } from './menus.js';
import { store } from './storage.js';
import { CAMPAIGN } from '../levels/campaign.js';
import { dailyKey, dailyRef, dailySeed, generateRoom } from '../levels/daily.js';
import { decodeReplay, LK_CAMPAIGN, LK_DAILY, LK_CUSTOM } from '../sim/replay.js';

/** Run a job in the solver worker; falls back to the main thread if workers are unavailable. */
export function runSolverJob(msg, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    let worker = null;
    try { worker = new Worker(new URL('../tools/solve-worker.js', import.meta.url), { type: 'module' }); } catch { worker = null; }
    if (worker) {
      worker.onmessage = (e) => {
        if (e.data.type === 'progress') onProgress(e.data);
        else { worker.terminate(); resolve(e.data); }
      };
      worker.onerror = async (e) => {
        e.preventDefault?.();
        worker.terminate();
        try { resolve(await mainThread(msg, onProgress)); } catch (err) { reject(err); }
      };
      worker.postMessage(msg);
    } else mainThread(msg, onProgress).then(resolve, reject);
  });
}
async function mainThread(msg, onProgress) {
  const m = await import('../tools/solve-worker.js');
  await new Promise((r) => setTimeout(r, 30));
  let out = null;
  m.handle(msg, (x) => { if (x.type === 'progress') onProgress(x); else out = x; });
  return out;
}

const cache = {};
async function loadDaily(key, onProgress) {
  if (cache[key]) return cache[key];
  const res = await runSolverJob({ type: 'daily', key }, onProgress);
  cache[key] = res.res;
  return res.res;
}

export function showDaily(app) {
  const key = dailyKey();
  app.menus.push({
    title: 'Tagesrätsel',
    build: (el) => {
      const status = h('p', 'Raum wird aus dem Datum erzeugt …');
      const bar = h('div');
      const prog = h('div.progress', bar);
      const body = h('div');
      el.append(h('h2', `Tagesrätsel · ${key}`), status, prog, body, h('div.btnrow', button('Zurück', () => app.menus.pop(), { autofocus: true })));
      let p = 0;
      const tick = setInterval(() => { p = Math.min(92, p + 4); bar.style.width = p + '%'; }, 120);
      loadDaily(key, (pr) => { status.textContent = `Kandidat ${pr.attempt + 1}: Solver-Bot prüft Lösbarkeit …`; }).then((res) => {
        clearInterval(tick);
        bar.style.width = '100%';
        if (!res) { status.textContent = 'Heute konnte kein beweisbar lösbarer Raum erzeugt werden.'; return; }
        const g = res.runs.length - 1;
        const best = store.daily(key);
        status.innerHTML = '';
        status.append(h('span.ok', '✔ Lösbarkeit bewiesen'), ` — der Bot entkommt mit ${g} Geist${g === 1 ? '' : 'ern'} in ${fmtTime(res.finalTick)} (Kandidat ${res.attempt + 1}, ${res.stats.expansions} Suchknoten).`);
        clear(body);
        body.append(
          h('dl.kv',
            h('dt', 'Aufbau'), h('dd', `${res.meta.zones} Zonen · ${res.meta.gates.join(' → ')}${res.meta.vault ? ' → Duo-Tresor' : ''}`),
            h('dt', 'Par'), h('dd', fmtTime(res.def.par)),
            h('dt', 'Deine Bestzeit'), h('dd', best ? `${fmtTime(best.tick)} ${best.stars.map((s) => (s ? '★' : '☆')).join('')}` : '—'),
          ),
          h('div.btnrow',
            button('Spielen', () => app.startLevel(res.def, { mode: 'daily', dailyKey: key, dailyRef: dailyRef(key) * 32 + res.attempt }), { cls: 'primary', autofocus: true }),
            button('Bot-Lösung ansehen (Spoiler)', () => app.startLevel(res.def, { mode: 'daily', dailyKey: key, dailyRef: dailyRef(key) * 32 + res.attempt, playback: { runs: res.runs } })),
          ),
        );
        app.menus.focusFirst();
      }).catch((e) => { clearInterval(tick); status.textContent = 'Fehler: ' + e.message; });
    },
  });
}

/** Resolve the level for any replay (campaign, daily, custom editor level). */
export function levelForReplay(app, kind, ref) {
  if (kind === LK_CAMPAIGN) return CAMPAIGN[ref] ? { def: CAMPAIGN[ref], mode: 'campaign', index: ref } : null;
  if (kind === LK_DAILY) {
    const date = Math.floor(ref / 32), attempt = ref % 32;
    const s = String(date);
    const key = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    const { def } = generateRoom((dailySeed(key) + attempt * 7919) >>> 0);
    def.name = `Tagesrätsel ${key}`; def.id = `d${date}`;
    return { def, mode: 'daily', dailyKey: key, dailyRef: ref };
  }
  return app.levelForReplay(kind, ref);
}

export function showReplays(app, prefill = '') {
  app.menus.push({
    title: 'Replays',
    build: (el) => {
      const ta = h('textarea', { 'aria-label': 'Replay-Code', placeholder: 'Replay-Code einfügen (MF1.…)' }, prefill);
      const info = h('div.note');
      const actions = h('div.btnrow');
      const check = () => {
        clear(actions);
        info.textContent = '';
        let rep;
        try { rep = decodeReplay(ta.value); } catch (e) { info.innerHTML = ''; info.append(h('span.bad', e.message)); return; }
        const lv = levelForReplay(app, rep.kind, rep.ref);
        if (!lv) { info.append(h('span.bad', 'Level dieses Replays ist hier nicht vorhanden (eigene Editor-Level müssen importiert sein).')); return; }
        const v = app.checkReplay(lv.def, rep.runs);
        info.append(
          h('strong', lv.def.name), ` · ${rep.runs.length - 1} Geister · `,
          v.ok ? h('span.ok', `gültig, Flucht nach ${fmtTime(v.tick)} — deterministisch nachsimuliert`) : h('span.bad', 'ungültig (Zeitlinie bricht oder kein Sieg)'),
        );
        if (v.ok) {
          actions.append(
            button('Ansehen', () => app.startLevel(lv.def, { ...lv, playback: { runs: rep.runs } }), { cls: 'primary' }),
            button('Ghost-Rennen gegen diese Lösung', () => app.startLevel(lv.def, { ...lv, rival: { runs: rep.runs } })),
          );
        }
        app.menus.focusFirst(actions.querySelector('button'));
      };
      const list = h('div.stack');
      for (const r of store.savedReplays()) {
        list.append(h('div.row', { style: { gridTemplateColumns: '1fr auto auto' } },
          h('span.lab', `${r.title}`, h('small', `${r.date} · ${fmtTime(r.tick)} · ${r.code.length} Zeichen`)),
          button('Laden', () => { ta.value = r.code; check(); }, { cls: 'small' }),
          button('Kopieren', async () => app.toast(await copyText(r.code) ? 'Kopiert' : 'Kopieren nicht möglich'), { cls: 'small' }),
        ));
      }
      el.append(
        h('h2', 'Replays & Ghost-Rennen'),
        h('p', 'Ein Replay enthält nur die lauflängenkodierten Eingaben. Alles andere wird deterministisch nachsimuliert — so lassen sich fremde Lösungen prüfen, ansehen und als Geist-Rivale herausfordern.'),
        ta, h('div.btnrow', button('Prüfen', check, { autofocus: true })), info, actions,
        h('h2', { style: { marginTop: '18px' } }, 'Eigene Replays'),
        list.childNodes.length ? list : h('p.note', 'Noch keine — jede Flucht wird hier gespeichert.'),
        h('div.btnrow', button('Zurück', () => app.menus.pop())),
      );
      if (prefill) setTimeout(check, 50);
    },
  });
}
