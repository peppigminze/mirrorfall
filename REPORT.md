# MIRRORFALL — Bericht

Stand: alle Phasen (0 → Final) umgesetzt, getestet und gepusht. Dieser Bericht
trennt streng zwischen **nachgewiesen** (mit Testausgabe), **nicht nachgewiesen**
und **bewussten Entscheidungen**. Am Ende steht die kritische Selbst-Review samt
der drei behobenen schwersten Mängel.

---

## 1. Nachweise (Testausgaben, Auszüge aus `npm run test:all`)

```
━━━ Zusammenfassung ━━━
  ✔ Architekturgrenzen      127 Prüfungen
  ✔ Regeln                   21 Prüfungen
  ✔ Solver (b)               56 Prüfungen   (~57 s)
  ✔ Replay                   18 Prüfungen
  ✔ Determinismus (a)       156 Prüfungen   (~65 s)
  ✔ Fuzz (c)                  2 Prüfungen über 10 000 Läufe (~50 s)
  ✔ Daily                    90 Prüfungen
  ✔ Sim-Benchmark (d)
  ✔ Frame-CPU-Benchmark (d)
  ✔ Browser (Playwright)     43 Prüfungen
```

### (a) Determinismus — dieselbe Aufnahme 1000×, Hash identisch
27 Szenarien (jedes Level mit 5 zufälligen Läufern, ein Szenario mit echten
kanonischen Spuren, alle 12 Bot-Lösungen). Jede Wiederholung kompiliert das Level
neu, baut einen frischen Kontext und vergleicht eine **Hashkette über jeden Tick**
plus Endhash; zusätzlich 5× „klonen und weiterrechnen ≡ durchrechnen“ je Szenario.
```
  fx-sink (5 Läufer, zufällig)        Ticks=1800 Kette=0b57cc54 End=ac343763 → 1000/1000 identisch
  c12 (Bot-Lösung, 4 Läufe)           Ticks= 620 Kette=6f7aaf2d End=9e3bad42 → 1000/1000 identisch
  … (27 Szenarien)
  30 026 000 simulierte Ticks in 64 s (466 000 Ticks/s inkl. Hashing)
Determinismus: 156 bestanden, 0 fehlgeschlagen
```
Statisch abgesichert (`boundaries`): `sim/` importiert nur `sim/` und enthält kein
`Math.random`, `Date`, `performance`, keine Trigonometrie/`sqrt`/`pow`, keine Timer.

### (b) Solver-Bot löst alle 12 Level; L9–12: falsche Reihenfolge scheitert
```
  L 1 Erster Griff     0 Geister  Flucht  9.28 s  Par 11.00 s
  L 2 Echo             1 Geister  Flucht  7.28 s  Par  9.00 s  [Platte halten]
  L 3 Doppelschloss    2 Geister  Flucht  7.95 s  Par  9.50 s
  L 4 Taktgefühl       0 Geister  Flucht 11.13 s  Par 13.00 s
  L 5 Wachablösung     0 Geister  Flucht  7.82 s  Par  9.50 s
  L 6 Klimpergeld      0 Geister  Flucht  6.62 s  Par  8.50 s
  L 7 Tresor für Zwei  1 Geister  Flucht 13.28 s  Par 15.00 s  [Terminal halten]
  L 8 Fährmann         1 Geister  Flucht  8.62 s  Par 10.50 s  [Platte halten]
  L 9 Münzfluch        2 Geister  Flucht 15.68 s  Par 17.50 s  [Köder → Platte]
  L10 Tresorfalle      2 Geister  Flucht 11.40 s  Par 13.00 s  [Köder → Terminal]
  L11 Doppelte Münze   2 Geister  Flucht 13.53 s  Par 15.50 s  [Köder 1 → Köder 2]
  L12 Spiegelsturz     3 Geister  Flucht 10.33 s  Par 12.00 s  [Platte → Köder → Terminal]
```
Jede Lösung wird **unabhängig** nachsimuliert (alle kanonischen Spuren neu
aufgebaut, letzter Lauf muss gewinnen). Für L9–12 plant der Bot jede andere
Rollenreihenfolge neu — die erste Rolle zusätzlich mit Ankunftsverzögerungen
0…1500 Ticks — und identifiziert Paare, deren Umkehrung **immer** scheitert:
```
L12  Reihenfolge [1,3,2]: SCHEITERT — Münze 1 wurde von einem früheren Geist eingesteckt
     Reihenfolge [2,1,3]: funktioniert
     Reihenfolge [2,3,1]: funktioniert
     Reihenfolge [3,1,2]: SCHEITERT — …   Reihenfolge [3,2,1]: SCHEITERT — …
     ⇒ Falle bewiesen: „Münze 1 nach → werfen“ MUSS vor „Terminal 2 halten“ aufgenommen werden
       Replay mit vertauschter Aufnahme (3↔2): Lauf 4: ALARM
       Paradox-Demo: Helfer zögert 2.0 s, Köder-Läufer stiehlt die Münze → PARADOX bei Tick 268 (Geist 1)
```
(analog L9: Köder vor Platte · L10: Köder vor Terminal · L11: Köder 1 vor Köder 2.)

