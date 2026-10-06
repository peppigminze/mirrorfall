# MIRRORFALL — Design-Spezifikation (Phase 0)

> Zeitschleifen-Heist. 30 Sekunden pro Durchlauf. Danach spult die Zeit zurück,
> und jeder frühere Durchlauf läuft als Geist weiter.

Dieses Dokument wurde **vor** der Implementierung geschrieben und legt Regeln,
Datenformate, Modulgrenzen, Risiken und Teststrategie fest. Abweichungen, die
sich während der Umsetzung ergeben haben, sind am Ende unter „Änderungslog“
vermerkt.

---

## 1. Architektur

```
                         ┌──────────────────────────────────────────────┐
                         │                 index.html                   │
                         │   main.js  (Bootstrap, Feature-Detection)    │
                         └───────────────┬──────────────────────────────┘
                                         │
                         ┌───────────────▼──────────────────────────────┐
                         │ ui/  Spiel-Controller, Menüs, HUD, Eingabe,   │
                         │      Einstellungen, Speicher, Share, Editor-UI│
                         └──┬──────────┬───────────┬──────────┬─────────┘
                            │          │           │          │
              ┌─────────────▼──┐ ┌─────▼──────┐ ┌──▼───────┐ ┌▼──────────────┐
              │ render/        │ │ audio/     │ │ levels/  │ │ tools/        │
              │ WebGL2-Pipeline│ │ Mixer,     │ │ Kampagne,│ │ Solver-Bot,   │
              │ Canvas2D-Fallb.│ │ Musik, SFX │ │ Daily-Gen│ │ Editor, Tests │
              └───────┬────────┘ └────┬───────┘ └────┬─────┘ └──────┬────────┘
                      │ liest View    │ liest Events  │ nutzt RNG    │ nutzt Sim
                      └───────────────┴───────┬───────┴──────────────┘
                                              │ (nur lesend / Funktionsaufrufe)
                                   ┌──────────▼──────────┐
                                   │ sim/  (rein, ohne   │
                                   │ DOM, ohne Zeit,     │
                                   │ ohne Zufall, int32) │
                                   └─────────────────────┘
```

**Abhängigkeitsregel:** Pfeile zeigen nur nach unten. `sim/` importiert
ausschließlich aus `sim/`. `render/` und `audio/` kennen sich gegenseitig nicht;
sie bekommen vom Controller einen *View-Snapshot* bzw. eine *Event-Liste*.
Ein Test (`tools/tests/boundaries.mjs`) prüft die Importgrenzen statisch.

### Modulliste und Begründung

| Modul | Verantwortung | Warum so geschnitten |
|---|---|---|
| `sim/constants.js` | Alle Spielregel-Konstanten (Raster, Ticks, Geschwindigkeiten, Bitmasken) | Eine Quelle der Wahrheit; Tests und Solver lesen dieselben Werte |
| `sim/rng.js` | Seedbarer Integer-RNG (SplitMix32), FNV-1a-Hash | Determinismus; wird auch von Daily-Generator & Musik genutzt |
| `sim/dirtable.js` | Fest eingebrannte Integer-Richtungsvektoren (128 Winkel) | `Math.sin/cos` sind nicht engine-übergreifend bitgenau |
| `sim/level.js` | Level-JSON → kompiliertes, unveränderliches Level (Typed Arrays), Validierung | Trennung statische Daten ↔ veränderlicher Zustand |
| `sim/world.js` | Zustandslayout (ein flaches `Int32Array`), `createWorld`, `step` | Klonen = `slice()`, Hash = eine Schleife: ideal für Solver und Tests |
| `sim/input.js` | 5-Bit-Masken, RLE-Kodierung/Dekodierung | Aufzeichnungsformat |
| `sim/timeline.js` | Durchläufe, kanonische Geister-Signaturen, Commit/Kollaps/Undo | Paradox-Semantik an genau einer Stelle |
| `sim/replay.js` | Binärformat + Base64url für Export/Import | Kurz, versioniert, mit Prüfsumme |
| `levels/campaign.js` | 12 handgebaute Level (ASCII + Entitäten) | Lesbar, diff-bar, Editor-kompatibel |
| `levels/daily.js` | Seed aus Datum → prozeduraler Raum | Nutzt nur `sim/` und RNG |
| `tools/solver.js` | Solver-Bot (Rollen-Zerlegung + A* über Sim-Zustände) | Pure Funktion; läuft in Node-Tests **und** im Browser-Worker |
| `tools/editor.js` | Level-Editor (UI), Test-Modus, JSON-Export | Spezifikation verlangt Editor unter tools/ |
| `tools/tests/*` | Determinismus, Fuzz, Solver, Replay, Daily, Grenzen, Benchmarks | Node-ausführbar ohne Abhängigkeiten |
| `render/view.js` | Sim-Zustand → interpolierter View (Positionen, Lichter, Effekte) | Beide Renderer teilen dieselbe Logik |
| `render/renderer-gl.js` + `shaders.js` | WebGL2: Szene, 2D-Licht mit SDF-Schatten, Bloom, Post | Hauptpfad |
| `render/renderer-2d.js` | Canvas2D-Fallback | Wenn WebGL2 fehlt |
| `render/particles.js` | GPU-instanzierte, zustandslose Partikel (Ringpuffer) | CPU schreibt nur Spawns |
| `render/sdf.js` | Distanzfeld der Wände (CPU, 8-px-Zellen) für weiche Schatten | Ändert sich nur bei Türwechseln |
| `render/quality.js` | Frame-Time-Messung → Low/Med/High | Automatische Qualitätswahl |
| `audio/engine.js` | AudioContext, Busse, Limiter, Sidechain-Ducking, Hall | Sauberes Mixing |
| `audio/music.js` | Generative, adaptive Musik (Seed → Tonart/Tempo, Geist-Layer, Spannung) | |
| `audio/sfx.js` | Synthetisierte Effekte | |
| `ui/*` | Controller, Eingabe (Tastatur/Gamepad/Touch), Menüs, HUD, Settings | |

