# MIRRORFALL

**Ein Zeitschleifen-Heist im Browser.** Du hast 30 Sekunden. Dann spult die Zeit
zurück — und jeder frühere Durchlauf läuft als Geist weiter. Halte mit deinem
Vergangenheits-Ich Druckplatten, lenke Wachen mit Münzen ab, öffne zu zweit den
Duo-Tresor. Aber Vorsicht: Änderst du, was ein Geist erlebt hat, entsteht ein
**Zeitparadox** und die Zeitlinie bricht ab diesem Geist.

* 12 handgebaute Level (Lernkurve ohne Text-Tutorial, Level 9–12 mit Paradox-Fallen)
* Tagesrätsel: Raum aus dem Datum, Lösbarkeit **vor** dem Spielen vom Solver-Bot bewiesen
* Replays als kurzer Code (nur Eingaben, 43–135 Zeichen) + Ghost-Rennen gegen fremde Lösungen
* Level-Editor mit Live-Vorschau, Test-Modus, Bot-Prüfung, JSON-Export/-Import
* Neon-Noir-Grafik in WebGL2 mit eigenen Shadern (Canvas2D-Fallback), generative Musik
* **Keine** Libraries, **keine** Bild- oder Audiodateien — alles prozedural, ~8 900 Zeilen eigener Code

---

## Starten

ES-Module brauchen einen Webserver (Öffnen per `file://` blockiert der Browser).

```bash
node tools/serve.mjs          # → http://localhost:8080   (oder: npm start)
# alternativ: python3 -m http.server 8080
```

Auf GitHub direkt spielbar machen: *Settings → Pages → Branch `main`, Ordner `/ (root)`*.

Nützliche URL-Parameter: `?level=7` (direkt in ein Level), `?q=low|med|high`
(Qualität erzwingen), `?r=2d` (Canvas2D-Renderer), `?replay=MF1.…` (Replay öffnen).

## Steuerung

| Aktion | Tastatur | Gamepad | Touch |
|---|---|---|---|
| Bewegen | WASD / Pfeile | Linker Stick / D-Pad | Virtueller Stick (linke Hälfte) |
| Aktion (Schalter, Terminal halten, Münze werfen) | Leertaste / J | A | ● |
| Jetzt zurückspulen (Rest: stehen bleiben) | Q | X | ⟲ |
| Letzte Schleife rückgängig | ⌫ / Z | Y | ↶ |
| Zeitraffer | Shift halten · F umschalten | RB | » |
| Neustart / Pause | R / Esc | – / Start | ❚❚ |

Menüs sind vollständig per Tastatur (Pfeile, Enter, Esc) und Gamepad bedienbar.
Der Editor hat Tastenkürzel für jedes Werkzeug (angezeigt), Pfeile bewegen den
Cursor, Leertaste setzt, Entf radiert, 1–8 wählt den Signalkanal, Strg+Z.

## Spielregeln in Kürze

* Raster 30×17, Tile 32 px, Schleife = 1800 Ticks (60 Hz), max. 4 Geister.
* **Druckplatte** öffnet Türen ihres Kanals nur solange jemand darauf steht; **Schalter** bleibt umgelegt.
* **Laser** im Takt, **Wachen** (Sichtkegel 70°, 6 Felder, 0,4 s bis Alarm), **Kameras** (schwenkend).
* **Duo-Tresor**: beide Terminals 0,5 s gleichzeitig halten. **Beute** muss im *selben* Durchlauf zum Ausgang.
* **Köder-Münze**: Wachen in Hörweite untersuchen den Aufschlag. **Plattform** fährt über Abgründe.
* Jeder Kanal hat Farbe **und** Symbol **und** Zählpunkte (Kanal k = k+1 Punkte), jeder Geist Farbe **und** Form.
* Sterne: ★ gelöst · ★ unter Par · ★ null Alarme.

## Barrierefreiheit

Farbenblind-Modus (Okabe-Ito-Palette, schraffierte Sichtkegel, Laser mit Punktmuster),
reduzierte Bewegung (respektiert `prefers-reduced-motion`; kein Wackeln, kürzere Effekte,
weniger Partikel), getrennte Lautstärkeregler, volle Tastaturnavigation, ARIA-Labels,
Touch-Steuerung, Kamera mit Mindest-Kachelgröße auf kleinen Bildschirmen.

## Architektur

