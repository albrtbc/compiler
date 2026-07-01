"use strict";

/* ============================================================
   Layout / render configuration.
   Pure data: geometry of the card zones, print sizes, presets and
   the front-glitch presets. No DOM, no state — safe to import anywhere.
   ============================================================ */

// Design space: the frame art + all zones are authored at this size.
export const CARD_W = 744;
export const CARD_H = 1039;

// Print output: standard poker card 63.5×88.9mm (2.5×3.5") at 300dpi = 750×1050.
// Exports render the design and resize to this; 600dpi doubles it.
export const POKER_W = 750;
export const POKER_H = 1050;

// Compile card: designed/viewed in LANDSCAPE (the vertical frame rotated +90° CCW).
export const LAND_W = 1039;
export const LAND_H = 744;

// One image split across a 3×2 grid of card-aspect cells.
export const MOSAIC_ASPECT = (3 * CARD_W) / (2 * CARD_H);

// Background pan/zoom scale limits (SCALE_MAX has headroom for the mosaic splitter).
export const SCALE_MIN = 0.25;
export const SCALE_MAX = 16;

export const PANEL_FONT = "SupermolotR";
export const PANEL_MAX = 38;
export const PANEL_MIN = 13;
export const LINE_FACTOR = 1.18;

export const TEXT_SHADOW = { color: "rgba(0,0,0,0.7)", blur: 17, dx: 0, dy: 8 };

// Zone coordinates measured against the 744×1039 frame.
export const ZONES = {
  title: { x: 39, y: 31, w: 240, h: 96, font: "HackedKerX", max: 60, min: 18, align: "left", padX: 18 },
  value: { x: 292, y: 40, w: 159, h: 175, font: "HackedKerX", max: 161, min: 28, dy: 10, dx: 0 },
  hex:   { x: 583, y: 36, w: 124, h: 135, pointy: "v", flatA: 0.26, flatB: 0.85 }, // covers the frame hexagon
  panels: {
    top: { x: 80, y: 258, w: 580, h: 190 },
    mid: { x: 78, y: 508, w: 570, h: 210 },
    bot: { x: 78, y: 766, w: 585, h: 214 },
  },
};

export const COMPILE_FRONT = {
  topBar:   { x: 72, y: 40, w: 700, h: 80, font: "SupermolotR", max: 36, min: 14, align: "left", padX: 26 },
  name:     { x: 60, y: 256, w: 930, h: 200, font: "HackedKerX", max: 150, min: 34, shadow: TEXT_SHADOW },   // center ≈356
  subtitle: { x: 60, y: 418, w: 930, h: 90, font: "MotionControl", max: 62, min: 16, shadow: TEXT_SHADOW },  // center ≈463
  bottomBar:{ x: 60, y: 620, w: 930, h: 72, font: "SupermolotR", max: 34, min: 14, align: "center", padX: 22 }, // centred on the card like name/subtitle
  hex:      { x: 856, y: 38, w: 144, h: 140, pointy: "h", flatA: 0.18, flatB: 0.86 }, // covers the frame hexagon
};
export const COMPILE_BACK = {
  // name sits in the thick (left) part of the bottom bar, left-aligned at the same height as the back line
  name:     { x: 78, y: 592, w: 510, h: 128, font: "HackedKerX", max: 104, min: 24, align: "left", padX: 30 }, // center ≈656
  backLine: { x: 652, y: 626, w: 356, h: 84, font: "SupermolotR", max: 40, min: 14, align: "center", padX: 16 }, // center ≈668
  hex:      { x: 856, y: 38, w: 144, h: 140, pointy: "h", flatA: 0.18, flatB: 0.86 }, // covers the frame hexagon
};

export const PRESETS = [
  "Water", "Love", "Apathy", "Spirit", "Fire", "Gravity", "Light", "Metal",
  "Death", "Hate", "Darkness", "Plague", "Psychic", "Speed", "Life",
];

// Old Spanish preset names → current English file names (cards saved before the rename).
export const PRESET_MIGRATION = {
  Agua: "Water", Amor: "Love", Apatia: "Apathy", Espiritu: "Spirit", Fuego: "Fire",
  Gravedad: "Gravity", Luz: "Light", Muerte: "Death", Odio: "Hate", Oscuridad: "Darkness",
  Plaga: "Plague", Psiquico: "Psychic", Velocidad: "Speed", Vida: "Life",
};

// 10 glitch presets (index 1..10; dropdown value 0 = no glitch). #1 is the default.
export const GLITCH_PRESETS = [
  { name: "Classic",     rowH: [.025, .085], colW: [.05, .20], shardChance: .55, shardDX: .13, dupes: 22, dupSize: [.05, .13], dupCopies: 3, chroma: 12, chromaA: .40, chromaDX: .06 },
  { name: "Heavy shift", rowH: [.020, .060], colW: [.06, .16], shardChance: .70, shardDX: .28, dupes: 14, dupSize: [.06, .14], dupCopies: 2, chroma: 10, chromaA: .45, chromaDX: .12 },
  { name: "Fine blocks", rowH: [.012, .040], colW: [.02, .08], shardChance: .60, shardDX: .08, dupes: 40, dupSize: [.02, .06], dupCopies: 2, chroma: 16, chromaA: .35, chromaDX: .04 },
  { name: "Big blocks",  rowH: [.060, .180], colW: [.12, .30], shardChance: .50, shardDX: .16, dupes: 10, dupSize: [.12, .26], dupCopies: 2, chroma: 6,  chromaA: .40, chromaDX: .07 },
  { name: "Scanlines",   rowH: [.010, .030], colW: [.90, 1.0], shardChance: .50, shardDX: .22, dupes: 4,  dupSize: [.10, .20], dupCopies: 1, chroma: 22, chromaA: .50, chromaDX: .10 },
  { name: "Heavy clone", rowH: [.030, .090], colW: [.05, .16], shardChance: .40, shardDX: .10, dupes: 48, dupSize: [.05, .16], dupCopies: 4, chroma: 8,  chromaA: .35, chromaDX: .05 },
  { name: "Subtle",      rowH: [.020, .060], colW: [.05, .16], shardChance: .30, shardDX: .06, dupes: 8,  dupSize: [.04, .10], dupCopies: 1, chroma: 6,  chromaA: .25, chromaDX: .03 },
  { name: "Chroma",      rowH: [.030, .080], colW: [.06, .18], shardChance: .45, shardDX: .10, dupes: 14, dupSize: [.05, .12], dupCopies: 2, chroma: 30, chromaA: .55, chromaDX: .14 },
  { name: "Tall shards", rowH: [.080, .220], colW: [.03, .10], shardChance: .60, shardDX: .10, dupes: 16, dupSize: [.04, .10], dupCopies: 2, chroma: 10, chromaA: .40, chromaDX: .06 },
  { name: "Chaos",       rowH: [.020, .100], colW: [.04, .24], shardChance: .75, shardDX: .30, dupes: 60, dupSize: [.04, .18], dupCopies: 4, chroma: 24, chromaA: .50, chromaDX: .16 },
];

// Persistence keys (legacy localStorage keys kept for one-time migration).
export const STORE_DECK = "deckbuilder.deck.v1";
export const STORE_CURRENT = "deckbuilder.current.v1";
