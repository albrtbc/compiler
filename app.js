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
  title: { x: 48, y: 38, w: 240, h: 96, font: "HackedKerX", max: 60, min: 18, align: "left", padX: 18 },
  value: { x: 292, y: 40, w: 159, h: 175, font: "HackedKerX", max: 161, min: 28, dy: 10, dx: 7 },
  hex:   { x: 595, y: 52, w: 104, h: 108, pad: 11 }, // contain box centred on the hexagon (~647,106)
  panels: {
    top: { x: 80, y: 258, w: 580, h: 190 },
    mid: { x: 78, y: 508, w: 570, h: 210 },
    bot: { x: 78, y: 798, w: 585, h: 182 },
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
  bottomBar:{ x: 84, y: 620, w: 928, h: 72, font: "SupermolotR", max: 34, min: 14, align: "center", padX: 22 },
  hex:      { x: 867, y: 40, w: 124, h: 128, pad: 12 },   // hexagon center ≈(929,104)
};
const COMPILE_BACK = {
  // name sits in the thick (left) part of the bottom bar, left-aligned at the same height as the back line
  name:     { x: 78, y: 592, w: 510, h: 128, font: "HackedKerX", max: 104, min: 24, align: "left", padX: 30 }, // center ≈656
  backLine: { x: 652, y: 626, w: 356, h: 84, font: "SupermolotR", max: 40, min: 14, align: "center", padX: 16 }, // center ≈668
  hex:      { x: 867, y: 40, w: 124, h: 128, pad: 12 },   // hexagon center ≈(929,104)
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
  logo: { dataUrl: null, white: true },
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
  let y = zone.y + Math.max(0, (zone.h - wrapped.lines.length * lh) / 2);
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

/* ---------------- Logo tinting ---------------- */
function makeLogoCanvas(img, white) {
  // contain into the hex box (minus padding so it doesn't touch the edges)
  const box = ZONES.hex;
  const pad = box.pad || 0;
  const scale = Math.min((box.w - pad * 2) / img.width, (box.h - pad * 2) / img.height);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const c = off.getContext("2d");
  c.drawImage(img, 0, 0, w, h);
  if (white) {
    c.globalCompositeOperation = "source-in";
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, w, h);
  }
  return { canvas: off, w, h };
}

// Generic logo placement into an arbitrary {x,y,w,h,pad} box (used by the compile card).
function drawLogoBox(ctx, img, white, box) {
  const pad = box.pad || 0;
  const scale = Math.min((box.w - pad * 2) / img.width, (box.h - pad * 2) / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const c = off.getContext("2d");
  c.drawImage(img, 0, 0, w, h);
  if (white) {
    c.globalCompositeOperation = "source-in";
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, w, h);
  }
  ctx.drawImage(off, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2);
}