### (c) Fuzz — 10 000 zufällige Eingabefolgen
Zufälliges Level (Kampagne + Fixture mit allen Elementen + 8 Daily-Räume),
zufällige Läuferzahl 1–5, zufällige/echte/fehlerhafte kanonische Spuren,
zufällige Masken inkl. widersprüchlicher Kombinationen. 250 Läufe mit einem
Proxy-Wächter, der jede Schreiboperation auf NaN/undefined/Bruch/Int32-Overflow
und Zugriffe außerhalb des Arrays prüft; alle Läufe mit Strukturinvarianten
(Positionen, Ausrichtung, Beute-Besitz, Routenindex, Kamerawinkel, …).
```
  10000 Läufe, 7 841 270 Ticks in 50.3 s; davon 250 mit Proxy-Wächter (NaN/Overflow)
  Endzustände: läuft=8518 Sieg=0 Alarm=260 Paradox=1219 Zeitende=3
Fuzz: keine Exceptions, keine Invariantenverletzung / kein NaN
```

### (d) Performance mit Frame-Time-Report
| Messung | Ergebnis |
|---|---|
| Simulation (Node, 5 Läufer) | 0,35–1,27 Mio. Ticks/s → 0,8–2,9 µs pro Tick (Budget bei 60 Hz: 16 667 µs) |
| **Gesamte JS-Arbeit pro Frame** (Sim + Events + View-Modell + Sprite-/Lichtaufbau, ohne GPU-Treiber), L12 | **p50 0,06 ms · p95 0,12 ms · p99 0,48 ms** (Ausreißer max ≈ 20 ms = Zeitlinien-Verifikation beim Sieg) |
| Browser, Sim+Logik pro 60-Hz-Tick | Ø 0,03–0,05 ms, p95 ≤ 0,4 ms (alle Stufen) |
| Browser, Frame-Zeit in **SwiftShader** (CPU-Rasterizer, keine GPU) | Low 896×504: Ø 121 ms · Med 1152×648: Ø 341 ms · High 1280×720: Ø 295 ms · Canvas2D: Ø 121 ms |
| Relative Pass-Kosten vor Optimierung (SwiftShader, 960×544 High, je Pass abgeschaltet) | Partikel ≈ 26 %, Licht ≈ 25 %, Final ≈ 25 %, Boden ≈ 20 %, Bloom ≈ 15 %, Composite ≈ 12 %, Schatten-Marching ≈ 4 % |

**Ehrliche Einordnung:** Der Container hat keine GPU; Chromium rendert WebGL2 per
SwiftShader auf der CPU. Diese Frame-Zeiten sind ein Worst Case und **beweisen
nicht** die Zielwerte (60 FPS Laptop / 30 FPS Handy). Nachgewiesen ist, dass die
CPU-Seite praktisch kostenlos ist (< 0,5 ms) und die Qualitätsstufen die
GPU-Last stark skalieren. Aus dieser Messung habe ich zwei Optimierungen
abgeleitet und umgesetzt: Partikel zeichnen nur noch den lebenden Ringpuffer-
Bereich (vorher immer 4096 Instanzen, ≈ 26 % der Frame-Zeit) und der Final-Pass
spart 4 Texturzugriffe, wenn keine Aberration aktiv ist (zusammen −23 %).
Die automatische Qualitätswahl stuft nach zwei langsamen 2-s-Fenstern
(Ø < 50 FPS oder p90 > 24 ms) herab; Mobilgeräte starten auf „Mittel“.

