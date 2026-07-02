# COMPILER · Card Builder

A static web **card builder / deckbuilder** for making custom cards for the **COMPILE** board card game — no build step, no dependencies, no backend. Just open it and design cards, then export them to print & play.

Cards are composed from a fixed frame, optional text panels, a background, a large center value and a Protocol logo. All text and logos render in **white** over the frame. There are two card types: vertical **compile cards** and the landscape, double-sided **Protocol card** (front & back).

> **Live demo:** https://albrtbc.github.io/compiler/

## Features

- **Live preview** rendered to a `<canvas>` at native resolution (744 × 1039).
- **Card attributes**
  - *Protocol* (title) — **Hacked-KerX** font, left-aligned in its bar.
  - *Value* (large center number) — **Hacked-KerX** font.
  - *Logo* inside the hexagon — automatically tinted white (toggleable). Shared **deck-wide**: one logo per card type across the whole deck.
  - *Panels* top / middle / bottom — **TT Supermolot Regular**. A panel's dark backing only appears when it has text.
    - **Rich text:** select text and use the **B** / **U** buttons, or type `**bold**` and `__underline__`.
  - *Background* — pick one of the 15 bundled presets or upload your own (kept full-quality — see below). Use one background for the whole deck, a **different background per card**, or **split one image across the compile cards** (mosaic — each card shows a different crop of the same picture).
- **Background pan & zoom** — drag the card to move the background, scroll to zoom (anchored at the cursor), with a zoom slider and reset.
- **Front "glitch" effect** — an optional datamosh-style glitch on the Protocol card's front face, with several presets (deck-wide, toggleable).
- **Layers** (back → front): background → panels → frame → text → logo.
- **Deck**
  - Add cards, click a card to edit it (Save updates it in place, "Add as new" clones it), duplicate, download, or delete.
  - Decks stay ordered: the Protocol card first, then by value ascending.
  - **My decks** library: save decks by name, load them later, delete. Named decks autosave on every change. Stored locally in **IndexedDB**.
  - **Clear all**, plus **Export** / **Import** the whole deck as a portable `.json`.
  - **Share** a deck as a short link: the deck is gzip-compressed and stored on a free service ([dpaste](https://dpaste.com)); the link opens a read-only gallery where anyone can view or import it. Uploaded images are re-compressed **only here**, so the whole deck fits into the link. (Links expire after ~1 year; for offline/permanent sharing use Export/Import.)
- **Export** — download a single card, all cards as PNGs, or a **print & play PDF**, at print resolution (**300 dpi**).
  - The PDF lays out cards **3×3 per A4 page** at standard card size (63 × 88 mm), with
    crop marks and a card-back page after each fronts page for double-sided printing.
- **Image quality** — uploaded **backgrounds are kept at full quality**; the card downscales them crisply at draw time, so zooming and mosaic splits stay sharp. Logos are stored as small 320 px PNGs. Images are re-compressed **only** for the share link — never for editing, PNG export or the PDF.

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
app.js                  · app entry — wires the UI, canvas engine and deck logic
src/                    · ES modules (imported by app.js)
  config.js             · card geometry, zones, print sizes, constants
  core/                 · image loading/encoding, geometry, base64, rng, image keys
  model/                · background + deck-ordering helpers
  render/               · canvas drawing, text layout, front glitch effect
  storage/              · IndexedDB (My decks)
test/                   · Vitest unit tests for the pure modules
card-frame/             · frame.png + panel_top/mid/bot.png
card-back/              · cardback.png (used for the print & play PDF)
fonts/                  · TT-Supermolot-Regular/Bold.ttf, Hacked-KerX.ttf
card-backgrounds/       · 15 preset backgrounds (+ thumbs/ for the picker)
vendor/                 · jspdf.umd.min.js (PDF generation, MIT)
```

The app runs straight from source — the ES modules load directly in the browser, so **no build step is required**. Optional dev tooling (dev-dependencies only): `npm test` runs the [Vitest](https://vitest.dev) unit tests and `npm run build` bundles/minifies with [esbuild](https://esbuild.github.io/).