---

## 2. Spielregeln (präzise, so wie die Simulation sie umsetzt)

### Einheiten & Takt
* Raster **30 × 17**, Tile **32 px**, Weltfläche 960 × 544 px.
* Simulation: **60 Hz fixed timestep**; eine Schleife = **1800 Ticks** (30 s).
* Sub-Einheit (SU): 1 Tile = 24 SU. Alle Positionen sind ganze Zahlen.
* Läufer: 3 SU/Tick → 8 Ticks pro Tile. Wachen: 2 SU/Tick → 12 Ticks pro Tile.
* Maximal **4 Geister** + 1 aktiver Läufer.

### Eingabe
Pro Tick eine **5-Bit-Maske**: `U=1, D=2, L=4, R=8, A=16`. Gespeichert als
Lauflängen (RLE) `[(maske, länge), …]`. Bei mehreren Richtungsbits gilt die
feste Priorität U > D > L > R (die UI erzeugt ohnehin nur eine Richtung).

### Läufer
* Logisches Tile = Zieltile ab Bewegungsbeginn (Reservierung).
  *Zentrums-Tile* = Tile, in dem der Mittelpunkt liegt (wechselt bei halber Strecke).
  Platten, Beute, Münzen, Ausgang, Laser und Entdeckung nutzen das Zentrums-Tile.
* Läufer blockieren sich gegenseitig **nicht** (Geister sind durchlässig).
* Aktion (steigende Flanke von A, Läufer steht still):
  1. auf Schalter → umschalten;
  2. auf Tresor-Terminal → *halten* (A gedrückt halten, keine Flanke nötig);
  3. sonst, falls Münzen > 0 → Münze werfen (Richtung = gleichzeitig gedrückte
     Richtung, sonst Blickrichtung; max. 4 Tiles weit, 16 Ticks Flug).