### Weitere Nachweise
* **Regeln** (21): Platte/Tür mit Geist, Münzdiebstahl → Paradox bei Geist 0, Alarm nach exakt 24 Ticks Sicht, Wand blockiert Sicht, Tresor nur mit 2 Haltenden ≥ 30 Ticks, Plattform-Überfahrt, Laser-Takt, Schalter-Ergebnis → Paradox, Köder-Untersuchung, Tür schließt nicht auf Belegung.
* **Replay** (18): 500 RLE-Roundtrips, Base64url, Korruption 200/200 erkannt, alle 12 Bot-Replays (43–135 Zeichen) rekonstruiert.
* **Daily** (90): 30/30 Tage bewiesen lösbar (1–3 Geister), deterministisch, max. 1,3 s pro Tag in Node, im Browser im Worker.
* **Browser** (43): Menüs nur per Tastatur; vollständige Schleife über die echte Session-Logik bis zum Ergebnisbildschirm inkl. Share-String (`🟦🟦🟩`) und gespeicherter Bestzeit; Paradox-Kollaps (Geister 1 → 0) **mit erklärter Ursache**; Replay-Import; Ghost-Rennen; Editor (Tastatur, Laser, Export, Test-Modus, Rückkehr); Tagesrätsel im Worker; Einstellungen per Tastatur; Canvas2D erzwungen und automatisch bei fehlendem WebGL2; Mobil-Viewport (Touch sichtbar, Kacheln ≥ 26 px); Audio-Offline-Render: 22 SFX + Musik mit 4 Geisterstimmen, Spitze 0,60–0,68 (kein Clipping), RMS −22 dBFS, keine NaN.

---

## 2. Was nicht oder nur eingeschränkt funktioniert

1. **GPU-Performance auf echter Hardware nicht gemessen** (s. o.). Risiko besteht vor allem für Mittelklasse-Handys auf „Mittel“; die Auto-Stufe fängt das ab, „Niedrig“ ist dann aber sichtbar unschärfer.
2. **Gamepad und echte Touch-Geräte nicht physisch getestet** — nur Code-Review bzw. emulierte Touch-Events.
3. **Audio nie gehört** — nur technisch validiert (Pegel, kein Clipping, keine Fehler, Mischung über Limiter). Die musikalische Qualität ist unbewertet. Der Sidechain wirkt nur in Echtzeit (AnalyserNode) und ist nicht automatisiert geprüft.
4. **Paradox-Beweis ist relativ zum Rollenmodell** (Platte/Terminal/Schalter halten, Köder werfen) und zum 8-Tick-Aktionsraster — kein Beweis über alle 2^(5·1800) Eingabefolgen. Ein Mensch kann kombinierte Rollen spielen (z. B. Helfer wirft die Münze selbst); ob das eine Falle aushebelt, prüft der Bot nicht.
5. **Alle vier Fallen-Level nutzen denselben Kernmechanismus** (Reihenfolge um eine verbrauchbare Münze), variiert durch Platte/Tresor/Kette/Plattform. Begründung in §3.
6. **Solver-Laufzeit**: L11 braucht ~36 s; im Editor gilt ein 25-s-Limit — komplexe eigene Level können als „nicht bewiesen“ enden (ehrlich so beschriftet).
7. **Determinismus engine-übergreifend nur in V8** (Node + Chromium) getestet. Firefox/Safari sind durch reine Int32-Arithmetik theoretisch abgedeckt, aber nicht gemessen.
8. **`file://` geht nicht** (ES-Module brauchen HTTP); Dev-Server liegt bei.
9. **Canvas2D-Fallback** ist funktional, aber optisch deutlich schlichter (keine SDF-Schatten, kein Bloom).
10. Die **Rückspul-Optik** zeigt gespeicherte Zustände rückwärts — das ist reine Darstellung; die Simulation rechnet nie aus Snapshots.

