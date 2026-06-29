"use strict";

/* ============================================================
   Deckbuilder / Card Builder
   Render pipeline (bottom → top):
     1. Background image (preset or uploaded), full-bleed cover
     2. Panel backings (top/mid/bot) — only if that panel has text
     3. Frame (always on top of panels)
     4. White text: title, value, panel texts
     5. White logo inside the hexagon
   ============================================================ */

const CARD_W = 744;
const CARD_H = 1039;

// Zone coordinates measured against the 744×1039 frame.
const ZONES = {
  title: { x: 39, y: 31, w: 240, h: 96, font: "HackedKerX", max: 60, min: 18, align: "left", padX: 18 },
  value: { x: 292, y: 40, w: 159, h: 175, font: "HackedKerX", max: 161, min: 28, dy: 10, dx: 7 },
  hex:   { x: 583, y: 36, w: 124, h: 135, pointy: "v", flatA: 0.26, flatB: 0.85 }, // covers the frame hexagon
  panels: {
    top: { x: 80, y: 258, w: 580, h: 190 },
    mid: { x: 78, y: 508, w: 570, h: 210 },
    bot: { x: 78, y: 766, w: 585, h: 214 },
  },
};
const PANEL_FONT = "SupermolotR";
const PANEL_MAX = 38;
const PANEL_MIN = 13;
const LINE_FACTOR = 1.18;

// Compile card: designed/viewed in LANDSCAPE (the vertical frame rotated +90° CCW).
const LAND_W = 1039, LAND_H = 744;
const TEXT_SHADOW = { color: "rgba(0,0,0,0.7)", blur: 17, dx: 0, dy: 8 };
const COMPILE_FRONT = {
  topBar:   { x: 72, y: 40, w: 700, h: 80, font: "SupermolotR", max: 36, min: 14, align: "left", padX: 26 },
  name:     { x: 60, y: 256, w: 930, h: 200, font: "HackedKerX", max: 150, min: 34, shadow: TEXT_SHADOW },   // center ≈356
  subtitle: { x: 60, y: 418, w: 930, h: 90, font: "MotionControl", max: 62, min: 16, shadow: TEXT_SHADOW },  // center ≈463
  bottomBar:{ x: 60, y: 620, w: 930, h: 72, font: "SupermolotR", max: 34, min: 14, align: "center", padX: 22 }, // centred on the card like name/subtitle
  hex:      { x: 856, y: 38, w: 144, h: 140, pointy: "h", flatA: 0.18, flatB: 0.86 }, // covers the frame hexagon
};
const COMPILE_BACK = {
  // name sits in the thick (left) part of the bottom bar, left-aligned at the same height as the back line
  name:     { x: 78, y: 592, w: 510, h: 128, font: "HackedKerX", max: 104, min: 24, align: "left", padX: 30 }, // center ≈656
  backLine: { x: 652, y: 626, w: 356, h: 84, font: "SupermolotR", max: 40, min: 14, align: "center", padX: 16 }, // center ≈668
  hex:      { x: 856, y: 38, w: 144, h: 140, pointy: "h", flatA: 0.18, flatB: 0.86 }, // covers the frame hexagon
};

const PRESETS = [
  "Water", "Love", "Apathy", "Spirit", "Fire", "Gravity", "Light", "Metal",
  "Death", "Hate", "Darkness", "Plague", "Psychic", "Speed", "Life",
];

// Old Spanish preset names → current English file names (cards saved before the rename).
const PRESET_MIGRATION = {
  Agua: "Water", Amor: "Love", Apatia: "Apathy", Espiritu: "Spirit", Fuego: "Fire",
  Gravedad: "Gravity", Luz: "Light", Muerte: "Death", Odio: "Hate", Oscuridad: "Darkness",
  Plaga: "Plague", Psiquico: "Psychic", Velocidad: "Speed", Vida: "Life",
};
function migrateBg(bg) {
  if (bg && bg.type === "preset" && bg.name && PRESET_MIGRATION[bg.name]) {
    bg.name = PRESET_MIGRATION[bg.name];
    return true;
  }
  return false;
}

const STORE_DECK = "deckbuilder.deck.v1";
const STORE_CURRENT = "deckbuilder.current.v1";

/* ---------------- State ---------------- */
const defaultCompile = () => ({ top: "", subtitle: "LOADING...", bottom: "", back: "COMPILED" });
const defaultState = () => ({
  title: "",
  value: "",
  panelTop: "",
  panelMid: "",
  panelBot: "",
  // type: none | preset | custom · transform pans/zooms the background
  bg: { type: "none", name: null, dataUrl: null, transform: { scale: 1, offsetX: 0, offsetY: 0 } },
  logo: { dataUrl: null, zoom: 1, offsetX: 0, offsetY: 0 }, // always tinted white
  kind: "protocol", // "protocol" | "compile"
  compile: defaultCompile(),
});

const defaultTransform = () => ({ scale: 1, offsetX: 0, offsetY: 0 });
const SCALE_MIN = 0.25;
const SCALE_MAX = 5;
const clampScale = (s) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, s || 1));

let state = defaultState();
let editingId = null; // id of the deck card being edited, or null

/* ---------------- Asset loading ---------------- */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load: " + src));
    img.src = src;
  });
}

const assets = { frame: null, panels: {}, compileFrontLand: null, compileBackLand: null };
const presetCache = new Map(); // name -> Image (full-res)
const dataUrlCache = new Map(); // dataUrl -> Image

// Downscale + recompress an uploaded image so it fits comfortably in
// localStorage (a full-res photo as base64 easily blows the ~5MB quota).
// The card only renders ~744px wide, so we never need more than that.
function normalizeImage(dataUrl, maxW, maxH, mime, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width, maxH / img.height);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const cx = c.getContext("2d");
      cx.imageSmoothingQuality = "high";
      cx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL(mime, quality));
    };
    img.onerror = () => reject(new Error("decode failed"));
    img.src = dataUrl;
  });
}

async function getImageFromDataUrl(dataUrl) {
  if (!dataUrl) return null;
  if (dataUrlCache.has(dataUrl)) return dataUrlCache.get(dataUrl);
  const img = await loadImage(dataUrl);
  dataUrlCache.set(dataUrl, img);
  return img;
}

async function getPresetImage(name) {
  if (presetCache.has(name)) return presetCache.get(name);
  const img = await loadImage(`card-backgrounds/${name}.jpg`);
  presetCache.set(name, img);
  return img;
}

// Per-value art (card-frame/value_<n>.png) drawn behind the frame on normal
// cards. Only numeric values map to a file; anything without a matching file
// resolves to null (cached) so the card just renders without it — no error.
const valueOverlayCache = new Map(); // value token -> Image | null
async function getValueOverlay(value) {
  const v = String(value == null ? "" : value).trim();
  if (!/^[0-9]+$/.test(v)) return null;
  if (valueOverlayCache.has(v)) return valueOverlayCache.get(v);
  let img = null;
  try { img = await loadImage(`card-frame/value_${v}.png`); } catch (e) { img = null; }
  valueOverlayCache.set(v, img);
  return img;
}

async function loadFonts() {
  const defs = [
    ["SupermolotR", "fonts/TT-Supermolot-Regular.ttf"],
    ["SupermolotB", "fonts/TT-Supermolot-Bold.ttf"],
    ["HackedKerX", "fonts/Hacked-KerX.ttf"],
    ["MotionControl", "fonts/motion-control.bold.otf"],
  ];
  await Promise.all(
    defs.map(([fam, url]) => {
      const ff = new FontFace(fam, `url(${url})`);
      return ff.load().then((f) => document.fonts.add(f));
    })
  );
}

/* ---------------- Text helpers ---------------- */
function fitSingleLine(ctx, text, fontFam, maxW, maxH, maxSize, minSize) {
  let size = maxSize;
  for (; size >= minSize; size--) {
    ctx.font = `${size}px ${fontFam}`;
    const m = ctx.measureText(text);
    const h = (m.actualBoundingBoxAscent || size * 0.8) + (m.actualBoundingBoxDescent || size * 0.2);
    if (m.width <= maxW && h <= maxH) break;
  }
  return Math.max(size, minSize);
}