### Elemente
| Element | Regel |
|---|---|
| **Druckplatte** (`a`–`h`, Kanal 0–7) | gedrückt, solange ein Läufer-Zentrum darauf steht |
| **Schalter** (`1`–`8`) | Aktion toggelt; bleibt bis Schleifenende |
| **Kanal** | aktiv ⇔ irgendeine Platte gedrückt oder ein Schalter an |
| **Tür** (`A`–`H` normal, `J`–`Q` invertiert) | offen ⇔ Kanal aktiv (XOR invertiert). Kann nicht schließen, solange ein Läufer/eine Wache sie belegt |
| **Laser** (Wand-Emitter) | Takt: an für `on`, aus für `off` Ticks, Phase `ph`; optional per Kanal deaktivierbar. Strahl bis zur ersten undurchsichtigen Kachel. Zentrum im aktiven Strahl ⇒ sofort Alarm |
| **Wache** | Patrouille über Wegpunkte (geschlossener Rundkurs, optional Warten/Blickrichtung). Sichtkegel **70°**, Reichweite **6 Tiles**, Sichtlinie durch Wände/geschlossene Türen blockiert. **24 Ticks (0,4 s)** ununterbrochen gesehen ⇒ Alarm |
| **Kamera** (Wand) | schwenkt zwischen zwei Winkeln, Kegel 50°, Reichweite 7 Tiles, gleiche 0,4-s-Regel; per Kanal abschaltbar |
| **Duo-Tresor** (`V` Tür, 2× `T` Terminal) | öffnet, wenn beide Terminals 30 Ticks lang **gleichzeitig** gehalten werden |
| **Beute** (`$`) | Aufheben durch Betreten; Sieg, wenn ihr Träger im **selben Durchlauf** ein Ausgangstile `E` erreicht |
| **Köder-Münze** (`o`) | Aufheben durch Betreten (max. 3). Landung erzeugt Lärm: Wachen mit Wegdistanz ≤ 9 untersuchen den Ort (hinlaufen, 2 s umsehen, zurück zur Route) |
| **Bewegliche Plattform** | pendelt über Abgrund `~`, 8 Ticks pro Tile, Wartezeit an den Enden; optional nur bei aktivem Kanal. Stillstehende Läufer fahren mit. Betreten nur, wenn die Plattform noch ≥ 8 Ticks wartet |

### Tick-Reihenfolge (`step`)
1. Kanäle aus Schaltern + Platten (Positionen vom Tickbeginn)
2. Türen (mit Belegungssperre)
3. Plattformen (Abfahrt nimmt stillstehende Mitfahrer mit)
4. Läufer in Indexreihenfolge: Aktion, Bewegung, Aufheben, Ausgang
5. Tresor-Fortschritt
6. Wachen (Patrouille / Untersuchen / Zurückkehren)
7. Kameras
8. Fliegende Münzen, Lärm
9. Entdeckung: Laser, Wachen, Kameras → Verdacht → Alarm
10. Absturz-Check
11. Paradox-Check der Geister, Statusauflösung (Paradox > Sieg > Alarm)

### Zeitschleife, Geister und Paradox
* Jede Schleife startet aus dem Level-Anfangszustand. In jedem Tick wird die
  Welt aus **allen Aufzeichnungen** neu berechnet: Geister sind echte Agenten,
  die ihre aufgezeichneten Eingaben in die Simulation einspeisen — keine
  abgespielten Positionen, keine Zustands-Snapshots.
* **Signatur** eines Läufers pro Tick: Hash aus Position, Beute, Münzen,
  Lebend-Flag und *Interaktions-Ergebnis-Hash* (z. B. „Schalter wurde auf AN
  gesetzt“). Beim Aufzeichnen von Lauf *k* wird dessen Signaturfolge
  gespeichert (**kanonische Spur**; aus den Eingaben jederzeit reproduzierbar).
* Weicht ein Geist in einem späteren Durchlauf von seiner kanonischen Spur ab
  (blockiert, andere Beute/Münzen, anderes Schalterergebnis) oder wird er
  entdeckt/stürzt ⇒ **Zeitparadox**. Die Timeline bricht **ab diesem Geist**:
  Geist *j* und alle späteren werden verworfen. (Undo stellt den Zustand vor
  dem Kollaps wieder her — Komfort, nicht Regelbruch.)
* Aktiver Läufer entdeckt ⇒ **Alarm**: Versuch verworfen, Alarmzähler +1.
* Zeit abgelaufen (oder „Jetzt zurückspulen“, Rest = Leerlauf) ⇒ Lauf wird
  zum Geist (sofern < 4 Geister).

### Wertung
* ★ gelöst · ★ Fluchtzeit im finalen Durchlauf ≤ Par · ★ null Alarme in der Sitzung.
* Par = Bot-Fluchtzeit + Puffer, im Test gegen den Solver verifiziert.

---

## 3. Datenformate

