// MIRRORFALL — solver worker (module worker). Keeps the UI responsive while
// the bot proves the daily room or checks an editor level.
import { solve } from './solver.js';
import { dailyChallenge, DAILY_SOLVER_OPTS } from '../levels/daily.js';

export function handle(m, post) {
  if (m.type === 'daily') {
    const res = dailyChallenge(m.key, (def) => solve(def, DAILY_SOLVER_OPTS), (p) => post({ type: 'progress', attempt: p.attempt }));
    post({ type: 'daily', res: res && { key: res.key, attempt: res.attempt, def: res.def, runs: res.solution.runs, finalTick: res.solution.finalTick, roles: res.solution.roles, stats: res.solution.stats, meta: res.meta } });
  } else if (m.type === 'solve') {
    const r = solve(m.def, { maxGhosts: 4, timeLimitMs: m.timeLimitMs ?? 25000 });
    post({ type: 'solved', r: { ok: r.ok, runs: r.runs, finalTick: r.finalTick, roles: r.roles, stats: r.stats, timedOut: r.timedOut } });
  }
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = (e) => handle(e.data, (msg) => self.postMessage(msg));
}