// Cover-fit an image into a w×h area, centred.
function coverDraw(ctx, img, dw, dh) {
  const s = Math.max(dw / img.width, dh / img.height);
  ctx.drawImage(img, (dw - img.width * s) / 2, (dh - img.height * s) / 2, img.width * s, img.height * s);
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

  // 3. Frame (always, on top of panels)
  if (assets.frame) ctx.drawImage(assets.frame, 0, 0, CARD_W, CARD_H);

  // 4. White text
  const WHITE = "#ffffff";
  drawLine(ctx, st.title.trim().toUpperCase(), ZONES.title, WHITE); // protocol title always uppercase
  drawLine(ctx, st.value.trim(), ZONES.value, WHITE);
  drawPanelText(ctx, st.panelTop, ZONES.panels.top, WHITE);
  drawPanelText(ctx, st.panelMid, ZONES.panels.mid, WHITE);
  drawPanelText(ctx, st.panelBot, ZONES.panels.bot, WHITE);

  // 5. Logo in the hexagon
  if (st.logo.dataUrl) {
    try {
      const img = await getImageFromDataUrl(st.logo.dataUrl);
      const { canvas: lc, w, h } = makeLogoCanvas(img, st.logo.white);
      const box = ZONES.hex;
      ctx.drawImage(lc, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
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
      drawLogoBox(ctx, img, st.logo.white, side === "back" ? COMPILE_BACK.hex : COMPILE_FRONT.hex);
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
const renderHint = document.getElementById("renderHint");
let renderQueued = false;
let renderQueuedSave = false;
let rendering = false;
let compileSide = "front"; // which side of a compile card is being previewed/edited

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
    if (state.kind === "compile") await renderCompileLandscape(state, compileSide, canvas);
    else await renderCard(state, canvas);
  } catch (e) {
    console.error(e);
  }
  rendering = false;
  if (save) debouncedSave();
  if (renderQueued) { renderQueued = false; const s = renderQueuedSave; renderQueuedSave = false; scheduleRender(s); }
}

let debTimer = null;
function debouncedRender() {
  clearTimeout(debTimer);
  debTimer = setTimeout(scheduleRender, 90);
}

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
  st.logo = Object.assign({ dataUrl: null, white: true }, s.logo || {});
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
  state.panelTop = el("inTop").value;
  state.panelMid = el("inMid").value;
  state.panelBot = el("inBot").value;
  state.logo.white = el("inLogoWhite").checked;
  if (!state.compile) state.compile = defaultCompile();
  state.compile.top = el("inCTop").value;
  state.compile.subtitle = el("inCSub").value;
  state.compile.bottom = el("inCBot").value;
  state.compile.back = el("inCBack").value;
}

function syncStateToForm() {
  el("inTitle").value = state.title;
  el("inValue").value = state.value;
  el("inTop").value = state.panelTop;
  el("inMid").value = state.panelMid;
  el("inBot").value = state.panelBot;
  el("inLogoWhite").checked = state.logo.white;
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
  el("btnSideFront").classList.toggle("active", compileSide === "front");
  el("btnSideBack").classList.toggle("active", compileSide === "back");
  document.querySelectorAll(".compile-front-only").forEach((e) => { e.hidden = compileSide !== "front"; });
  document.querySelectorAll(".compile-back-only").forEach((e) => { e.hidden = compileSide !== "back"; });
}

function refreshLogoUI() {
  const has = !!state.logo.dataUrl;
  el("btnClearLogo").hidden = !has;
  el("logoName").textContent = has ? "logo loaded" : "";
}

function refreshBgSelection() {
  document.querySelectorAll(".bg-thumb").forEach((t) => {
    t.classList.toggle("active", state.bg.type === "preset" && t.dataset.name === state.bg.name);
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
  canvas.classList.toggle("draggable", on);
  const pct = Math.round(clampScale(bgTransform().scale) * 100);
  el("inBgZoom").value = pct;
  el("bgZoomVal").textContent = pct + "%";
}

// card-pixels per CSS-pixel of the displayed canvas (canvas.width tracks the
// current orientation: 744 for protocol, 1039 for compile/landscape)
function canvasScaleFactor() {
  const r = canvas.getBoundingClientRect();
  return r.width ? canvas.width / r.width : 1;
}

// Zoom keeping the content point under (cx,cy) [card pixels] fixed.
function zoomAt(cx, cy, factor) {
  const t = bgTransform();
  if (!lastBgImg) { t.scale = clampScale(t.scale * factor); return; }
  const dw = canvas.width, dh = canvas.height;
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

// Drag to pan
let dragging = false, lastPX = 0, lastPY = 0;
canvas.addEventListener("pointerdown", (e) => {
  if (state.bg.type === "none") return;
  dragging = true;
  lastPX = e.clientX; lastPY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("grabbing");
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const f = canvasScaleFactor();
  const t = bgTransform();
  t.offsetX += (e.clientX - lastPX) * f;
  t.offsetY += (e.clientY - lastPY) * f;
  lastPX = e.clientX; lastPY = e.clientY;
  scheduleRender(false);
});
function endDrag() {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove("grabbing");
  saveCurrent();
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// Scroll to zoom (anchored at cursor)
canvas.addEventListener("wheel", (e) => {
  if (state.bg.type === "none") return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const f = canvasScaleFactor();
  const cx = (e.clientX - r.left) * f;
  const cy = (e.clientY - r.top) * f;
  zoomAt(cx, cy, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  syncBgAdjust();
  scheduleRender(false);
  debouncedSave();
}, { passive: false });

/* ---------------- Bindings ---------------- */
["inTitle", "inValue", "inTop", "inMid", "inBot", "inCTop", "inCSub", "inCBot", "inCBack"].forEach((id) => {
  el(id).addEventListener("input", () => { syncFormToState(); debouncedRender(); });
});
el("inLogoWhite").addEventListener("change", () => { syncFormToState(); scheduleRender(); });

// Card type toggle (Protocol / Compile)
function setKind(kind) {
  state.kind = kind;
  applyKind();
  scheduleRender();
}
el("btnKindProtocol").addEventListener("click", () => setKind("protocol"));
el("btnKindCompile").addEventListener("click", () => setKind("compile"));

// Compile front/back toggle
function setSide(side) {
  compileSide = side;
  applyKind();
  scheduleRender();
}
el("btnSideFront").addEventListener("click", () => setSide("front"));
el("btnSideBack").addEventListener("click", () => setSide("back"));

// Rich-text buttons: wrap the textarea selection in **/__ markers.
function wrapSelection(id, mark) {
  const ta = el(id);
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const sel = v.slice(s, e);
  ta.value = v.slice(0, s) + mark + sel + mark + v.slice(e);
  const inner = s + mark.length;
  ta.focus();
  ta.setSelectionRange(inner, inner + sel.length);
  ta.dispatchEvent(new Event("input"));
}
document.querySelectorAll(".rt-btn").forEach((b) => {
  b.addEventListener("mousedown", (e) => e.preventDefault()); // keep textarea selection
  b.addEventListener("click", () => wrapSelection(b.dataset.target, b.dataset.mark));
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

// Background upload — recompress to JPEG sized for the card.
el("inBg").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const dataUrl = await normalizeImage(reader.result, 900, 1260, "image/jpeg", 0.85);
      state.bg = { type: "custom", name: null, dataUrl, transform: defaultTransform() };
      refreshBgSelection();
      syncBgAdjust();
      scheduleRender();
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

// Background preset grid
function buildBgGrid() {
  const grid = el("bgGrid");
  grid.innerHTML = "";
  for (const name of PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bg-thumb";
    btn.dataset.name = name;
    btn.title = name;
    btn.innerHTML = `<img loading="lazy" src="card-backgrounds/thumbs/${name}.jpg" alt="${name}">`;
    btn.addEventListener("click", () => {
      state.bg = { type: "preset", name, dataUrl: null, transform: defaultTransform() };
      refreshBgSelection();
      syncBgAdjust();
      scheduleRender();
    });
    grid.appendChild(btn);
  }
}

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
    setEditing(null); // deselect after saving so the next "Add to deck" creates a new card
    renderDeck();
    flashSaved();
  } else {
    deck.push({ id: newId(), state: snapshot, thumb });
    saveDeck();
    renderDeck();
  }
  clearForNextCard(); // reset value + panels (keep protocol, logo, background)
});

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
  el("btnAddDeck").textContent = editing ? "💾 Save changes" : "＋ Add to deck";
  document.querySelectorAll(".deck-card").forEach((c) => {
    c.classList.toggle("editing", !!id && c.dataset.id === id);
  });
}

function renderDeck() {
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
        <div class="dc-title" title="${title}">${title}</div>
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
}

async function dlCard(card) {
  const off = document.createElement("canvas");
  if (card.state.kind === "compile") await renderCompileLandscape(card.state, "front", off);
  else { off.width = CARD_W; off.height = CARD_H; await renderCard(card.state, off); }
  downloadCanvas(off, safeName(card.state.title) + ".png");
}

function delCard(id) {
  const card = deck.find((d) => d.id === id);
  const name = (card && card.state.title) ? `“${card.state.title}”` : "this card";
  if (!confirm(`Delete ${name} from the deck?`)) return;
  deck = deck.filter((d) => d.id !== id);
  if (editingId === id) setEditing(null);
  saveDeck();
  renderDeck();
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

let cardBackJpeg = null;
async function getCardBackJpeg() {
  if (cardBackJpeg) return cardBackJpeg;
  const img = await loadImage("card-back/cardback.jpg");
  const off = document.createElement("canvas");
  off.width = CARD_W;
  off.height = CARD_H;
  const ctx = off.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  drawBackground(ctx, img, defaultTransform()); // cover-fit into the card aspect
  cardBackJpeg = off.toDataURL("image/jpeg", 0.92);
  return cardBackJpeg;
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
    const back = await getCardBackJpeg();
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
          pdf.addImage(back, "JPEG", mx + col * W, my + row * H, W, H, "cardback");
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

el("btnClearDeck").addEventListener("click", () => {
  if (deck.length === 0) { alert("The deck is already empty."); return; }
  if (!confirm(`Delete ALL ${deck.length} cards from the deck? This cannot be undone.`)) return;
  deck = [];
  setEditing(null);
  saveDeck();
  renderDeck();
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
  buildBgGrid();
  await loadDeck();
  await loadCurrent();
  renderDeck();
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
      loadImage("card-frame/compile-front.png"),
      loadImage("card-frame/compile-back.png"),
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

  renderHint.textContent = "";
  await scheduleRender();
})();
