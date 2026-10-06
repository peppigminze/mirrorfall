// MIRRORFALL — replays/ghost race and daily challenge screens (phase 5).
import { h } from './dom.js';
import { button } from './menus.js';

export function showReplays(app) {
  app.menus.push({ title: 'Replays', build: (el) => el.append(h('h2', 'Replays'), h('p', 'In Arbeit.'), button('Zurück', () => app.menus.pop(), { autofocus: true })) });
}
export function showDaily(app) {
  app.menus.push({ title: 'Tagesrätsel', build: (el) => el.append(h('h2', 'Tagesrätsel'), h('p', 'In Arbeit.'), button('Zurück', () => app.menus.pop(), { autofocus: true })) });
}