function wrapLines(ctx, text, fontFam, size, maxW) {
  ctx.font = `${size}px ${fontFam}`;
  const lines = [];
  // honour explicit line breaks
  for (const para of text.split("\n")) {
    if (para.trim() === "") { lines.push(""); continue; }
    let cur = "";
    for (const word of para.split(/\s+/)) {
      const test = cur ? cur + " " + word : word;
      if (ctx.measureText(test).width <= maxW || !cur) {
        cur = test;
      } else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

function drawLine(ctx, text, zone, color) {
  if (!text) return;
  const padX = zone.padX || 0;
  const availW = zone.w - padX * 2;
  const size = fitSingleLine(ctx, text, zone.font, availW, zone.h, zone.max, zone.min);
  ctx.font = `${size}px ${zone.font}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  if (zone.shadow) {
    ctx.shadowColor = zone.shadow.color || "rgba(0,0,0,0.5)";
    ctx.shadowBlur = zone.shadow.blur || 0;
    ctx.shadowOffsetX = zone.shadow.dx || 0;
    ctx.shadowOffsetY = zone.shadow.dy || 0;
  }
  const cy = zone.y + zone.h / 2 + (zone.dy || 0);
  if (zone.align === "left") {
    ctx.textAlign = "left";
    ctx.fillText(text, zone.x + padX, cy, availW);
  } else {
    ctx.textAlign = "center";
    ctx.fillText(text, zone.x + zone.w / 2 + (zone.dx || 0), cy, availW);
  }
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
}

/* ---- Rich panel text: **bold** and __underline__ ---- */
// Parse one paragraph into styled runs. ** toggles bold, __ toggles underline.
function parseRich(text) {
  const runs = [];
  let bold = false, underline = false, buf = "";
  const flush = () => { if (buf) { runs.push({ text: buf, bold, underline }); buf = ""; } };
  for (let i = 0; i < text.length; i++) {
    const two = text.substr(i, 2);
    if (two === "**") { flush(); bold = !bold; i++; continue; }
    if (two === "__") { flush(); underline = !underline; i++; continue; }
    buf += text[i];
  }
  flush();
  return runs;
}
// Split text into paragraphs → words, each word a list of styled pieces.
function richParagraphs(text) {
  return text.split("\n").map((para) => {
    const words = [];
    let cur = null;
    for (const run of parseRich(para)) {
      for (const part of run.text.split(/(\s+)/)) {
        if (part === "") continue;
        if (/^\s+$/.test(part)) { if (cur) { words.push(cur); cur = null; } }
        else { if (!cur) cur = []; cur.push({ text: part, bold: run.bold, underline: run.underline }); }
      }
    }
    if (cur) words.push(cur);
    return words;
  });
}
function pieceFont(p, size) { return `${size}px ${p.bold ? "SupermolotB" : PANEL_FONT}`; }
function wordWidth(ctx, word, size) {
  let w = 0;
  for (const p of word) { ctx.font = pieceFont(p, size); w += ctx.measureText(p.text).width; }
  return w;
}
function wrapRich(ctx, paragraphs, size, maxW) {
  ctx.font = `${size}px ${PANEL_FONT}`;
  const spaceW = ctx.measureText(" ").width;
  const lines = [];
  for (const words of paragraphs) {
    let line = [], lineW = 0;
    for (const word of words) {
      const ww = wordWidth(ctx, word, size);
      const add = line.length ? spaceW + ww : ww;
      if (line.length && lineW + add > maxW) { lines.push(line); line = [word]; lineW = ww; }
      else { line.push(word); lineW += add; }
    }
    lines.push(line);
  }
  return { lines, spaceW };
}

function drawPanelText(ctx, text, zone, color) {
  const t = text.replace(/\s+$/g, "");
  if (!t.trim()) return;
  const paragraphs = richParagraphs(t);
  let size = PANEL_MAX, wrapped = null;
  for (; size >= PANEL_MIN; size--) {
    wrapped = wrapRich(ctx, paragraphs, size, zone.w);
    if (wrapped.lines.length * size * LINE_FACTOR <= zone.h) break;
  }
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const lh = size * LINE_FACTOR;
  const ulThick = Math.max(1, size * 0.06);
  const spaceW = wrapped.spaceW;
  let y = zone.y + Math.max(0, (zone.h - wrapped.lines.length * lh) / 2); // vertically centred
  for (const line of wrapped.lines) {
    let x = zone.x;
    const ulY = y + size * 0.92;
    let prevUnderline = false; // underline state at the end of the previous word
    for (let wi = 0; wi < line.length; wi++) {
      const word = line[wi];
      if (wi > 0) {
        // underline the space too when it sits between two underlined runs
        if (prevUnderline && word.length && word[0].underline) ctx.fillRect(x, ulY, spaceW, ulThick);
        x += spaceW;
      }
      for (const p of word) {
        ctx.font = pieceFont(p, size);
        ctx.fillText(p.text, x, y);
        const pw = ctx.measureText(p.text).width;
        if (p.underline) ctx.fillRect(x, ulY, pw, ulThick);
        x += pw;
        prevUnderline = p.underline;
      }
    }
    y += lh;
  }
}

/* ---------------- Logo (white, hexagon-clipped, zoomable) ---------------- */
// Hexagon outline matching the frame: "v" = points top/bottom (vertical card),
// "h" = points left/right (rotated/landscape card). Flat sides over the middle 50%.
function hexPath(ctx, box, pointy) {
  const { x, y, w, h } = box, cx = x + w / 2, cy = y + h / 2;
  const a = box.flatA != null ? box.flatA : 0.25; // where the flat edge starts
  const b = box.flatB != null ? box.flatB : 0.75; // where the flat edge ends
  ctx.beginPath();
  if (pointy === "h") { // points left/right, flat top & bottom edges
    ctx.moveTo(x, cy);
    ctx.lineTo(x + w * a, y);
    ctx.lineTo(x + w * b, y);
    ctx.lineTo(x + w, cy);
    ctx.lineTo(x + w * b, y + h);
    ctx.lineTo(x + w * a, y + h);
  } else { // points top/bottom, flat left & right edges
    ctx.moveTo(cx, y);
    ctx.lineTo(x + w, y + h * a);
    ctx.lineTo(x + w, y + h * b);
    ctx.lineTo(cx, y + h);
    ctx.lineTo(x, y + h * b);
    ctx.lineTo(x, y + h * a);
  }
  ctx.closePath();
}

// Draw the logo white-tinted, cover-filling the hexagon (so it hides the frame's
// hexagon) and clipped to the hexagon shape. `zoom` scales beyond the cover fit.
function drawLogoHex(ctx, img, box, pointy, logo) {
  const lg = logo || {};
  const z = Math.max(0.3, Math.min(4, lg.zoom || 1));
  const ox = lg.offsetX || 0, oy = lg.offsetY || 0;
  const s = Math.max(box.w / img.width, box.h / img.height) * z;
  const w = img.width * s, h = img.height * s;
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.round(w));
  off.height = Math.max(1, Math.round(h));
  const oc = off.getContext("2d");
  oc.drawImage(img, 0, 0, off.width, off.height);
  oc.globalCompositeOperation = "source-in";
  oc.fillStyle = "#ffffff";
  oc.fillRect(0, 0, off.width, off.height);
  ctx.save();
  hexPath(ctx, box, pointy);
  ctx.clip();
  ctx.drawImage(off, box.x + (box.w - w) / 2 + ox, box.y + (box.h - h) / 2 + oy, w, h);
  ctx.restore();
}

// Rotate an image 90° counter-clockwise into a new canvas (vertical frame → landscape).
function rotate90ccw(img) {
  const c = document.createElement("canvas");
  c.width = img.height; c.height = img.width;
  const x = c.getContext("2d");
  x.translate(0, c.height);
  x.rotate(-Math.PI / 2);
  x.drawImage(img, 0, 0);
  return c;
}

/* ---------------- Background draw (cover + pan/zoom) ---------------- */
// base "cover" scale so scale=1 exactly fills the card; the user transform
// multiplies that scale and offsets from the centred position (card pixels).
function bgBaseScale(img, dw = CARD_W, dh = CARD_H) {
  return Math.max(dw / img.width, dh / img.height);
}
function drawBackground(ctx, img, t, dw = CARD_W, dh = CARD_H) {
  const s = bgBaseScale(img, dw, dh) * clampScale(t ? t.scale : 1);
  const w = img.width * s;
  const h = img.height * s;
  const x = (dw - w) / 2 + (t ? t.offsetX : 0);
  const y = (dh - h) / 2 + (t ? t.offsetY : 0);
  ctx.drawImage(img, x, y, w, h);
}

/* ---------------- Core render ---------------- */
let lastBgImg = null; // background image currently shown in the main preview (for cursor-anchored zoom)

async function renderCard(st, cnv) {
  if (cnv.width !== CARD_W) cnv.width = CARD_W;
  if (cnv.height !== CARD_H) cnv.height = CARD_H;
  const ctx = cnv.getContext("2d");
  ctx.clearRect(0, 0, CARD_W, CARD_H);

  // 1. Background
  let bgImg = null;
  try {
    if (st.bg.type === "preset" && st.bg.name) bgImg = await getPresetImage(st.bg.name);
    else if (st.bg.type === "custom" && st.bg.dataUrl) bgImg = await getImageFromDataUrl(st.bg.dataUrl);
  } catch (e) { /* ignore missing bg */ }
  if (cnv === canvas) lastBgImg = bgImg; // only track the main preview
  if (bgImg) {
    drawBackground(ctx, bgImg, st.bg.transform);
  } else {
    ctx.fillStyle = "#0a0c12";
    ctx.fillRect(0, 0, CARD_W, CARD_H);
  }

  // 2. Panel backings (only if text present)
  if (st.panelTop.trim() && assets.panels.top) ctx.drawImage(assets.panels.top, 0, 0, CARD_W, CARD_H);
  if (st.panelMid.trim() && assets.panels.mid) ctx.drawImage(assets.panels.mid, 0, 0, CARD_W, CARD_H);
  if (st.panelBot.trim() && assets.panels.bot) ctx.drawImage(assets.panels.bot, 0, 0, CARD_W, CARD_H);

  // 2b. Per-value art behind the frame (value_<n>.png; skipped silently if absent)
  const valImg = await getValueOverlay(st.value);
  if (valImg) ctx.drawImage(valImg, 0, 0, CARD_W, CARD_H);

  // 3. Frame (always, on top of panels)
  if (assets.frame) ctx.drawImage(assets.frame, 0, 0, CARD_W, CARD_H);

  // 4. White text
  const WHITE = "#ffffff";
  drawLine(ctx, st.title.trim().toUpperCase(), ZONES.title, WHITE); // protocol title always uppercase
  drawLine(ctx, st.value.trim(), ZONES.value, WHITE);
  drawPanelText(ctx, st.panelTop, ZONES.panels.top, WHITE);
  drawPanelText(ctx, st.panelMid, ZONES.panels.mid, WHITE);
  drawPanelText(ctx, st.panelBot, ZONES.panels.bot, WHITE);

  // 5. Logo (white, clipped to & covering the hexagon)
  if (st.logo.dataUrl) {
    try {
      const img = await getImageFromDataUrl(st.logo.dataUrl);
      drawLogoHex(ctx, img, ZONES.hex, ZONES.hex.pointy, st.logo);
    } catch (e) { /* ignore */ }
  }
}

/* ---------------- Compile card render (landscape) ---------------- */
async function loadBg(st) {
  try {
    if (st.bg.type === "preset" && st.bg.name) return await getPresetImage(st.bg.name);
    if (st.bg.type === "custom" && st.bg.dataUrl) return await getImageFromDataUrl(st.bg.dataUrl);
  } catch (e) {}
  return null;
}

// Render the compile card in landscape (1039×744) — this is what the editor shows.
async function renderCompileLandscape(st, side, cnv) {
  cnv.width = LAND_W; cnv.height = LAND_H;
  const ctx = cnv.getContext("2d");
  ctx.clearRect(0, 0, LAND_W, LAND_H);

  const bgImg = await loadBg(st);
  if (bgImg) drawBackground(ctx, bgImg, st.bg.transform, LAND_W, LAND_H);
  else { ctx.fillStyle = "#0a0c12"; ctx.fillRect(0, 0, LAND_W, LAND_H); }

  const frame = side === "back" ? assets.compileBackLand : assets.compileFrontLand;
  if (frame) ctx.drawImage(frame, 0, 0, LAND_W, LAND_H);

  const WHITE = "#ffffff";
  const up = (s) => (s || "").trim().toUpperCase(); // compile texts are always uppercase
  const name = up(st.title);
  const c = st.compile || {};
  if (side === "back") {
    drawLine(ctx, name, COMPILE_BACK.name, WHITE);
    drawLine(ctx, up(c.back), COMPILE_BACK.backLine, WHITE);
  } else {
    drawLine(ctx, up(c.top), COMPILE_FRONT.topBar, WHITE);
    drawLine(ctx, name, COMPILE_FRONT.name, WHITE);
    drawLine(ctx, up(c.subtitle), COMPILE_FRONT.subtitle, WHITE);
    drawLine(ctx, up(c.bottom), COMPILE_FRONT.bottomBar, WHITE);
  }

  if (cnv === canvas) lastBgImg = bgImg; // track for cursor-anchored zoom

  if (st.logo.dataUrl) {
    try {
      const img = await getImageFromDataUrl(st.logo.dataUrl);
      const hb = side === "back" ? COMPILE_BACK.hex : COMPILE_FRONT.hex;
      drawLogoHex(ctx, img, hb, hb.pointy, st.logo);
    } catch (e) {}
  }
}

// Render the compile card vertical (744×1039, content rotated) for print/PDF.
async function renderCompileVertical(st, side, cnv) {
  const land = document.createElement("canvas");
  await renderCompileLandscape(st, side, land);
  cnv.width = CARD_W; cnv.height = CARD_H;
  const x = cnv.getContext("2d");
  // rotate the landscape master 90° clockwise to fit the portrait card
  x.translate(CARD_W, 0);
  x.rotate(Math.PI / 2);
  x.drawImage(land, 0, 0);
}

/* ---------------- Main preview ---------------- */
const canvas = document.getElementById("cardCanvas");
const canvasBack = document.getElementById("cardCanvasBack"); // compile cards show front + back stacked
const backHolder = document.getElementById("backHolder");
const renderHint = document.getElementById("renderHint");
let renderQueued = false;
let renderQueuedSave = false;
let rendering = false;
let compileSide = "front"; // kept for thumbnails/PDF; the editor now shows both sides at once

let saveTimer = null;
function debouncedSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrent, 400);
}

// save=false during continuous interaction (drag/zoom) to avoid writing localStorage on every frame.
async function scheduleRender(save = true) {
  if (rendering) { renderQueued = true; renderQueuedSave = renderQueuedSave || save; return; }
  rendering = true;
  try {
    if (state.kind === "compile") {
      await renderCompileLandscape(state, "front", canvas);
      await renderCompileLandscape(state, "back", canvasBack);
    } else {
      await renderCard(state, canvas);
    }
  } catch (e) {
    console.error(e);
  }
  if (backHolder) backHolder.hidden = state.kind !== "compile";
  rendering = false;
  layoutOverlay();
  if (save) debouncedSave();
  if (renderQueued) { renderQueued = false; const s = renderQueuedSave; renderQueuedSave = false; scheduleRender(s); }
}

let debTimer = null;
function debouncedRender() {
  clearTimeout(debTimer);
  debTimer = setTimeout(scheduleRender, 90);
}

/* ---------------- In-card editable text overlay ---------------- */
// Editable inputs sit on top of the canvas, one per text zone. Their text is
// transparent (the canvas draws the real, styled text) but the caret is shown,
// so you click on the card and type in place. We mirror the canvas's fitted
// font size onto each field so the caret tracks the rendered glyphs.
const cardOverlay = document.getElementById("cardOverlay");
const cardOverlayBack = document.getElementById("cardOverlayBack");
const measureCtx = document.createElement("canvas").getContext("2d");
// Fields living in each overlay (front overlay also hosts the protocol fields).
const FRONT_IDS = ["inTitle", "inValue", "inTop", "inMid", "inBot", "inCTop", "inCSub", "inCBot"];
const BACK_IDS = ["inTitleBack", "inCBack"];

// Fields live for a given view mode ("protocol" | "front" | "back"), and the
// zone + font each maps to. The protocol title and the compile front "name"
// share #inTitle; the back "name" is #inTitleBack (kept in sync with the title).
function overlayFieldsFor(mode) {
  if (mode === "back") return [
    { id: "inTitleBack", zone: COMPILE_BACK.name, font: "HackedKerX", align: "left", upper: true },
    { id: "inCBack", zone: COMPILE_BACK.backLine, font: "SupermolotR", align: "center", upper: true },
  ];
  if (mode === "front") return [
    { id: "inCTop", zone: COMPILE_FRONT.topBar, font: "SupermolotR", align: "left", upper: true },
    { id: "inTitle", zone: COMPILE_FRONT.name, font: "HackedKerX", align: "center", upper: true },
    { id: "inCSub", zone: COMPILE_FRONT.subtitle, font: "MotionControl", align: "center", upper: true },
    { id: "inCBot", zone: COMPILE_FRONT.bottomBar, font: "SupermolotR", align: "center", upper: true },
  ];
  return [
    { id: "inTitle", zone: ZONES.title, font: "HackedKerX", align: "left", upper: true },
    { id: "inValue", zone: ZONES.value, font: "HackedKerX", align: "center", upper: false },
    { id: "inTop", zone: ZONES.panels.top, font: PANEL_FONT, align: "left", multiline: true },
    { id: "inMid", zone: ZONES.panels.mid, font: PANEL_FONT, align: "left", multiline: true },
    { id: "inBot", zone: ZONES.panels.bot, font: PANEL_FONT, align: "left", multiline: true },
  ];
}
function hexFor(mode) {
  return mode === "back" ? COMPILE_BACK.hex : mode === "front" ? COMPILE_FRONT.hex : ZONES.hex;
}

// Font size + line count the canvas uses for a wrapped panel (mirrors drawPanelText).
function panelFitSize(text, zone) {
  const t = (text || "").replace(/\s+$/g, "");
  if (!t.trim()) return { size: PANEL_MAX, lines: 1 };
  const paras = richParagraphs(t);
  let size = PANEL_MAX, wrapped = null;
  for (; size >= PANEL_MIN; size--) {
    wrapped = wrapRich(measureCtx, paras, size, zone.w);
    if (wrapped.lines.length * size * LINE_FACTOR <= zone.h) break;
  }
  return { size, lines: wrapped ? Math.max(1, wrapped.lines.length) : 1 };
}

// Panels are edited in a contenteditable that shows real (transparent) bold/
// underline instead of the literal ** and __ markers, so the caret tracks the
// rendered glyphs. We convert between the marker string (state/canvas/share)
// and HTML on the way in/out.
const PANEL_IDS = ["inTop", "inMid", "inBot"];
function escapeHtmlText(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function markersToHtml(str) {
  return (str || "").split("\n").map((line) =>
    parseRich(line).map((r) => {
      let h = escapeHtmlText(r.text);
      if (r.underline) h = `<u>${h}</u>`;
      if (r.bold) h = `<b>${h}</b>`;
      return h;
    }).join("")
  ).join("<br>");
}
function htmlToMarkers(root) {
  let out = "", curB = false, curU = false;
  const close = () => { if (curB) { out += "**"; curB = false; } if (curU) { out += "__"; curU = false; } };
  const emit = (text, b, u) => {
    if (!text) return;
    if (b !== curB) { out += "**"; curB = b; }
    if (u !== curU) { out += "__"; curU = u; }
    out += text;
  };
  const walk = (node, b, u) => {
    node.childNodes.forEach((ch) => {
      if (ch.nodeType === 3) {
        ch.nodeValue.split("\n").forEach((part, i) => { if (i) { close(); out += "\n"; } emit(part, b, u); });
        return;
      }
      if (ch.nodeType !== 1) return;
      const tag = ch.tagName.toLowerCase();
      if (tag === "br") { close(); out += "\n"; return; }
      let nb = b, nu = u;
      if (tag === "b" || tag === "strong") nb = true;
      if (tag === "u" || tag === "ins") nu = true;
      const stl = (ch.getAttribute && ch.getAttribute("style")) || "";
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(stl)) nb = true;
      if (/text-decoration[^;]*underline/i.test(stl)) nu = true;
      if ((tag === "div" || tag === "p") && out && !out.endsWith("\n")) { close(); out += "\n"; }
      walk(ch, nb, nu);
    });
  };
  walk(root, false, false);
  close();
  return out.replace(/\n+$/, "");
}
// Refresh a panel's HTML from its marker string, unless the user is editing it.
function setPanelHtml(id, markers) {
  const e = el(id);
  if (!e || document.activeElement === e) return;
  e.innerHTML = markersToHtml(markers || "");
}

// Position every field of one view (mode) over its canvas/overlay.
function layoutOneOverlay(cnv, overlay, hotspotId, mode, ids) {
  if (!cnv || !overlay) return;
  const cardW = cnv.width || CARD_W;
  const rect = cnv.getBoundingClientRect();
  const scale = rect.width ? rect.width / cardW : 0;
  const active = overlayFieldsFor(mode);
  const activeIds = new Set(active.map((f) => f.id));
  ids.forEach((id) => { const e = el(id); if (e && !activeIds.has(id)) e.style.display = "none"; });
  if (!scale) return;
  for (const f of active) {
    const e = el(f.id);
    if (!e) continue;
    const z = f.zone, padX = z.padX || 0;
    e.style.display = "block";
    e.style.left = z.x * scale + "px";
    e.style.top = z.y * scale + "px";
    e.style.width = z.w * scale + "px";
    e.style.height = z.h * scale + "px";
    e.style.fontFamily = f.font;
    e.style.textAlign = f.align;
    e.style.textTransform = f.upper ? "uppercase" : "none";
    e.style.paddingLeft = e.style.paddingRight = padX * scale + "px";
    const raw = (e.value || "").trim();
    const hint = raw || e.placeholder || "";
    if (f.multiline) {
      const markers = htmlToMarkers(e);
      const { size, lines } = panelFitSize(markers || e.dataset.placeholder || "", z);
      const lh = size * LINE_FACTOR * scale;
      e.style.fontSize = size * scale + "px";
      e.style.lineHeight = lh + "px";
      e.style.paddingTop = Math.max(0, (z.h * scale - lines * lh) / 2) + "px"; // vertically centred, matches drawPanelText
      e.style.paddingBottom = "0px";
    } else {
      const disp = f.upper ? hint.toUpperCase() : hint;
      const size = fitSingleLine(measureCtx, disp, f.font, z.w - padX * 2, z.h, z.max, z.min);
      e.style.fontSize = size * scale + "px";
      e.style.lineHeight = z.h * scale + "px"; // vertically centre the single line
      e.style.paddingTop = e.style.paddingBottom = "0px";
    }
  }
  // Clickable logo hotspot over the hexagon.
  const lh = el(hotspotId);
  if (lh) {
    const hz = hexFor(mode);
    lh.style.display = "flex";
    lh.style.left = hz.x * scale + "px";
    lh.style.top = hz.y * scale + "px";
    lh.style.width = hz.w * scale + "px";
    lh.style.height = hz.h * scale + "px";
    lh.style.fontSize = hz.w * scale * 0.3 + "px";
    lh.classList.toggle("has-logo", !!state.logo.dataUrl);
  }
}

function layoutOverlay() {
  if (!cardOverlay) return;
  if (state.kind === "compile") {
    layoutOneOverlay(canvas, cardOverlay, "logoHotspot", "front", FRONT_IDS);
    layoutOneOverlay(canvasBack, cardOverlayBack, "logoHotspotBack", "back", BACK_IDS);
  } else {
    layoutOneOverlay(canvas, cardOverlay, "logoHotspot", "protocol", FRONT_IDS);
    BACK_IDS.forEach((id) => { const e = el(id); if (e) e.style.display = "none"; });
    const lhb = el("logoHotspotBack"); if (lhb) lhb.style.display = "none";
  }
}

if (cardOverlay && typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => layoutOverlay());
  ro.observe(canvas);
  if (canvasBack) ro.observe(canvasBack);
}
// While Shift is held, let pointer events fall through the text fields and the
// logo hotspot to the canvas so pan/zoom works over any zone.
function syncOverlayPanning(e) {
  const on = !!e.shiftKey;
  const movable = on && (state.bg.type !== "none" || !!state.logo.dataUrl);
  [cardOverlay, cardOverlayBack].forEach((o) => o && o.classList.toggle("panning", on));
  [canvas, canvasBack].forEach((c) => c && c.classList.toggle("shift-grab", movable));
}
window.addEventListener("keydown", syncOverlayPanning);
window.addEventListener("keyup", syncOverlayPanning);
window.addEventListener("blur", () => {
  [cardOverlay, cardOverlayBack].forEach((o) => o && o.classList.remove("panning"));
  [canvas, canvasBack].forEach((c) => c && c.classList.remove("shift-grab"));
});

/* ---------------- IndexedDB key-value store ----------------
   localStorage caps at ~5MB, which a few cards with custom images blow past.
   IndexedDB holds far more, so deck + current state live here. */
const DB_NAME = "deckbuilder";
const DB_STORE = "kv";
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- Persistence ---------------- */
function saveCurrent() {
  idbSet("current", state).catch((e) => console.warn("saveCurrent failed", e));
}
async function loadCurrent() {
  try {
    let s = await idbGet("current");
    if (!s) { // one-time migration from the old localStorage key
      const raw = localStorage.getItem(STORE_CURRENT);
      if (raw) { s = JSON.parse(raw); localStorage.removeItem(STORE_CURRENT); }
    }
    if (s) {
      state = normalizeState(s);
    }
  } catch (e) {}
}

// Merge a loaded/imported card state with current defaults (back-compat).
function normalizeState(s) {
  const st = Object.assign(defaultState(), s);
  st.bg = Object.assign({ type: "none", name: null, dataUrl: null }, s.bg || {});
  st.bg.transform = Object.assign(defaultTransform(), st.bg.transform || {});
  migrateBg(st.bg);
  st.logo = Object.assign({ dataUrl: null, zoom: 1 }, s.logo || {});
  st.kind = s.kind === "compile" ? "compile" : "protocol";
  st.compile = Object.assign(defaultCompile(), s.compile || {});
  return st;
}

let deck = [];
async function loadDeck() {
  try {
    deck = await idbGet("deck");
    if (!deck) { // one-time migration from the old localStorage key
      const raw = localStorage.getItem(STORE_DECK);
      deck = raw ? JSON.parse(raw) : [];
      if (raw) localStorage.removeItem(STORE_DECK);
    }
    if (!Array.isArray(deck)) deck = [];
    deck.forEach((c) => { if (c && c.state) migrateBg(c.state.bg); });
    saveDeck();
  } catch (e) { deck = []; }
}
function saveDeck() {
  idbSet("deck", deck).catch((e) => {
    console.error("saveDeck failed", e);
    alert("Could not save the deck. Your browser storage may be full or blocked.");
  });
}

/* ---------------- Form ↔ state sync ---------------- */
const el = (id) => document.getElementById(id);

function syncFormToState() {
  state.title = el("inTitle").value;
  state.value = el("inValue").value;
  state.panelTop = htmlToMarkers(el("inTop"));
  state.panelMid = htmlToMarkers(el("inMid"));
  state.panelBot = htmlToMarkers(el("inBot"));
  if (!state.compile) state.compile = defaultCompile();
  state.compile.top = el("inCTop").value;
  state.compile.subtitle = el("inCSub").value;
  state.compile.bottom = el("inCBot").value;
  state.compile.back = el("inCBack").value;
}

function syncStateToForm() {
  el("inTitle").value = state.title;
  el("inTitleBack").value = state.title;
  el("inValue").value = state.value;
  setPanelHtml("inTop", state.panelTop);
  setPanelHtml("inMid", state.panelMid);
  setPanelHtml("inBot", state.panelBot);
  const c = state.compile || {};
  el("inCTop").value = c.top || "";
  el("inCSub").value = c.subtitle || "";
  el("inCBot").value = c.bottom || "";
  el("inCBack").value = c.back || "";
  refreshLogoUI();
  refreshBgSelection();
  syncBgAdjust();
  applyKind();
}

// Show/hide protocol vs compile fields and update the type/side toggles.
function applyKind() {
  const compile = state.kind === "compile";
  document.querySelectorAll(".protocol-only").forEach((e) => { e.hidden = compile; });
  document.querySelectorAll(".compile-only").forEach((e) => { e.hidden = !compile; });
  el("btnKindProtocol").classList.toggle("active", !compile);
  el("btnKindCompile").classList.toggle("active", compile);
}

function refreshLogoUI() {
  const has = !!state.logo.dataUrl;
  el("btnClearLogo").hidden = !has;
  const prev = el("logoPreview");
  prev.hidden = !has;
  if (has) prev.src = state.logo.dataUrl;
  el("logoAdjust").hidden = !has;
  const pct = Math.round((state.logo.zoom || 1) * 100);
  el("inLogoZoom").value = pct;
  el("logoZoomVal").textContent = pct + "%";
}

function refreshBgSelection() {
  document.querySelectorAll(".bg-thumb").forEach((t) => {
    const isPreset = state.bg.type === "preset" && t.dataset.name === state.bg.name;
    const isCustom = state.bg.type === "custom" && !!t.dataset.url && t.dataset.url === state.bg.dataUrl;
    t.classList.toggle("active", Boolean(isPreset || isCustom)); // explicit boolean: undefined would TOGGLE
  });
}

/* ---------------- Background pan & zoom ---------------- */
function bgTransform() {
  if (!state.bg.transform) state.bg.transform = defaultTransform();
  return state.bg.transform;
}

// Show the adjust controls only when a background is set, and reflect the zoom.
function syncBgAdjust() {
  const on = state.bg.type !== "none";
  el("bgAdjust").hidden = !on;
  const pct = Math.round(clampScale(bgTransform().scale) * 100);
  el("inBgZoom").value = pct;
  el("bgZoomVal").textContent = pct + "%";
}

// card-pixels per CSS-pixel of a displayed canvas
function scaleFactor(cnv) {
  const r = cnv.getBoundingClientRect();
  return r.width ? cnv.width / r.width : 1;
}

// Zoom keeping the content point under (cx,cy) [card pixels] fixed, on canvas cnv.
function zoomAtOn(cnv, cx, cy, factor) {
  const t = bgTransform();
  if (!lastBgImg) { t.scale = clampScale(t.scale * factor); return; }
  const dw = cnv.width, dh = cnv.height;
  const base = bgBaseScale(lastBgImg, dw, dh);
  const s0 = base * t.scale;
  const w0 = lastBgImg.width * s0, h0 = lastBgImg.height * s0;
  const tx0 = (dw - w0) / 2 + t.offsetX;
  const ty0 = (dh - h0) / 2 + t.offsetY;
  const u = (cx - tx0) / s0, v = (cy - ty0) / s0; // content coordinate under cursor
  const newScale = clampScale(t.scale * factor);
  const s1 = base * newScale;
  const w1 = lastBgImg.width * s1, h1 = lastBgImg.height * s1;
  t.offsetX = (cx - u * s1) - (dw - w1) / 2;
  t.offsetY = (cy - v * s1) - (dh - h1) / 2;
  t.scale = newScale;
}

// Pan/zoom requires holding Shift (Ctrl+scroll is hijacked by the browser),
// so normal scrolling/clicking over the card is unaffected.
const panZoomKey = (e) => e.shiftKey;

// Hexagon zone for a given canvas (back canvas → compile back hex).
function hexForCanvas(cnv) {
  if (cnv === canvasBack) return COMPILE_BACK.hex;
  return state.kind === "compile" ? COMPILE_FRONT.hex : ZONES.hex;
}
function pointOn(cnv, e) {
  const r = cnv.getBoundingClientRect(), f = scaleFactor(cnv);
  return { x: (e.clientX - r.left) * f, y: (e.clientY - r.top) * f };
}
function overLogoOn(cnv, e) {
  if (!state.logo.dataUrl) return false;
  const h = hexForCanvas(cnv), p = pointOn(cnv, e);
  return p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h;
}
function clampLogoZoom(z) { return Math.max(0.5, Math.min(3, z)); }

// Hold Shift + drag to pan (logo if hovered, else background); Shift + scroll to
// zoom the same target. Wired on both the front and back canvases.
let dragging = false, dragTarget = null, dragCanvas = null, lastPX = 0, lastPY = 0;
function attachPanZoom(cnv) {
  if (!cnv) return;
  cnv.addEventListener("pointerdown", (e) => {
    if (!panZoomKey(e)) return;
    const onLogo = overLogoOn(cnv, e);
    if (!onLogo && state.bg.type === "none") return; // nothing to drag
    e.preventDefault();
    dragging = true; dragTarget = onLogo ? "logo" : "bg"; dragCanvas = cnv;
    lastPX = e.clientX; lastPY = e.clientY;
    cnv.setPointerCapture(e.pointerId);
    cnv.classList.add("grabbing");
  });
  cnv.addEventListener("pointermove", (e) => {
    if (!dragging || dragCanvas !== cnv) return;
    const f = scaleFactor(cnv);
    const dx = (e.clientX - lastPX) * f, dy = (e.clientY - lastPY) * f;
    if (dragTarget === "logo") {
      state.logo.offsetX = (state.logo.offsetX || 0) + dx;
      state.logo.offsetY = (state.logo.offsetY || 0) + dy;
    } else {
      const t = bgTransform();
      t.offsetX += dx; t.offsetY += dy;
    }
    lastPX = e.clientX; lastPY = e.clientY;
    scheduleRender(false);
  });
  const end = () => {
    if (!dragging || dragCanvas !== cnv) return;
    dragging = false; dragTarget = null; dragCanvas = null;
    cnv.classList.remove("grabbing");
    saveCurrent();
  };
  cnv.addEventListener("pointerup", end);
  cnv.addEventListener("pointercancel", end);
  cnv.addEventListener("wheel", (e) => {
    if (!panZoomKey(e)) return;
    const onLogo = overLogoOn(cnv, e);
    if (!onLogo && state.bg.type === "none") return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    if (onLogo) {
      state.logo.zoom = clampLogoZoom((state.logo.zoom || 1) * factor);
      refreshLogoUI();
    } else {
      const p = pointOn(cnv, e);
      zoomAtOn(cnv, p.x, p.y, factor);
      syncBgAdjust();
    }
    scheduleRender(false);
    debouncedSave();
  }, { passive: false });
}
attachPanZoom(canvas);
attachPanZoom(canvasBack);

/* ---------------- Bindings ---------------- */
["inValue", "inCTop", "inCSub", "inCBot", "inCBack"].forEach((id) => {
  el(id).addEventListener("input", () => { syncFormToState(); layoutOverlay(); debouncedRender(); });
});
// The protocol title / compile name appears on both faces — keep the two fields synced.
function onTitleInput(srcId) {
  const v = el(srcId).value;
  if (el("inTitle").value !== v) el("inTitle").value = v;
  if (el("inTitleBack").value !== v) el("inTitleBack").value = v;
  syncFormToState(); layoutOverlay(); debouncedRender();
}
el("inTitle").addEventListener("input", () => onTitleInput("inTitle"));
el("inTitleBack").addEventListener("input", () => onTitleInput("inTitleBack"));
// Panels are contenteditable: keep them as **/__ markers in state, and restore
// the placeholder when emptied (browsers leave a stray <br> behind).
PANEL_IDS.forEach((id) => {
  const e = el(id);
  e.addEventListener("input", () => {
    if (!e.textContent.trim() && e.innerHTML) e.innerHTML = "";
    syncFormToState(); layoutOverlay(); debouncedRender();
  });
  e.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); document.execCommand("insertLineBreak"); }
  });
});
// Logo zoom
el("inLogoZoom").addEventListener("input", () => {
  state.logo.zoom = Math.max(0.5, Math.min(3, +el("inLogoZoom").value / 100));
  el("logoZoomVal").textContent = Math.round(state.logo.zoom * 100) + "%";
  scheduleRender(false);
  debouncedSave();
});
el("btnLogoReset").addEventListener("click", () => {
  state.logo.zoom = 1;
  state.logo.offsetX = 0;
  state.logo.offsetY = 0;
  refreshLogoUI();
  scheduleRender();
});

// Card type toggle (Protocol / Compile)
function setKind(kind) {
  state.kind = kind;
  applyKind();
  scheduleRender();
}
el("btnKindProtocol").addEventListener("click", () => setKind("protocol"));
el("btnKindCompile").addEventListener("click", () => setKind("compile"));

// Floating formatting toolbar that pops up above a text selection in a panel.
const selToolbar = el("selToolbar");
let lastPanel = "inMid";
PANEL_IDS.forEach((id) => {
  el(id).addEventListener("focus", () => { lastPanel = id; });
});
// The panel element (inTop/inMid/inBot) the current selection lives in, or null.
function panelOfSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  let node = sel.anchorNode;
  while (node && node !== document.body) {
    if (node.nodeType === 1 && PANEL_IDS.includes(node.id)) return node;
    node = node.parentNode;
  }
  return null;
}
function updateSelToolbar() {
  if (!selToolbar) return;
  const panel = panelOfSelection();
  if (!panel) { selToolbar.hidden = true; return; }
  lastPanel = panel.id;
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) { selToolbar.hidden = true; return; }
  selToolbar.hidden = false;
  selToolbar.style.left = rect.left + rect.width / 2 + "px";
  selToolbar.style.top = rect.top - 8 + "px";
}
document.addEventListener("selectionchange", updateSelToolbar);
document.addEventListener("scroll", () => { if (selToolbar && !selToolbar.hidden) updateSelToolbar(); }, true);
if (selToolbar) selToolbar.querySelectorAll(".rt-btn").forEach((b) => {
  b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the panel selection
  b.addEventListener("click", () => {
    const e = el(lastPanel);
    e.focus();
    document.execCommand(b.dataset.mark === "**" ? "bold" : "underline");
    e.dispatchEvent(new Event("input"));
    updateSelToolbar();
  });
});

// Logo upload — keep PNG to preserve transparency for white-tinting.
el("inLogo").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      state.logo.dataUrl = await normalizeImage(reader.result, 320, 320, "image/png");
      refreshLogoUI();
      scheduleRender();
    } catch (err) { alert("Could not read that image file."); }
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});
el("btnClearLogo").addEventListener("click", () => {
  state.logo.dataUrl = null;
  refreshLogoUI();
  scheduleRender();
});
// Click the logo hexagon on the card to upload/replace the logo.
el("logoHotspot").addEventListener("click", () => el("inLogo").click());
el("logoHotspotBack").addEventListener("click", () => el("inLogo").click());

// Background upload — recompress to JPEG sized for the card.
el("inBg").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const dataUrl = await normalizeImage(reader.result, 900, 1260, "image/jpeg", 0.85);
      if (!customBgs.includes(dataUrl)) customBgs.unshift(dataUrl);
      customBgs = customBgs.slice(0, 12); // keep the picker tidy
      saveCustomBgs();
      buildBgGrid();
      selectBg({ type: "custom", dataUrl });
    } catch (err) { alert("Could not read that image file."); }
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});
el("btnNoBg").addEventListener("click", () => {
  state.bg = { type: "none", name: null, dataUrl: null, transform: defaultTransform() };
  refreshBgSelection();
  syncBgAdjust();
  scheduleRender();
});

// Zoom slider (zooms around the card centre)
el("inBgZoom").addEventListener("input", () => {
  bgTransform().scale = clampScale(+el("inBgZoom").value / 100);
  el("bgZoomVal").textContent = Math.round(bgTransform().scale * 100) + "%";
  scheduleRender(false);
  debouncedSave();
});
// Reset pan & zoom
el("btnBgReset").addEventListener("click", () => {
  state.bg.transform = defaultTransform();
  syncBgAdjust();
  scheduleRender();
});

// Background grid: uploaded customs first, then the bundled presets.
let customBgs = [];
function selectBg(bg) {
  state.bg = Object.assign({ type: "none", name: null, dataUrl: null, transform: defaultTransform() }, bg);
  refreshBgSelection();
  syncBgAdjust();
  scheduleRender();
}
function buildBgGrid() {
  const grid = el("bgGrid");
  grid.innerHTML = "";
  customBgs.forEach((url) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bg-thumb";
    btn.dataset.url = url;
    btn.title = "Uploaded";
    btn.innerHTML = `<img src="${url}" alt="uploaded"><span class="bg-del" title="Remove">×</span>`;
    btn.addEventListener("click", (e) => {
      if (e.target.classList.contains("bg-del")) {
        e.stopPropagation();
        customBgs = customBgs.filter((u) => u !== url);
        saveCustomBgs();
        if (state.bg.type === "custom" && state.bg.dataUrl === url) selectBg({ type: "none" });
        buildBgGrid();
        refreshBgSelection();
        return;
      }
      selectBg({ type: "custom", dataUrl: url });
    });
    grid.appendChild(btn);
  });
  for (const name of PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bg-thumb";
    btn.dataset.name = name;
    btn.title = name;
    btn.innerHTML = `<img loading="lazy" src="card-backgrounds/thumbs/${name}.jpg" alt="${name}">`;
    btn.addEventListener("click", () => selectBg({ type: "preset", name }));
    grid.appendChild(btn);
  }
}
function saveCustomBgs() { idbSet("customBgs", customBgs).catch(() => {}); }

/* ---------------- Export ---------------- */
function safeName(s) {
  return (s || "card").trim().replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "card";
}

function downloadCanvas(cnv, filename) {
  cnv.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

el("btnExport").addEventListener("click", async () => {
  await scheduleRender();
  downloadCanvas(canvas, safeName(state.title) + ".png");
});

/* ---------------- Deck ---------------- */
let idCounter = 0;
function newId() {
  idCounter++;
  return "c" + Date.now().toString(36) + "_" + idCounter;
}

async function makeThumb(st) {
  const off = document.createElement("canvas");
  if (st.kind === "compile") await renderCompileLandscape(st, "front", off); // 1039×744 landscape
  else { off.width = CARD_W; off.height = CARD_H; await renderCard(st, off); }
  const tw = 240;
  const t = document.createElement("canvas");
  t.width = tw;
  t.height = Math.round(tw * off.height / off.width);
  t.getContext("2d").drawImage(off, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.78);
}

// Add to deck (new card) OR save changes (while editing). Saving keeps you in
// edit mode so you can keep tweaking without creating duplicates.
// Save changes (while editing) updates the card in place and KEEPS editing it —
// nothing is cleared. When not editing, it adds a new card and clears for the next.
el("btnAddDeck").addEventListener("click", async () => {
  syncFormToState();
  const snapshot = JSON.parse(JSON.stringify(state));
  const thumb = await makeThumb(snapshot);
  if (editingId) {
    const idx = deck.findIndex((d) => d.id === editingId);
    if (idx >= 0) {
      deck[idx].state = snapshot;
      deck[idx].thumb = thumb;
    }
    saveDeck();
    renderDeck();
    autosaveNamedDeck();
    flashSaved();
  } else {
    deck.push({ id: newId(), state: snapshot, thumb });
    saveDeck();
    renderDeck();
    autosaveNamedDeck();
    clearForNextCard(); // reset value + panels for the next card
  }
});

// Add the current editor content as a NEW card (instead of overwriting), then keep
// editing that new card — handy for building value variants quickly.
el("btnAddAsNew").addEventListener("click", async () => {
  syncFormToState();
  const snapshot = JSON.parse(JSON.stringify(state));
  const thumb = await makeThumb(snapshot);
  const id = newId();
  deck.push({ id, state: snapshot, thumb });
  saveDeck();
  setEditing(id); // continue editing the freshly added card
  renderDeck();
  autosaveNamedDeck();
  const b = el("btnAddAsNew"); b.textContent = "✓ Added"; clearTimeout(addNewFlash);
  addNewFlash = setTimeout(() => { b.textContent = "＋ Add as new"; }, 1100);
});
let addNewFlash = null;

// Clear the per-card fields so the next card in the same protocol is quick to build.
function clearForNextCard() {
  state.value = "";
  state.panelTop = "";
  state.panelMid = "";
  state.panelBot = "";
  state.compile = defaultCompile();
  syncStateToForm();
  scheduleRender();
}

let flashTimer = null;
function flashSaved() {
  const b = el("btnAddDeck");
  b.textContent = "✓ Saved";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { b.textContent = editingId ? "💾 Save changes" : "＋ Add to deck"; }, 1100);
}

el("btnCancelEdit").addEventListener("click", () => {
  setEditing(null);
  state = defaultState();
  syncStateToForm();
  scheduleRender();
});

function setEditing(id) {
  editingId = id;
  const editing = !!id;
  el("editStatus").hidden = !editing;
  el("btnCancelEdit").hidden = !editing;
  el("btnAddAsNew").hidden = !editing;
  el("btnAddDeck").textContent = editing ? "💾 Save changes" : "＋ Add to deck";
  document.querySelectorAll(".deck-card").forEach((c) => {
    c.classList.toggle("editing", !!id && c.dataset.id === id);
  });
}

// Keep the working deck ordered: Protocol card (landscape) first, then by value asc.
function sortDeck() {
  deck.sort((a, b) => {
    const pa = a.state.kind === "compile" ? 0 : 1;
    const pb = b.state.kind === "compile" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (pa === 0) return 0;
    return (parseFloat(a.state.value) || 0) - (parseFloat(b.state.value) || 0);
  });
}

function renderDeck() {
  sortDeck();
  const list = el("deckList");
  el("deckCount").textContent = deck.length;
  el("deckEmpty").hidden = deck.length > 0;
  list.innerHTML = "";
  deck.forEach((card) => {
    const wrap = document.createElement("div");
    wrap.className = "deck-card";
    wrap.dataset.id = card.id;
    if (card.id === editingId) wrap.classList.add("editing");
    const title = (card.state.title || "Untitled").trim() || "Untitled";
    wrap.innerHTML = `
      <button class="dc-open" title="Click to edit this card">
        <img src="${card.thumb}" alt="${title}">
      </button>
      <div class="dc-actions">
        <button class="dup" title="Duplicate">⧉</button>
        <button class="dl" title="Download PNG">⬇</button>
        <button class="del" title="Delete">🗑</button>
      </div>`;
    wrap.querySelector(".dc-open").addEventListener("click", () => editCard(card.id));
    wrap.querySelector(".dup").addEventListener("click", () => dupCard(card.id));
    wrap.querySelector(".dl").addEventListener("click", () => dlCard(card));
    wrap.querySelector(".del").addEventListener("click", () => delCard(card.id));
    list.appendChild(wrap);
  });
}

function editCard(id) {
  const card = deck.find((d) => d.id === id);
  if (!card) return;
  state = normalizeState(JSON.parse(JSON.stringify(card.state)));
  compileSide = "front";
  setEditing(id);
  syncStateToForm();
  scheduleRender();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function dupCard(id) {
  const card = deck.find((d) => d.id === id);
  if (!card) return;
  deck.push({ id: newId(), state: JSON.parse(JSON.stringify(card.state)), thumb: card.thumb });
  saveDeck();
  renderDeck();
  autosaveNamedDeck();
}

async function dlCard(card) {
  const off = document.createElement("canvas");
  if (card.state.kind === "compile") await renderCompileLandscape(card.state, "front", off);
  else { off.width = CARD_W; off.height = CARD_H; await renderCard(card.state, off); }
  downloadCanvas(off, safeName(card.state.title) + ".png");
}

/* ---------------- Modal (confirm / prompt / share) ---------------- */
let modalResolve = null;
function showModal(opts) {
  const o = Object.assign({ title: "", body: "", confirmLabel: "OK", cancelLabel: "Cancel", danger: false, input: false, value: "", readonly: false }, opts);
  el("modalTitle").textContent = o.title;
  el("modalBody").textContent = o.body;
  el("modalBody").hidden = !o.body;
  const inp = el("modalInput");
  inp.hidden = !o.input;
  if (o.input) { inp.value = o.value; inp.readOnly = !!o.readonly; }
  const conf = el("modalConfirm");
  conf.textContent = o.confirmLabel;
  conf.classList.toggle("btn-danger", !!o.danger);
  conf.classList.toggle("btn-primary", !o.danger);
  el("modalCancel").textContent = o.cancelLabel;
  el("modalOverlay").hidden = false;
  if (o.input) setTimeout(() => { inp.focus(); inp.select(); }, 30);
  return new Promise((resolve) => { modalResolve = resolve; });
}
function showConfirm({ title, body, confirmLabel = "Delete", danger = true }) {
  return showModal({ title, body, confirmLabel, danger });
}
function closeModal(ok) {
  const inp = el("modalInput");
  const editable = !inp.hidden && !inp.readOnly;
  el("modalOverlay").hidden = true;
  if (modalResolve) {
    const r = !ok ? (editable ? null : false) : (editable ? inp.value : true);
    modalResolve(r); modalResolve = null;
  }
}
el("modalConfirm").addEventListener("click", () => closeModal(true));
el("modalCancel").addEventListener("click", () => closeModal(false));
el("modalOverlay").addEventListener("click", (e) => { if (e.target === el("modalOverlay")) closeModal(false); });
el("modalInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !el("modalInput").readOnly) closeModal(true); });
document.addEventListener("keydown", (e) => { if (!el("modalOverlay").hidden && e.key === "Escape") closeModal(false); });

/* ---------------- Saved decks library ---------------- */
let savedDecks = [];
let currentDeckId = null;   // id of the loaded saved deck (null = unsaved working deck)
let currentDeckName = "";

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function loadSavedDecks() {
  try { savedDecks = (await idbGet("savedDecks")) || []; } catch (e) { savedDecks = []; }
  if (!Array.isArray(savedDecks)) savedDecks = [];
  try { const m = await idbGet("currentDeckMeta"); if (m) { currentDeckId = m.id || null; currentDeckName = m.name || ""; } } catch (e) {}
}
function saveSavedDecks() { idbSet("savedDecks", savedDecks).catch((e) => console.warn("saveSavedDecks", e)); }
function saveDeckMeta() { idbSet("currentDeckMeta", { id: currentDeckId, name: currentDeckName }).catch(() => {}); }

// The background used by a deck (first card that has one) for its row thumbnail.
function deckBgSrc(d) {
  for (const c of d.cards || []) {
    const bg = c.state && c.state.bg;
    if (bg && bg.type === "preset" && bg.name) return `card-backgrounds/thumbs/${bg.name}.jpg`;
    if (bg && bg.type === "custom" && bg.dataUrl) return bg.dataUrl;
  }
  return null;
}

function renderSavedDecks() {
  el("savedCount").textContent = savedDecks.length;
  const list = el("savedList");
  list.innerHTML = "";
  savedDecks.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach((d) => {
    const row = document.createElement("div");
    row.className = "saved-row" + (d.id === currentDeckId ? " current" : "");
    const src = deckBgSrc(d);
    if (src) {
      row.style.backgroundImage = `linear-gradient(90deg, rgba(8,10,16,0.86), rgba(8,10,16,0.5)), url('${src}')`;
      row.style.backgroundSize = "cover";
      row.style.backgroundPosition = "center";
    }
    row.title = "Load this deck";
    row.innerHTML = `<span class="sd-name">${escapeHtml(d.name)}</span><span class="sd-meta">${d.cards.length} cards</span><button class="del" title="Delete">🗑</button>`;
    row.addEventListener("click", () => loadSavedDeck(d.id));
    row.querySelector(".del").addEventListener("click", (e) => { e.stopPropagation(); deleteSavedDeck(d.id); });
    list.appendChild(row);
  });
}

// Upsert the working deck into the library BY NAME (update the deck with this exact
// name, otherwise create a new one — so renaming + saving makes a separate deck).
function upsertSavedDeck(name) {
  currentDeckName = name;
  const cards = JSON.parse(JSON.stringify(deck));
  let d = savedDecks.find((x) => x.name === name);
  if (d) { d.cards = cards; d.updatedAt = Date.now(); currentDeckId = d.id; }
  else { currentDeckId = newId(); savedDecks.push({ id: currentDeckId, name, cards, updatedAt: Date.now() }); }
  saveSavedDecks(); saveDeckMeta(); renderSavedDecks();
}

// If the deck already has a name, keep its saved copy in sync on every change.
function autosaveNamedDeck() {
  const name = el("inDeckName").value.trim();
  if (name) upsertSavedDeck(name);
}

let deckSaveFlash = null;
async function saveCurrentDeck() {
  if (!deck.length) { alert("The deck is empty — add some cards first."); return; }
  let name = el("inDeckName").value.trim();
  if (!name) {
    name = await showModal({ title: "Save deck", body: "Name this deck:", input: true, value: currentDeckName || "My deck", confirmLabel: "Save", danger: false });
    if (name === null) return;
    name = name.trim() || "Untitled deck";
    el("inDeckName").value = name;
  }
  upsertSavedDeck(name);
  const b = el("btnSaveDeck"); b.textContent = "✓ Saved"; clearTimeout(deckSaveFlash);
  deckSaveFlash = setTimeout(() => { b.textContent = "Save"; }, 1100);
}

function loadSavedDeck(id) {
  const d = savedDecks.find((x) => x.id === id);
  if (!d) return;
  deck = d.cards.map((c) => ({ id: c.id || newId(), state: normalizeState(c.state || c), thumb: c.thumb || "" }));
  currentDeckId = id; currentDeckName = d.name; el("inDeckName").value = d.name;
  setEditing(null); saveDeck(); saveDeckMeta();
  renderDeck(); renderSavedDecks();
  regenMissingThumbs().then(renderDeck);
  editProtocolCard(); // auto-select the protocol card for editing
}

// Auto-select the first card for editing. The deck is sorted (protocol card first
// when there is one), so this picks the protocol card if present, otherwise the
// first card — never leaving nothing selected.
function editProtocolCard() {
  if (deck.length) editCard(deck[0].id);
}

async function deleteSavedDeck(id) {
  const d = savedDecks.find((x) => x.id === id);
  if (!d) return;
  const ok = await showConfirm({ title: "Delete saved deck?", body: `Delete “${d.name}” from your saved decks? This can't be undone.` });
  if (!ok) return;
  savedDecks = savedDecks.filter((x) => x.id !== id);
  if (currentDeckId === id) { currentDeckId = null; saveDeckMeta(); }
  saveSavedDecks(); renderSavedDecks();
}

el("btnSaveDeck").addEventListener("click", saveCurrentDeck);
el("inDeckName").addEventListener("input", () => { currentDeckName = el("inDeckName").value; saveDeckMeta(); });

el("btnNewDeck").addEventListener("click", async () => {
  if (deck.length) {
    const ok = await showModal({ title: "New deck?", body: "Start a new empty deck? (Save your current one first if you want to keep it.)", confirmLabel: "New deck", danger: false });
    if (!ok) return;
  }
  deck = []; currentDeckId = null; currentDeckName = ""; el("inDeckName").value = "";
  setEditing(null); saveDeck(); saveDeckMeta(); renderDeck(); renderSavedDecks();
});

/* ---------------- Share link (compressed deck in the URL hash) ---------------- */
async function gzipStr(str) {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(str)); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function gunzipToStr(bytes) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}
function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(b64) {
  b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// Build a compact share payload: uploaded images are stored ONCE in a pool and
// referenced by index (cards in a protocol usually share one bg/logo), and they're
// re-encoded smaller so the link fits in a URL. Thumbnails/ids are dropped.
async function buildSharePayload(name) {
  const imgs = [];
  const cache = new Map(); // original dataUrl -> pool index
  async function ref(url, kind) {
    if (!url) return undefined;
    if (cache.has(url)) return cache.get(url);
    let small = url;
    try {
      small = kind === "logo"
        ? await normalizeImage(url, 256, 256, "image/png")
        : await normalizeImage(url, 720, 1010, "image/jpeg", 0.8);
    } catch (e) {}
    const i = imgs.length; imgs.push(small); cache.set(url, i); return i;
  }
  const cards = [];
  for (const c of deck) {
    const s = c.state;
    const card = {
      title: s.title, value: s.value, panelTop: s.panelTop, panelMid: s.panelMid, panelBot: s.panelBot,
      kind: s.kind, compile: s.compile,
      bg: { type: s.bg.type, name: s.bg.name, transform: s.bg.transform },
      logo: { zoom: (s.logo && s.logo.zoom) || 1, offsetX: (s.logo && s.logo.offsetX) || 0, offsetY: (s.logo && s.logo.offsetY) || 0 },
    };
    if (s.bg.type === "custom" && s.bg.dataUrl) card.bg.img = await ref(s.bg.dataUrl, "bg");
    if (s.logo && s.logo.dataUrl) card.logo.img = await ref(s.logo.dataUrl, "logo");
    cards.push(card);
  }
  return { v: 2, name, imgs, cards };
}

const DPASTE_API = "https://dpaste.com/api/v2/"; // CORS-enabled, returns the snippet URL in the body

el("btnShareDeck").addEventListener("click", async () => {
  if (!deck.length) { alert("The deck is empty."); return; }
  const btn = el("btnShareDeck");
  const orig = btn.textContent; btn.disabled = true; btn.textContent = "…";
  let url, viaService = false;
  try {
    const json = JSON.stringify(await buildSharePayload(el("inDeckName").value.trim() || "Shared deck"));
    // Short link: store the deck in a free service so the URL fits anywhere.
    try {
      const body = new URLSearchParams({ content: json, syntax: "text", expiry_days: "365" });
      const res = await fetch(DPASTE_API, { method: "POST", body }); // form-urlencoded → no CORS preflight
      if (!res.ok) throw new Error("dpaste " + res.status);
      const idd = (await res.text()).trim().split("/").filter(Boolean).pop();
      if (!idd) throw new Error("no id");
      url = `${location.origin}${location.pathname}#d=${idd}`;
      viaService = true;
    } catch (e) {
      // fallback: inline-compressed link (long, but works without the service)
      let encoded;
      try { encoded = bytesToB64url(await gzipStr(json)); } catch (e2) { encoded = bytesToB64url(new TextEncoder().encode(json)); }
      url = `${location.origin}${location.pathname}#deck=${encoded}`;
    }
  } finally { btn.disabled = false; btn.textContent = orig; }
  const ok = await showModal({
    title: "Share deck",
    body: viaService
      ? "Short link ready — anyone who opens it sees the deck and can import it. (Hosted on a free service; may expire after long inactivity.)"
      : "Couldn't reach the link service, so this is a long self-contained link — it works in a browser but may be too long for some chats. Use Export/Import (file) as a fallback.",
    input: true, value: url, readonly: true, confirmLabel: "Copy link", cancelLabel: "Close", danger: false,
  });
  if (ok) { try { await navigator.clipboard.writeText(url); } catch (e) {} }
});

// Order: the Protocol card (landscape) first, then the rest by value ascending.
function sortDeckStates(states) {
  return states.slice().sort((a, b) => {
    const pa = a.kind === "compile" ? 0 : 1; // kind "compile" = landscape = the "Protocol card"
    const pb = b.kind === "compile" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (pa === 0) return 0;
    return (parseFloat(a.value) || 0) - (parseFloat(b.value) || 0);
  });
}

// On load: if the URL carries a shared deck, show it in a gallery (view or import).
let sharedStates = null;
async function checkSharedDeck() {
  const mId = location.hash.match(/[#&]d=([^&]+)/);   // short link (service-hosted)
  const m = location.hash.match(/[#&]deck=([^&]+)/);  // inline link (self-contained)
  if (!mId && !m) return;
  history.replaceState(null, "", location.pathname + location.search); // clear the hash
  showShareLoading();
  let data;
  try {
    if (mId) {
      const res = await fetch(`https://dpaste.com/${mId[1]}.txt`);
      if (!res.ok) throw new Error("dpaste fetch " + res.status);
      data = JSON.parse(await res.text());
    } else {
      const bytes = b64urlToBytes(m[1]);
      let json;
      try { json = await gunzipToStr(bytes); } catch (e) { json = new TextDecoder().decode(bytes); }
      data = JSON.parse(json);
    }
  } catch (e) { console.warn("Shared deck load failed:", e); el("shareView").hidden = true; alert("This shared deck could not be loaded (the link may be invalid or expired)."); return; }
  const name = (data && data.name) || "Shared deck";
  let states;
  if (data && data.v === 2 && Array.isArray(data.imgs)) {
    // v2: images are deduplicated in data.imgs, referenced by index per card
    states = (data.cards || []).map((card) => {
      const bg = Object.assign({ type: "none", name: null, dataUrl: null, transform: defaultTransform() }, card.bg || {});
      if (card.bg && typeof card.bg.img === "number") bg.dataUrl = data.imgs[card.bg.img];
      const logo = { dataUrl: (card.logo && typeof card.logo.img === "number") ? data.imgs[card.logo.img] : null, zoom: (card.logo && card.logo.zoom) || 1 };
      return normalizeState(Object.assign({}, card, { bg, logo }));
    });
  } else {
    const raw = Array.isArray(data) ? data : (data && data.cards) || [];
    states = raw.map((c) => normalizeState(c.state || c));
  }
  if (!states.length) return;
  await openShareView(name, states);
}

// Pasting a share link while the page is already open only changes the hash
// (no reload), so react to that too.
window.addEventListener("hashchange", () => { if (/[#&](deck|d)=/.test(location.hash)) checkSharedDeck(); });

// Cover the page with a loading state while a shared deck is fetched/rendered,
// so the editor doesn't flash behind it.
function showShareLoading() {
  el("shareImport").disabled = true;
  el("shareGrid").innerHTML =
    '<div class="loader">' +
    '<div class="loader-spin"><span class="loader-diamond">◆</span></div>' +
    '<div class="loader-text">Loading shared deck</div>' +
    "</div>";
  el("shareView").classList.add("loading");
  el("shareView").hidden = false;
}

// Full-resolution front image (crisp when shown large in the share gallery).
async function renderFrontImage(st) {
  const off = document.createElement("canvas");
  if (st.kind === "compile") await renderCompileLandscape(st, "front", off);
  else { off.width = CARD_W; off.height = CARD_H; await renderCard(st, off); }
  return off.toDataURL("image/jpeg", 0.9);
}

async function openShareView(name, states) {
  sharedStates = states;
  el("shareViewTitle").textContent = name;
  el("shareViewCount").textContent = states.length;
  const grid = el("shareGrid");
  el("shareView").hidden = false;
  // keep the big centered loader visible while we render the card images
  const sorted = sortDeckStates(states);
  const cardHtml = async (st) => {
    let url = "";
    try { url = await renderFrontImage(st); } catch (e) {}
    const isProtocol = st.kind === "compile";
    const label = isProtocol ? "PROTOCOL" : (String(st.value).trim() ? "VALUE " + st.value : (st.title || "—"));
    return `<div class="sg-card${isProtocol ? " sg-landscape" : ""}"><img src="${url}" alt=""><span class="sg-label">${escapeHtml(label)}</span></div>`;
  };
  const proto = [], values = [];
  for (const st of sorted) (st.kind === "compile" ? proto : values).push(await cardHtml(st));
  let html = "";
  if (proto.length) html += `<div class="sg-protocol">${proto.join("")}</div>`;
  if (values.length) html += `<div class="sg-values">${values.join("")}</div>`;
  el("shareView").classList.remove("loading");
  el("shareImport").disabled = false;
  grid.innerHTML = html || '<div class="sg-empty">Empty deck.</div>';
}

function closeShareView() { el("shareView").hidden = true; sharedStates = null; }
el("shareClose").addEventListener("click", closeShareView);
document.addEventListener("keydown", (e) => { if (!el("shareView").hidden && e.key === "Escape") closeShareView(); });
el("shareImport").addEventListener("click", async () => {
  if (!sharedStates) { closeShareView(); return; }
  const states = sharedStates;
  const name = el("shareViewTitle").textContent || "Shared deck";
  closeShareView();
  deck = states.map((st) => ({ id: newId(), state: st, thumb: "" }));
  currentDeckId = null; currentDeckName = name; el("inDeckName").value = name;
  setEditing(null); saveDeck(); saveDeckMeta(); renderDeck();
  await regenMissingThumbs(); renderDeck();
  editProtocolCard(); // auto-select the protocol card for editing
});

async function delCard(id) {
  const card = deck.find((d) => d.id === id);
  const name = (card && card.state.title) ? `“${card.state.title}”` : "this card";
  const ok = await showConfirm({ title: "Delete card?", body: `Delete ${name} from the deck? This can't be undone.` });
  if (!ok) return;
  deck = deck.filter((d) => d.id !== id);
  if (editingId === id) setEditing(null);
  saveDeck();
  renderDeck();
  autosaveNamedDeck();
}


// Download all
el("btnDownloadAll").addEventListener("click", async () => {
  if (deck.length === 0) { alert("The deck is empty."); return; }
  const btn = el("btnDownloadAll");
  btn.disabled = true;
  const original = btn.textContent;
  for (let i = 0; i < deck.length; i++) {
    btn.textContent = `${i + 1}/${deck.length}…`;
    const off = document.createElement("canvas");
    off.width = CARD_W;
    off.height = CARD_H;
    await renderCard(deck[i].state, off);
    downloadCanvas(off, String(i + 1).padStart(2, "0") + "_" + safeName(deck[i].state.title) + ".png");
    await new Promise((r) => setTimeout(r, 350)); // let the browser process each download
  }
  btn.textContent = original;
  btn.disabled = false;
});

/* ---------------- Print & play PDF (3×3, 63×88mm) ---------------- */
async function renderToJpeg(st) {
  const off = document.createElement("canvas");
  off.width = CARD_W;
  off.height = CARD_H;
  await renderCard(st, off);
  return off.toDataURL("image/jpeg", 0.92);
}

async function renderCompileVerticalJpeg(st, side) {
  const off = document.createElement("canvas");
  await renderCompileVertical(st, side, off);
  return off.toDataURL("image/jpeg", 0.92);
}

let cardBackPng = null;
async function getCardBackPng() {
  if (cardBackPng) return cardBackPng;
  const img = await loadImage("card-back/cardback.png");
  const off = document.createElement("canvas");
  off.width = CARD_W;
  off.height = CARD_H;
  const ctx = off.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  drawBackground(ctx, img, defaultTransform()); // cover-fit into the card aspect
  cardBackPng = off.toDataURL("image/png"); // lossless: best quality for print & play
  return cardBackPng;
}

// Crop ticks in the page margins (don't mark the cards, which are edge-to-edge).
function cropMarks(pdf, mx, my, W, H, cols, rows) {
  pdf.setDrawColor(150);
  pdf.setLineWidth(0.15);
  const t = 3, gap = 1.5, gridW = W * cols, gridH = H * rows;
  for (let c = 0; c <= cols; c++) {
    const x = mx + c * W;
    pdf.line(x, my - gap - t, x, my - gap);
    pdf.line(x, my + gridH + gap, x, my + gridH + gap + t);
  }
  for (let r = 0; r <= rows; r++) {
    const y = my + r * H;
    pdf.line(mx - gap - t, y, mx - gap, y);
    pdf.line(mx + gridW + gap, y, mx + gridW + gap + t, y);
  }
}

el("btnExportPDF").addEventListener("click", async () => {
  if (deck.length === 0) { alert("The deck is empty."); return; }
  const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDFCtor) { alert("PDF library failed to load."); return; }
  const btn = el("btnExportPDF");
  const original = btn.textContent;
  btn.disabled = true;
  try {
    const W = 63, H = 88, cols = 3, rows = 3, per = 9;       // standard card size, 3×3 per A4 page
    const pageW = 210, pageH = 297;
    const mx = (pageW - W * cols) / 2, my = (pageH - H * rows) / 2;
    const pdf = new jsPDFCtor({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    const back = await getCardBackPng();
    const pages = Math.ceil(deck.length / per);
    let firstPage = true;
    for (let p = 0; p < pages; p++) {
      const chunk = deck.slice(p * per, p * per + per);
      // fronts
      if (!firstPage) pdf.addPage();
      firstPage = false;
      cropMarks(pdf, mx, my, W, H, cols, rows);
      for (let i = 0; i < chunk.length; i++) {
        btn.textContent = `${p * per + i + 1}/${deck.length}…`;
        const st = chunk[i].state;
        const url = st.kind === "compile" ? await renderCompileVerticalJpeg(st, "front") : await renderToJpeg(st);
        pdf.addImage(url, "JPEG", mx + (i % cols) * W, my + Math.floor(i / cols) * H, W, H);
      }
      // backs: one per front only (saves ink), mirrored horizontally so they line up
      // with the fronts when printing double-sided with "flip on long edge".
      // Protocol cards share the generic card back; compile cards use their own back face.
      pdf.addPage();
      cropMarks(pdf, mx, my, W, H, cols, rows);
      for (let i = 0; i < chunk.length; i++) {
        const st = chunk[i].state;
        const col = cols - 1 - (i % cols); // mirror column for long-edge duplex flip
        const row = Math.floor(i / cols);
        if (st.kind === "compile") {
          const burl = await renderCompileVerticalJpeg(st, "back");
          pdf.addImage(burl, "JPEG", mx + col * W, my + row * H, W, H);
        } else {
          pdf.addImage(back, "PNG", mx + col * W, my + row * H, W, H, "cardback");
        }
      }
    }
    pdf.save("compiler-deck.pdf");
  } catch (e) {
    console.error(e);
    alert("Could not generate the PDF: " + e.message);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

// Export / import deck JSON
el("btnExportDeck").addEventListener("click", () => {
  if (deck.length === 0) { alert("The deck is empty."); return; }
  const blob = new Blob([JSON.stringify({ version: 1, cards: deck }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "deck.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

el("btnClearDeck").addEventListener("click", async () => {
  const ok = await showConfirm({
    title: "Clear all?",
    body: "This empties the deck and resets the editor fields, and deselects the background (your uploaded backgrounds are kept). This can't be undone.",
    confirmLabel: "Clear all",
  });
  if (!ok) return;
  deck = [];
  state = defaultState();          // blank editor; background deselected (uploads in customBgs stay)
  compileSide = "front";
  currentDeckId = null;
  currentDeckName = "";
  el("inDeckName").value = "";
  setEditing(null);
  saveDeck();
  saveDeckMeta();
  syncStateToForm();               // refreshes the form + deselects bg via refreshBgSelection
  renderDeck();
  renderSavedDecks();              // clear the "current" highlight on any saved deck
  scheduleRender();
});

el("inImportDeck").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const cards = Array.isArray(data) ? data : data.cards;
      if (!Array.isArray(cards)) throw new Error("Invalid format");
      const replace = deck.length === 0 || confirm("Replace the current deck? (Cancel = append to the end)");
      const normalized = cards.map((c) => ({
        id: newId(),
        state: Object.assign(defaultState(), c.state || c),
        thumb: c.thumb || "",
      }));
      deck = replace ? normalized : deck.concat(normalized);
      saveDeck();
      // regenerate any missing thumbnails
      regenMissingThumbs().then(renderDeck);
      renderDeck();
    } catch (err) {
      alert("Could not import the deck: " + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

async function regenMissingThumbs() {
  for (const card of deck) {
    if (!card.thumb) {
      card.thumb = await makeThumb(card.state);
    }
  }
  saveDeck();
}

/* ---------------- Init ---------------- */
(async function init() {
  // If the URL carries a shared deck, cover the page with a loading state right away
  // so the editor doesn't flash before the gallery appears.
  if (/[#&](deck|d)=/.test(location.hash)) showShareLoading();
  try { customBgs = (await idbGet("customBgs")) || []; } catch (e) { customBgs = []; }
  if (!Array.isArray(customBgs)) customBgs = [];
  buildBgGrid();
  await loadDeck();
  await loadCurrent();
  await loadSavedDecks();
  el("inDeckName").value = currentDeckName;
  renderDeck();
  renderSavedDecks();
  syncStateToForm();

  try {
    await loadFonts();
  } catch (e) {
    console.warn("Fonts not loaded:", e);
  }
  try {
    const [frame, top, mid, bot, cFront, cBack] = await Promise.all([
      loadImage("card-frame/frame.png"),
      loadImage("card-frame/panel_top.png"),
      loadImage("card-frame/panel_mid.png"),
      loadImage("card-frame/panel_bot.png"),
      loadImage("card-frame/protocol-front.png"),
      loadImage("card-frame/protocol-back.png"),
    ]);
    assets.frame = frame;
    assets.panels = { top, mid, bot };
    assets.compileFrontLand = rotate90ccw(cFront);
    assets.compileBackLand = rotate90ccw(cBack);
  } catch (e) {
    renderHint.textContent = "⚠ Could not load the frame assets.";
    console.error(e);
    return;
  }

  renderHint.textContent = "Tip: hold Shift and drag to move the background · Shift + scroll to zoom · over the logo it moves/zooms the logo.";
  await scheduleRender();
  await checkSharedDeck(); // import a deck if the URL carries one
})();