### Level-JSON (Kampagne, Editor-Export, Daily)
```json
{
  "id": "c07", "name": "Tresor für Zwei", "seed": 70707, "par": 1500,
  "map": ["##############################", "...17 Zeilen à 30 Zeichen..."],
  "lasers":   [{"x":5,"y":0,"dir":"D","on":60,"off":60,"ph":0,"ch":-1,"inv":0}],
  "guards":   [{"route":[{"x":3,"y":4,"wait":30,"look":"L"},{"x":12,"y":4}]}],
  "cameras":  [{"x":0,"y":8,"a0":-16,"a1":16,"speed":4,"pause":40,"ch":-1}],
  "platforms":[{"x0":10,"y0":5,"x1":10,"y1":11,"dwell":60,"ch":-1,"inv":0}]
}
```
Zeichen: `#` Wand · `.` Boden · `~` Abgrund · `S` Start · `E` Ausgang · `$` Beute
· `o` Münze · `V` Tresortür · `T` Terminal · `a–h` Platte K0–7 · `A–H` Tür K0–7
· `J–Q` invertierte Tür K0–7 · `1–8` Schalter K0–7.

### Simulationszustand
Ein `Int32Array`; Offsets werden pro Level aus den Entitätszahlen berechnet
(`layout`). Abschnitte: Global · Läufer×5 · Wachen · Kameras · Türen · Schalter
· Münzplätze · Wurfmünzen×4 · Plattformen · Laser. Hash = FNV-1a über das
ganze Array. Events (für Audio/Grafik) liegen **außerhalb** und gehen nicht in
den Hash ein.

### Replay-String
`MF1.` + Base64url von:
`[version][levelKind][levelRef varint][nRuns]` und je Lauf
`[nEntries varint]` + Einträge (`maske | len<<5` bei len ≤ 7, sonst `maske` +
`varint len`), abschließend 1 Byte Prüfsumme. Nur Eingaben — alles andere wird
deterministisch rekonstruiert.

### Share-String
```
MIRRORFALL 07 · Tresor für Zwei
★★☆ ⏱ 18.42s 👻2 🚨0
🟦🟥🟦🟩
```
(🟦 Geist aufgenommen, 🟥 Alarm, 🟪 Paradox, 🟩 Flucht)

---

## 4. Solver-Bot

1. **Rollen** werden aus dem Level abgeleitet: *Platte halten*, *Terminal halten*,
   *Schalter umlegen*, *Köder werfen* (Münze, Richtung, Zeitpunkt) und *Finale*
   (Beute → Ausgang).
2. **Lauf-Planer:** A* über vollständige Sim-Zustände. Entscheidungspunkte alle
   8 Ticks (Bewegen ×4, Warten, Tippen, Halten, Werfen ×4). Heuristik =
   statische BFS-Distanz × 8. Duplikate über 53-Bit-Zustandshash. Ein
   Zielzustand gilt erst, wenn der Rest der Schleife ohne Alarm/Paradox
   durchsimuliert wurde.
3. **Reihenfolge-Suche:** iterative Vertiefung über Rollenfolgen (0…4 Geister),
   Präfix-Cache, optimistische Erreichbarkeitsprüfung als Pruning.
4. **Paradox-Beweis (Level 9–12):** Für jede Permutation der Lösungsrollen wird
   neu geplant; Paare (X vor Y), bei denen *jede* solche Permutation scheitert,
   sind die Paradox-Fallen. Zusätzlich: die aufgezeichneten Eingaben in falscher
   Reihenfolge abgespielt ⇒ Paradox nachweisbar.

Grenzen (ehrlich): Der Beweis ist vollständig *relativ zum Aktionsraster*
(8-Tick-Entscheidungen) und zum Rollenmodell, nicht über alle 2^(5·1800)
Eingabefolgen.

---

## 5. Grafik-Pipeline (WebGL2)

1. **Szene** (volle Auflösung, RGBA16F falls verfügbar): prozeduraler Boden/Wände
   aus einer Tile-Textur + instanzierte SDF-Sprites (Läufer, Wachen, Objekte).
2. **Licht** (reduzierte Auflösung): bis 24 Lichter (Punkt, Kegel, Linie) mit
   weichen Schatten per SDF-Raymarching im Fragment-Shader. Wachen- und
   Kamerakegel *sind* Lichter → was hell ist, wird gesehen.