---

## 3. Entscheidungen und warum

* **Repository.** Der Auftrag verlangte `git init` in `mirrorfall/`. Das Arbeitsverzeichnis war bereits ein Repo auf einem vorgegebenen Branch; ein verschachteltes Repo wäre für das äußere unsichtbar (Gitlink) gewesen. Auf deinen Wunsch liegt das Projekt jetzt eigenständig in `peppigminze/mirrorfall` (`main`, Historie per `git subtree split` übernommen).
* **Simulation = ein `Int32Array` + feste Tick-Reihenfolge.** Klonen ist `slice()`, Hashen eine Schleife, Fuzzing mit Proxy-Wächter trivial — und der Solver kann Millionen Zustände prüfen. Keine Floats in der Sim; Kamerarichtungen aus einer eingebrannten 128er-Integer-Tabelle; Kegeltest über `dot² · 1000 ≥ |v|² · cos²·1000`.
* **Paradox über kanonische Signaturspuren.** Signatur = Hash(Position, Beute, Münzen, lebend, *Interaktions-Ergebnis*). So zählt „Schalter wurde AUS statt AN“ oder „Münze war schon weg“ als Paradox, nicht nur Blockaden. Spuren sind aus Eingaben rekonstruierbar → Replays brauchen nur RLE-Eingaben.
* **„Timeline bricht ab Geist j“ wörtlich umgesetzt** (Geister ≥ j verworfen) — plus Undo als Komfort, weil der Kollaps sonst sehr strafend ist.
* **Läufer blockieren sich nicht.** Sonst entstünden unbeabsichtigte Paradoxe durch Rempeln.
* **Schleife startet erst mit der ersten Eingabe** („bereit“) — weniger Frust, Geister warten mit.
* **Solver: Rollen-Zerlegung statt Volltextsuche.** A* über *echte* Sim-Zustände (jeder Kindzustand entsteht durch `step()` mit allen Geistern), 53-Bit-Dedupe, optimistisches Pruning über „jemals offene Türen“ und „bereits eingesteckte Münzen“. Das Daily nutzt **Knoten-Budgets statt Uhrzeit-Limits**, damit jedes Gerät denselben Raum akzeptiert.
* **Warum Münzen als Fallen-Kern?** Beim Entwurf zeigte sich: Tür-/Schalter-Fallen sind *nicht robust* — ein später aufgenommener Läufer kann sein Timing so verschieben, dass der frühere Geist ungestört bleibt (das hat der Verzögerungs-Check des Bots auch bestätigt). Nur **verbrauchbare** Zustände (eine Münze, die ein Helfer zwangsläufig im Vorbeigehen einsteckt) erzwingen eine Aufnahme-Reihenfolge unabhängig vom Timing. Damit ist „falsche Reihenfolge scheitert“ wirklich beweisbar.
* **Sichtkegel sind Lichter.** Wachen- und Kamerakegel werden als Kegellichter mit denselben Parametern (70°/6 Felder bzw. 50°/7) und SDF-Schatten gerendert — was hell ist, wird gesehen.
* **Grafik-Pipeline:** MRT-Szene (Albedo/Emission), Licht in reduzierter Auflösung, 2D-Soft-Shadows per SDF-Raymarching (exakte EDT, nur bei Türwechsel neu), 5-stufiges Bloom (13-Tap down / Tent up), ACES-Tonemapping, Aberration/Scanlines/Glitch/Grain/Vignette, GPU-instanzierte zustandslose Partikel. Fallback für Geräte ohne Float-Rendertargets über eine Encode-Skalierung.
* **UI im DOM** (nicht im Canvas): scharfe Schrift, ARIA, echte Fokus-Navigation, Formularelemente für Lautstärke.
* **Kleine Bildschirme:** Kamera mit Mindest-Kachelgröße (26 CSS-px), die dem Läufer folgt — im Hochformat volle Höhe, seitliches Scrollen.

---

## 4. Kritische Selbst-Review

