// MIRRORFALL — entry point.
import { App } from './ui/app.js';

const root = document.getElementById('root');
const canvas = document.getElementById('game');
try {
  window.mirrorfall = new App(root, canvas);
} catch (e) {
  console.error(e);
  root.insertAdjacentHTML('beforeend', `<div class="fatal"><h1>MIRRORFALL</h1><p>Start fehlgeschlagen: ${String(e.message || e)}</p></div>`);
}