3. **Komposition**: Albedo × Licht + Emission.
4. **Bloom**: Schwelle → 5-stufige Downsample-Kette (13-Tap) → Tent-Upsample.
5. **Post**: Tonemapping, Vignette, Filmkorn, chromatische Aberration,
   Scanlines, Glitch (Paradox), Screen-Shake (Trauma² mit Decay).
6. **Partikel**: instanziert, Position analytisch im Vertex-Shader.
* Qualitätsstufen = Uniforms + Auflösungsfaktoren; automatische Wahl per
  gleitendem Frame-Time-Mittel.
* Canvas2D-Fallback mit gleicher Spiellogik-Darstellung (Kegel als Polygone).

## 6. Audio

`SFX-Bus ─┬─────────────────────────┐`
`         └→ Analyser (Sidechain) ─→ Duck-Gain`
`Musik-Bus ─→ Duck-Gain ─→ Master ─→ Kompressor (Limiter) ─→ Ausgang`
`Hall (prozedurale Impulsantwort) als Send`

* Tonart & Tempo aus Level-Seed; Bass, Pad, Hi-Hats, Herzschlag-Kick;
  **pro Geist eine eigene Stimme** (Arpeggio / Plucks / FM-Glocke / Gegenmelodie).
* Spannung (Nähe zu Sichtkegeln, Verdacht) steuert Filter, Dichte, Drone.
* Lookahead-Scheduler (100 ms), Voice-Limit.

---

## 7. Die 5 größten technischen Risiken

| # | Risiko | Entschärfung |
|---|---|---|
| 1 | **Determinismus bricht** (Float/Trig-Abweichungen zwischen Engines, Iterationsreihenfolge, versteckte Zufallsquellen) | Sim rein ganzzahlig; Richtungen aus fest eingebrannter Tabelle; kein `Math.random`/`Date` (statischer Test greppt danach); Zustand als ein `Int32Array`; 1000×-Hash-Test |
| 2 | **Solver explodiert kombinatorisch** (4 Geister × 1800 Ticks) | Rollen-Zerlegung statt Volltextsuche; A* mit Heuristik; Zustands-Dedupe; optimistisches Pruning; Budgets; Level iterativ *mit* dem Solver entworfen |
| 3 | **Paradox fühlt sich unfair/unsichtbar an** (Mikro-Abweichungen) | Präzise Signatur (nur spielrelevante Größen), Geister kollidieren nicht, klares Feedback (Glitch am Geist, Markierung), Undo |
| 4 | **Grafik zu teuer für Mobilgeräte** (Raymarch-Schatten pro Pixel, Bloom) | Licht in reduzierter Auflösung, wenige SDF-Schritte, Lichtzahl/Bloom-Stufen per Qualitätsstufe, automatische Herabstufung, Canvas2D-Fallback |
| 5 | **WebAudio** (Autoplay-Sperren, Timing-Jitter, Clipping) | Kontext erst nach Geste, Lookahead-Scheduling auf `currentTime`, Limiter + Sidechain, Voice-Begrenzung |

Zusatzrisiko: Ohne echte GPU im Testcontainer sind Browser-Messungen nur
eingeschränkt aussagekräftig → CPU-seitige Frame-Kosten getrennt messen und
offen berichten.

---

## 8. Teststrategie

| Test | Inhalt | Kriterium |
|---|---|---|
| `determinism` | Dieselbe Mehr-Geister-Aufnahme 1000× simulieren | alle Endhashes und Hashketten identisch |
| `fuzz` | 10 000 zufällige Eingabefolgen (alle Level, zufällige Geisterzahl) | keine Exception, kein NaN, Invarianten (Grenzen, Zustandsbereiche) |
| `solver` | alle 12 Kampagnenlevel lösen, Lösung unabhängig nachsimulieren; Level 9–12: falsche Reihenfolge scheitert | 12/12, Paradox-Nachweis |
| `replay` | Kodieren/Dekodieren, Rekonstruktion der kanonischen Spuren | Roundtrip bit-identisch |
| `daily` | Daily-Räume für viele Daten generieren + beweisen | alle bewiesen lösbar, deterministisch |
| `boundaries` | Importgrenzen, verbotene APIs in `sim/` | keine Verstöße |
| `bench-sim` | Ticks/s der Simulation | Report |
| `browser` (Playwright) | Seite laden, Menü, Level spielen, Screenshots, Frame-Time-Report | keine Konsolenfehler |