### Was ist schwach? (nach Schwere sortiert)

| # | Schwäche | Status |
|---|---|---|
| 1 | **Lesbarkeit:** Kanal 0 war *cyan + Kreis* — exakt wie Geist 1. In L2 verschmolzen Geist und Platte; der aktive Läufer hob sich kaum von Geistern ab. | **behoben** |
| 2 | **Paradoxe wurden nicht erklärt** („Vergangenheit verändert“) — Spieler verstehen den Kernmechanismus ohne Ursache schlecht. | **behoben** |
| 3 | **L5 lehrte Sichtkegel nicht:** offene Halle, der Bot lief praktisch geradeaus durch (52 Suchknoten). | **behoben** |
| 4 | GPU-Performance auf echter Hardware unbekannt; Boden- und Final-Pass laufen in voller Auflösung. | offen (Abschätzung + Auto-Stufen) |
| 5 | Fallen-Vielfalt: vier Mal Münz-Reihenfolge. | offen (bewusst, s. §3) |
| 6 | Audio nur technisch geprüft, nie gehört. | offen |
| 7 | Paradox-Beweis nur im Rollenmodell. | offen, dokumentiert |
| 8 | Canvas2D-Fallback optisch schwach. | offen |

### Die drei schwersten Mängel — behoben

1. **Lesbarkeit.** Neue Kanalpalette ohne Geister-Farbtöne für die häufigen Kanäle (0 = Silber, 1 = Rot, 2 = Grün, 3 = Violett), neue Symbolzuordnung, und jedes Kanal-Element trägt **k+1 Zählpunkte** (farb- *und* formunabhängig). Gedrückte Platten leuchten schwächer, damit der Geist darauf sichtbar bleibt. Der aktive Läufer hat einen weißen Ring und einen wippenden Pfeil („Du“). Vorher/Nachher per Screenshot geprüft.
2. **Paradox-Erklärung.** Läufe speichern zusätzlich den ungehashten beobachtbaren Zustand pro Tick. Bei einem Paradox nennt das Banner die konkrete Ursache — *aufgehalten*, *findet seine Münze nicht mehr*, *eine Münze zu viel*, *Beute fehlt*, *Schalter/Wurf mit anderem Ergebnis*, *entdeckt* — plus „⌫ macht es rückgängig“. Neuer Browser-Check: `Paradox: Ursache wird erklärt (Münze weg)` ✓.
3. **L5 neu:** patrouillierte Galerie mit Nischen; die Wache läuft dem Spieler entgegen. Nachweis: geradeaus laufen → *Alarm bei Tick 122*, abwarten → *Alarm bei Tick 299*; die Bot-Lösung duckt sich zweimal in Nischen (`… → ↓ ↑ → … warten ↑ ↓ ← …`).

### Was ich als Nächstes ändern würde
* **Echte Geräte-Profilierung** (Timer-Queries, Laptop iGPU + Mittelklasse-Android) und ein **gecachter Boden-Pass** (Weltraster-Cache, nur Abgrund/Neon animiert) für schwache GPUs.
* **Mehr Fallen-Typen** über neue verbrauchbare/irreversible Zustände (z. B. Einweg-Sicherung, die ein Geist „verbraucht“), damit L9–12 abwechslungsreicher werden.
* **Kombinierte Rollen im Solver** („erst Köder, dann Platte“), um Fallen auch gegen menschliche Tricks zu prüfen.
* **Audio nach Gehör mischen**, Stimmen pro Geist melodisch stärker an das Level binden.
* Optionaler Single-File-Build (für `file://`), englische Lokalisierung, Export/Import des Spielstands.

---

## 5. Kennzahlen

| Bereich | Zeilen |
|---|---|
| `sim/` | 1 525 |
| `render/` | 1 954 |
| `audio/` | 623 |
| `ui/` | 1 802 |
| `levels/` | 498 |
| `tools/` (Solver, Editor, Tests) | 2 499 |
| **gesamt** | **≈ 8 900** |

Prüfungen gesamt: 127 + 21 + 56 + 18 + 156 + 2 + 90 + 43 = **513 automatisierte Checks**, alle grün.
