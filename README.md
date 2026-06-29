# COMPILER · Card Builder

A static web **card builder / deckbuilder** — no build step, no dependencies, no backend. Just open it and design cards.

Cards are composed from a fixed frame, optional text panels, a background, a large center value and a protocol logo. All text and logos render in **white** over the frame.

> **Live demo:** https://albrtbc.github.io/compiler/

## Features

- **Live preview** rendered to a `<canvas>` at native resolution (744 × 1039).
- **Card attributes**
  - *Protocol* (title) — **Hacked-KerX** font, left-aligned in its bar.
  - *Value* (large center number) — **Hacked-KerX** font.
  - *Logo* inside the hexagon — automatically tinted white (toggleable).
  - *Panels* top / middle / bottom — **TT Supermolot Regular**. A panel's dark backing only appears when it has text.
    - **Rich text:** select text and use the **B** / **U** buttons, or type `**bold**` and `__underline__`.
  - *Background* — pick one of the 15 bundled presets or upload your own image.
- **Background pan & zoom** — drag the card to move the background, scroll to zoom (anchored at the cursor), with a zoom slider and reset.
- **Layers** (back → front): background → panels → frame → text → logo.
- **Deck**
  - Save cards, click a card to edit it, duplicate, download, or delete.
  - **Save / Cancel** while editing; after saving, the value and panels clear (protocol, logo and background are kept) so the next card in the same protocol is quick to build.
  - **Clear all**, plus **Export** / **Import** the whole deck as a portable `.json`.
  - Stored locally in **IndexedDB** (handles many cards with custom images).
- **Export** — download a single card, all cards as PNGs, or a **print & play PDF**.
  - The PDF lays out cards **3×3 per A4 page** at standard card size (63 × 88 mm), with
    crop marks and a card-back page after each fronts page for double-sided printing.
- Uploaded images are automatically downscaled & recompressed so they stay light.

## Run locally

Because of CORS rules for fonts and images, serve it over HTTP (don't open with `file://`):

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## Deck file (export / import)

`deck.json` is fully portable:

- **Custom** backgrounds and logos are **embedded** as base64 data URLs — the images travel inside the file.
- **Preset** backgrounds are stored by **name** and resolved from the app's `card-backgrounds/` folder.

## Project structure

```
index.html              · UI
styles.css              · styles (dark theme)
app.js                  · canvas render engine + deck logic
card-frame/             · frame.png + panel_top/mid/bot.png
card-back/              · cardback.jpg (used for the print & play PDF)
fonts/                  · TT-Supermolot-Regular/Bold.ttf, Hacked-KerX.ttf
card-backgrounds/       · 15 preset backgrounds (+ thumbs/ for the picker)
vendor/                 · jspdf.umd.min.js (PDF generation, MIT)
```
