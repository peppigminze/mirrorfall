// MIRRORFALL — share string with an emoji summary of the loops.
//   🟦 ghost recorded · 🟥 alarm · 🟪 paradox · ⬜ discarded (timeline full) · 🟩 escape

const EMO = { ghost: '🟦', alarm: '🟥', paradox: '🟪', full: '⬜', win: '🟩' };

export function shareString({ title, result, url }) {
  const stars = result.starFlags.map((s) => (s ? '★' : '☆')).join('');
  const loops = result.log.map((e) => EMO[e] || '').join('');
  const lines = [
    `MIRRORFALL · ${title}`,
    `${stars}  ⏱ ${(result.tick / 60).toFixed(2)} s  👻 ${result.ghosts}  🚨 ${result.alarms}  ⧖ ${result.paradoxes}`,
    loops.length > 40 ? loops.slice(0, 40 * 2) + '…' : loops,
  ];
  if (url) lines.push(url);
  return lines.join('\n');
}