```
index.html → main.js → ui/app.js
  ui/        Session-Controller, Eingabe, HUD, Menüs, Speicher, Share      (darf alles)
  render/    View-Modell, WebGL2-Pipeline, Canvas2D-Fallback, Partikel      (nur sim)
  audio/     Engine/Mixing, generative Musik, SFX                          (nur sim/rng)
  levels/    Kampagne, Daily-Generator, Bot-Lösungen                       (nur sim)
  tools/     Solver-Bot, Editor, Worker, Dev-Server, Tests
  sim/       deterministische Simulation — importiert NUR sim/            (rein, int32)
```

Die Simulation ist ein einziges `Int32Array` pro Schleife und eine `step()`-Funktion
mit fester Reihenfolge, rein ganzzahlig (Richtungen aus einer eingebrannten Tabelle,
kein `Math.random`/`Date`/Trig). Geister sind echte Agenten, die ihre aufgezeichneten
Eingaben einspeisen; die Welt wird jeden Tick aus allen Aufzeichnungen berechnet.
Ein Paradox ist eine Abweichung eines Geistes von seiner kanonischen Signaturspur.
Details, Datenformate und Risiken: **[DESIGN.md](DESIGN.md)**.
Testergebnisse, Entscheidungen und Selbst-Review: **[REPORT.md](REPORT.md)**.

| Ordner | Wichtigste Dateien |
|---|---|
| `sim/` | `world.js` (Zustand + `step`), `timeline.js` (Geister, Paradox), `level.js`, `replay.js`, `input.js`, `rng.js`, `dirtable.js` |
| `render/` | `renderer-gl.js`, `shaders.js` (Licht mit SDF-Schatten, Bloom, Post), `particles.js`, `sdf.js`, `view.js`, `renderer-2d.js`, `quality.js` |
| `audio/` | `engine.js` (Limiter, Sidechain, Hall), `music.js` (generativ, adaptiv), `sfx.js` |
| `ui/` | `app.js`, `game.js` (Schleifen-Logik), `input.js`, `touch.js`, `hud.js`, `menus.js`, `screens-extra.js` |
| `tools/` | `solver.js` (Bot), `editor.js`, `solve-worker.js`, `serve.mjs`, `levelcheck.mjs`, `tests/` |

## Tests

Alles in Node ≥ 18 ohne Abhängigkeiten (Browser-Tests optional mit global installiertem Playwright).

```bash
npm test                 # alle Node-Tests (~4 min)
npm run test:quick       # reduzierte Wiederholungen
npm run test:all         # inkl. Browser-Integration (Playwright + Chromium)
node tools/tests/determinism.mjs 1000   # (a) 1000× gleiche Aufnahme → identische Hashes
node tools/tests/solver.mjs             # (b) Bot löst 12 Level + Paradox-Beweis L9–12
node tools/tests/fuzz.mjs 10000         # (c) 10 000 Zufallseingaben, Invarianten, NaN-Wächter
node tools/tests/bench-sim.mjs          # (d) Sim-Durchsatz
node tools/tests/bench-frame.mjs        # (d) CPU-Kosten pro Frame
node tools/tests/browser.mjs            # (d) Browser-Tests + Frame-Time-Report
node tools/levelcheck.mjs 5 --solve --trace   # ein Level ansehen & lösen
```

| Suite | Prüft |
|---|---|
| `boundaries` | Importgrenzen (sim importiert nur sim), keine Libraries, keine nichtdeterministischen APIs in sim |
| `rules` | 21 Regelszenarien (Platte/Tür, Münzdiebstahl → Paradox, 0,4-s-Alarm, Tresor, Plattform, Laser, …) |
| `solver` | 12/12 Level gelöst & unabhängig nachsimuliert, Bot-Zeit ≤ Par, Reihenfolge-Fallen + Paradox-Demo |
| `replay` | RLE/Base64/Prüfsumme, Korruptionserkennung, Rekonstruktion aller Bot-Lösungen |
| `determinism` | 27 Szenarien × 1000 Wiederholungen, Hashkette pro Tick + Klon-Äquivalenz |
| `fuzz` | 10 000 Läufe, Proxy-Wächter gegen NaN/Overflow, Strukturinvarianten |
| `daily` | 30 Tage: Raum erzeugt, bewiesen, deterministisch |
| `browser` | 43 Checks: Menüs per Tastatur, Spielschleife bis Ergebnis, Paradox, Replays, Rennen, Editor, Daily, Fallbacks, Mobil, Audio, Frame-Zeiten |

## Lizenz / Herkunft

Sämtlicher Code, alle Level, Shader, Klänge und Musik wurden für dieses Projekt neu
geschrieben bzw. werden zur Laufzeit prozedural erzeugt. Keine Fremd-Assets, keine Libraries.
