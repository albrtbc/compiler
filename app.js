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

import {
  CARD_W, CARD_H, LAND_W, LAND_H, MOSAIC_ASPECT,
  PANEL_FONT, LINE_FACTOR,
  ZONES, COMPILE_FRONT, COMPILE_BACK,
  PRESETS, GLITCH_PRESETS, STORE_DECK, STORE_CURRENT,
} from "./src/config.js";
import { clampScale, bgBaseScale, cellTransform } from "./src/core/geometry.js";
import { bytesToB64url, b64urlToBytes } from "./src/core/base64.js";
import { imgKey } from "./src/core/imageKey.js";
import { defaultTransform, defaultBg, defaultLogo, migrateBg, sameBg, hydrateBg, hydrateLogo } from "./src/model/bg.js";
import { compareCardStates, compareDeckEntries } from "./src/model/order.js";
import {
  loadImage, normalizeImage, encodeForShare,
  getImageFromDataUrl, getPresetImage, getValueOverlay, rotate90ccw,
} from "./src/core/images.js";
import {
  fitSingleLine, drawLine, drawPanelText, panelFitSize, markersToHtml, htmlToMarkers,
} from "./src/render/text.js";
import { glitchSeed, applyFrontGlitch } from "./src/render/glitch.js";
import { drawLogoHex, drawBackground, drawSideCode, toPoker } from "./src/render/draw.js";
import { idbGet, idbSet } from "./src/storage/idb.js";

let exportScale = 1; // 1 = 300dpi, 2 = 600dpi (set by the export-resolution toggle)

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
  kind: "compile", // "compile" = vertical value card · "protocol" = landscape Protocol card
  // Per-card background data, used only when the deck-wide `perCardBg` mode is on;
  // otherwise the card renders the shared bg and bgOwn is ignored / not persisted.
  bgOwn: { type: "none", name: null, dataUrl: null, transform: { scale: 1, offsetX: 0, offsetY: 0 } },
  compile: defaultCompile(),
});

// Logo + background are shared per card kind across the whole deck: a single
// place holds them and every card of that kind reads from it, so editing one
// updates all of that kind. Cards keep only their own text/value.
// title is shared across the WHOLE deck (both kinds); bg + logo are shared per kind.
let deckShared = {
  title: "",
  code: "",           // deck-wide set code shown on the card edge (e.g. "HMBW", like MN01/AX01)
  perCardBg: false,   // deck-wide: when on, each card renders its own bgOwn instead of the shared bg
  glitchPreset: 1,    // deck-wide front glitch: 0 = none, 1..10 = preset (default 1 = first preset)
  split: null,        // saved image-split config { dataUrl, ix0, iy0, w, h } (image-pixel region under the grid)
  protocol: { bg: defaultBg(), logo: defaultLogo() },
  compile: { bg: defaultBg(), logo: defaultLogo() },
};
function sharedFor(kind) { return deckShared[kind === "compile" ? "compile" : "protocol"]; }
// Card-kind semantics in ONE place: the landscape "Protocol card" is kind
// "protocol" (two faces); a vertical value card is kind "compile" (one face).
const isLandscapeKind = (kind) => kind === "protocol";
// A render-ready copy of a card with the shared title + per-kind bg/logo merged
// in. `st._shared` (={title,bg,logo}) overrides the global deck props — used to
// render a foreign deck in the share gallery without touching the viewer's deck.
function mergeShared(st) {
  if (st._shared) {
    const ownBg = st._shared.perCardBg ? (st.bgOwn || defaultBg()) : null;
    return Object.assign({}, st, { title: st._shared.title, bg: ownBg || st._shared.bg, logo: st._shared.logo });
  }
  const sh = sharedFor(st.kind);
  const ownBg = deckShared.perCardBg ? (st.bgOwn || defaultBg()) : null; // deck-wide per-card mode
  return Object.assign({}, st, { title: deckShared.title, bg: ownBg || sh.bg, logo: sh.logo });
}

let state = null;
let editingId = null; // id of the deck card being edited, or null
// Pending unsaved changes to the working deck (relative to its "My decks" copy).
// Edits stay local until the user presses "Save changes"; we never auto-save the
// named deck into the library on every tweak anymore.
let deckDirty = false;
// Snapshot of the last saved/baseline working state (deck + shared props + meta),
// restored when the user presses Cancel to discard all pending changes.
let revertSnapshot = null;
// Which face of a compile card the background controls edit (per-card mode only):
// "front" → bgOwn, "back" → bgOwnBack. A compile card can have a different bg per face.
let bgEditSide = "front";
// The current card's title, background and logo are NOT stored on the card — they
// live in `deckShared` (title deck-wide; bg/logo per kind) and are read/written
// through the explicit editTitle/editBg/editLogo accessors below. This keeps the
// deck de-duplicated (cards carry only their own text/value) without any hidden
// property magic on `state`.
function setState(obj) {
  state = obj;
  return state;
}
setState(defaultState());

/* ---- Editor accessors: the working card's title/bg/logo, routed to deckShared ----
   Reads return the shared object by reference, so mutating a returned bg/logo edits
   the shared copy in place; the setters route a whole new value to the right slot. */
function editTitle() { return deckShared.title; }
function setEditTitle(v) { deckShared.title = v; }

function editBg() {
  if (!deckShared.perCardBg) return sharedFor(state.kind).bg;
  if (state.kind === "protocol" && bgEditSide === "back") return state.bgOwnBack || state.bgOwn;
  return state.bgOwn;
}
function setEditBg(v) {
  if (!deckShared.perCardBg) {
    // Default mode = one deck-wide background: apply to BOTH kinds so the
    // Protocol card (and its back) get it automatically too.
    deckShared.protocol.bg = JSON.parse(JSON.stringify(v));
    deckShared.compile.bg = JSON.parse(JSON.stringify(v));
    return;
  }
  if (state.kind === "protocol" && bgEditSide === "back") state.bgOwnBack = v;
  else state.bgOwn = v;
}

function editLogo() { return sharedFor(state.kind).logo; }
function setEditLogo(v) { sharedFor(state.kind).logo = v; }

// A deck card snapshot keeps only its own content; the shared title/bg/logo come
// from deckShared at render time (de-duplicated, never copied per card).
function cardSnapshot(st) {
  const snap = JSON.parse(JSON.stringify(st));
  delete snap.title; delete snap.bg; delete snap.logo; delete snap.customBg;
  if (!deckShared.perCardBg) { delete snap.bgOwn; delete snap.bgOwnBack; } // per-card bgs only in per-card mode
  return snap;
}

/* ---------------- Asset loading ---------------- */
const assets = { frame: null, panels: {}, compileFrontLand: null, compileBackLand: null };

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

/* ---------------- Deck-wide glitch + code selectors ---------------- */
// Selected glitch preset index for a card (0 = none).
function glitchPresetOf(st) { return st._shared ? (st._shared.glitchPreset || 0) : deckShared.glitchPreset; }
function deckCode(st) { return st._shared ? st._shared.code : deckShared.code; }

/* ---------------- Core render ---------------- */
let lastBgImg = null; // background image currently shown in the main preview (for cursor-anchored zoom)

async function renderCard(st, cnv, hq = false, scale = 1) {
  st = mergeShared(st); // bg + logo come from the per-kind shared props
  const W = Math.round(CARD_W * scale), H = Math.round(CARD_H * scale);
  if (cnv.width !== W) cnv.width = W;
  if (cnv.height !== H) cnv.height = H;
  const ctx = cnv.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0); // draw in design space; supersample for hi-res export
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; // crisp downscale of large bg images
  ctx.clearRect(0, 0, CARD_W, CARD_H);

  // 1. Background
  let bgImg = null;
  try {
    if (st.bg.type === "preset" && st.bg.name) bgImg = await getPresetImage(st.bg.name);
    else if (st.bg.type === "custom" && st.bg.dataUrl) bgImg = await getImageFromDataUrl(st.bg.dataUrl);
  } catch (e) { /* ignore missing bg */ }
  if (cnv === canvas) lastBgImg = bgImg; // only track the main preview
  if (bgImg) {
    drawBackground(ctx, bgImg, st.bg.transform, CARD_W, CARD_H, hq);
  } else {
    ctx.fillStyle = "#0a0c12";
    ctx.fillRect(0, 0, CARD_W, CARD_H);
  }
  // NB: the glitch is intentionally NOT applied here — it's only for the Protocol
  // (landscape) card's front face, handled in renderCompileLandscape.

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

  // 6. Set code: right edge box, top anchored to the frame's white divider line,
  //    glyphs squished vertically (low condense) with letterSpacing bumped to keep
  //    the gaps the same. condense scales the run (vertical) only; size = horizontal.
  drawSideCode(ctx, deckCode(st), { x: 695, y: 475, size: 24, vertical: true, font: "SupermolotB", letterSpacing: 5, condense: 1.72, topAnchor: true });
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
async function renderCompileLandscape(st, side, cnv, hq = false, scale = 1) {
  const perCard = st._shared ? st._shared.perCardBg : deckShared.perCardBg;
  st = mergeShared(st); // bg + logo come from the per-kind shared props
  // In per-card mode the back face can carry its own background.
  if (perCard && side === "back" && st.bgOwnBack) st = Object.assign({}, st, { bg: st.bgOwnBack });
  cnv.width = Math.round(LAND_W * scale); cnv.height = Math.round(LAND_H * scale);
  const ctx = cnv.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0); // draw in design space; supersample for hi-res export
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; // crisp downscale of large bg images
  ctx.clearRect(0, 0, LAND_W, LAND_H);

  const bgImg = await loadBg(st);
  if (bgImg) drawBackground(ctx, bgImg, st.bg.transform, LAND_W, LAND_H, hq);
  else { ctx.fillStyle = "#0a0c12"; ctx.fillRect(0, 0, LAND_W, LAND_H); }
  // Only the front face is glitched; the back keeps the clean image.
  const gp = glitchPresetOf(st);
  if (side !== "back" && gp > 0) applyFrontGlitch(ctx, LAND_W, LAND_H, glitchSeed(st) + "|front", GLITCH_PRESETS[gp - 1]);

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
async function renderCompileVertical(st, side, cnv, hq = false, scale = 1) {
  const land = document.createElement("canvas");
  await renderCompileLandscape(st, side, land, hq, scale);
  cnv.width = Math.round(CARD_W * scale); cnv.height = Math.round(CARD_H * scale);
  const x = cnv.getContext("2d");
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
  // rotate the landscape master 90° clockwise to fit the portrait card
  x.translate(CARD_W * scale, 0);
  x.rotate(Math.PI / 2);
  x.drawImage(land, 0, 0);
}

// Render one face of a card into a canvas, dispatching on kind — the single place
// that knows "protocol" → landscape renderer (+ face) and "compile" → the vertical
// value-card renderer. Callers (thumbnails, single/all PNG export, share gallery)
// go through this instead of branching on kind themselves.
async function renderKind(st, cnv, { side = "front", hq = false, scale = 1 } = {}) {
  if (isLandscapeKind(st.kind)) return renderCompileLandscape(st, side, cnv, hq, scale);
  return renderCard(st, cnv, hq, scale);
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
    if (isLandscapeKind(state.kind)) {
      await renderCompileLandscape(state, "front", canvas);
      await renderCompileLandscape(state, "back", canvasBack);
    } else {
      await renderCard(state, canvas);
    }
  } catch (e) {
    console.error(e);
  }
  if (backHolder) backHolder.hidden = !isLandscapeKind(state.kind);
  rendering = false;
  layoutOverlay();
  if (save) debouncedSave();
  if (renderQueued) { renderQueued = false; const s = renderQueuedSave; renderQueuedSave = false; scheduleRender(s); }
  else hidePreviewLoading(); // the (heavy) render that prompted the spinner has finished
}
const stageEl = document.querySelector(".stage");
let previewLoadTimer = null, previewShownAt = 0, bulkLoading = false;
// Per-render spinner: delayed-show so a fast cached render never flashes it.
function showPreviewLoading() {
  if (bulkLoading) return; // a deck-load already owns the overlay; don't arm a stray timer
  clearTimeout(previewLoadTimer);
  previewLoadTimer = setTimeout(() => { if (stageEl) { stageEl.classList.add("loading"); previewShownAt = performance.now(); } }, 130);
}
function hidePreviewLoading() {
  clearTimeout(previewLoadTimer); // always cancel a pending delayed-show
  if (bulkLoading) return;        // a deck-load owns the overlay class; it clears it itself
  if (stageEl) stageEl.classList.remove("loading");
}
// Bulk load (opening a deck, startup, import): show the overlay immediately and
// keep it up for a clearly-visible minimum, regardless of how fast the work is.
async function withDeckLoading(fn) {
  bulkLoading = true;
  if (stageEl) { stageEl.classList.add("loading"); previewShownAt = performance.now(); }
  try { return await fn(); }
  finally {
    const wait = Math.max(0, 480 - (performance.now() - previewShownAt));
    setTimeout(() => { bulkLoading = false; if (stageEl) stageEl.classList.remove("loading"); }, wait);
  }
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
// Set-code overlay: rotated field on the right edge at mid-height. Centre + size
// match drawSideCode; len/thick are the (pre-rotation) box the input occupies.
// Only on the vertical "Compile card" (kind="protocol"); not on the landscape card.
const CODE_ZONE = {
  // Mirrors drawSideCode's anchor (x:695, y:475) + style, so the input/caret track
  // the glyphs at ANY length. `len` is just the clickable run length; the rest match
  // drawSideCode (letterSpacing/condense are pre-scaleX — the transform stretches).
  protocol: { x: 695, y: 475, len: 180, thick: 34, size: 24, font: "SupermolotB", letterSpacing: 5, condense: 1.72 },
};
function layoutCodeField(inputId, z, scale) {
  const e = el(inputId);
  if (!e) return;
  const w = z.len * scale, h = z.thick * scale;
  const ax = z.x * scale, ay = z.y * scale; // anchor = drawSideCode's (x,y): the run's fixed TOP end
  e.style.display = "block";
  e.style.width = w + "px";
  e.style.height = h + "px";
  e.style.left = (ax - w) + "px";        // box extends left of the anchor → "down" once rotated
  e.style.top = (ay - h / 2) + "px";
  e.style.transformOrigin = "100% 50%";  // rotate/scale about the anchored (right-edge) end
  // Mirror drawSideCode (topAnchor + textAlign right): pin the top end and grow
  // down with the same letter-spacing + condense, so the caret tracks the glyphs
  // for ANY number of letters — not just the 5 the box used to be sized for.
  const cond = z.condense || 1;
  e.style.transform = "rotate(-90deg)" + (cond !== 1 ? " scaleX(" + cond + ")" : "");
  e.style.textAlign = "right";
  e.style.fontFamily = z.font;
  e.style.fontSize = z.size * scale + "px";
  e.style.letterSpacing = ((z.letterSpacing || 0) * scale) + "px";
  e.style.lineHeight = h + "px";
}

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

// Panels are edited in a contenteditable that shows real (transparent) bold/
// underline instead of the literal ** and __ markers, so the caret tracks the
// rendered glyphs. We convert between the marker string (state/canvas/share)
// and HTML on the way in/out.
const PANEL_IDS = ["inTop", "inMid", "inBot"];
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
  // Rotated set-code field on the right edge (vertical "Compile card" only).
  const cz = CODE_ZONE[mode];
  if (cz) layoutCodeField("inCode", cz, scale);
  else { const ce = el("inCode"); if (ce) ce.style.display = "none"; }
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
    lh.classList.toggle("has-logo", !!editLogo().dataUrl);
  }
}

function layoutOverlay() {
  if (!cardOverlay) return;
  if (isLandscapeKind(state.kind)) {
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
  const movable = on && (editBg().type !== "none" || !!editLogo().dataUrl);
  [cardOverlay, cardOverlayBack].forEach((o) => o && o.classList.toggle("panning", on));
  [canvas, canvasBack].forEach((c) => c && c.classList.toggle("shift-grab", movable));
}
window.addEventListener("keydown", syncOverlayPanning);
window.addEventListener("keyup", syncOverlayPanning);
window.addEventListener("blur", () => {
  [cardOverlay, cardOverlayBack].forEach((o) => o && o.classList.remove("panning"));
  [canvas, canvasBack].forEach((c) => c && c.classList.remove("shift-grab"));
});

/* ---------------- Image pool (content-addressed) ----------------
   Uploaded backgrounds are large. Without pooling, "different background per card"
   stores a full copy of the image on every card AND rewrites them all on each
   autosave. Instead every image is stored ONCE under "img:<hash>" and the deck /
   shared / saved decks keep only a small reference, so saves stay tiny and fast
   and an image reused across cards (mosaic) costs a single copy. The in-memory
   model still uses inline dataUrls (render is unchanged); pooling happens only at
   the IndexedDB read/write boundary. */
const imgCache = new Map(); // "img:<hash>" -> dataUrl
async function poolPut(dataUrl) {
  const key = imgKey(dataUrl);
  if (!imgCache.has(key)) {
    imgCache.set(key, dataUrl);
    try { await idbSet(key, dataUrl); } catch (e) {}
  }
  return key;
}
async function poolGet(key) {
  if (imgCache.has(key)) return imgCache.get(key);
  let v = null;
  try { v = await idbGet(key); } catch (e) {}
  if (v) imgCache.set(key, v);
  return v;
}
// Deep-walk a cloned structure, swapping inline {dataUrl:"data:..."} ↔ {img:"<key>"}.
async function dehydrateImages(obj) {
  if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) obj[i] = await dehydrateImages(obj[i]); return obj; }
  if (obj && typeof obj === "object") {
    if (typeof obj.dataUrl === "string" && obj.dataUrl.startsWith("data:")) {
      obj.img = await poolPut(obj.dataUrl); delete obj.dataUrl; return obj;
    }
    for (const k of Object.keys(obj)) obj[k] = await dehydrateImages(obj[k]);
    return obj;
  }
  return obj;
}
async function rehydrateImages(obj) {
  if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) obj[i] = await rehydrateImages(obj[i]); return obj; }
  if (obj && typeof obj === "object") {
    if (typeof obj.img === "string") { obj.dataUrl = await poolGet(obj.img); delete obj.img; return obj; }
    for (const k of Object.keys(obj)) obj[k] = await rehydrateImages(obj[k]);
    return obj;
  }
  return obj;
}
// Portable lossless pooling for the Export FILE: swap inline {dataUrl:"data:..."}
// for {img:"<key>"} and collect the ORIGINAL full-res images (no re-encode) into an
// embedded dict, so an image reused across cards (e.g. a mosaic source) is stored
// ONCE — full quality, but the file isn't bloated by N duplicate copies.
function dehydrateToDict(obj, dict) {
  if (Array.isArray(obj)) return obj.map((v) => dehydrateToDict(v, dict));
  if (obj && typeof obj === "object") {
    if (typeof obj.dataUrl === "string" && obj.dataUrl.startsWith("data:")) {
      const key = imgKey(obj.dataUrl); dict[key] = obj.dataUrl;
      const o = Object.assign({}, obj); o.img = key; delete o.dataUrl; return o;
    }
    const o = {}; for (const k of Object.keys(obj)) o[k] = dehydrateToDict(obj[k], dict); return o;
  }
  return obj;
}
function rehydrateFromDict(obj, dict) {
  if (Array.isArray(obj)) return obj.map((v) => rehydrateFromDict(v, dict));
  if (obj && typeof obj === "object") {
    if (typeof obj.img === "string" && dict && dict[obj.img]) {
      const o = Object.assign({}, obj); o.dataUrl = dict[obj.img]; delete o.img; return o;
    }
    const o = {}; for (const k of Object.keys(obj)) o[k] = rehydrateFromDict(obj[k], dict); return o;
  }
  return obj;
}
/* ---------------- kind naming migration ----------------
   The kind strings were historically inverted: the landscape "Protocol card" was
   stored as kind:"compile" and the vertical value "Compile card" as kind:"protocol".
   In memory we now use coherent names — value card = "compile", landscape = "protocol".
   Persisted data and existing share links stay in the LEGACY format, so we flip kinds
   at every I/O boundary. The flip is symmetric (its own inverse): the SAME swap maps
   legacy→coherent on read and coherent→legacy on write. deckShared's per-kind
   {protocol,compile} sub-objects are swapped to match. */
function flipKind(k) { return k === "compile" ? "protocol" : k === "protocol" ? "compile" : k; }
function flipStateKind(st) { if (st && typeof st === "object" && typeof st.kind === "string") st.kind = flipKind(st.kind); return st; }
function flipCardsKinds(arr) { if (Array.isArray(arr)) arr.forEach((c) => c && c.state && flipStateKind(c.state)); return arr; }
function flipSharedKeys(sh) { if (sh && typeof sh === "object") { const p = sh.protocol; sh.protocol = sh.compile; sh.compile = p; } return sh; }
function flipKindsForKey(key, val) {
  if (val == null) return val;
  if (key === "current") return flipStateKind(val);
  if (key === "deck") return flipCardsKinds(val);
  if (key === "deckShared") return flipSharedKeys(val);
  if (key === "savedDecks" && Array.isArray(val)) val.forEach((d) => { if (d) { flipCardsKinds(d.cards); flipSharedKeys(d.shared); } });
  return val;
}
// Save/load a value with its images pooled out (never touches the live in-memory copy).
async function idbSetPooled(key, val) {
  const clone = flipKindsForKey(key, JSON.parse(JSON.stringify(val))); // store legacy kind format
  return idbSet(key, await dehydrateImages(clone));
}
async function idbGetPooled(key) {
  const v = await idbGet(key);
  if (v == null) return v;
  return flipKindsForKey(key, await rehydrateImages(v)); // legacy → coherent kinds
}

/* ---------------- Persistence ---------------- */
function saveCurrent() {
  idbSetPooled("current", state).catch((e) => console.warn("saveCurrent failed", e));
}
async function loadCurrent() {
  try {
    let s = await idbGetPooled("current");
    if (!s) { // one-time migration from the old localStorage key
      const raw = localStorage.getItem(STORE_CURRENT);
      if (raw) { s = JSON.parse(raw); localStorage.removeItem(STORE_CURRENT); }
    }
    if (s) {
      setState(normalizeState(s));
    }
  } catch (e) {}
}

// Merge a loaded/imported card state with current defaults (back-compat).
function normalizeState(s) {
  const st = Object.assign(defaultState(), s);
  st.bg = hydrateBg(s.bg);
  st.logo = hydrateLogo(s.logo);
  st.kind = s.kind === "protocol" ? "protocol" : "compile"; // landscape="protocol", value="compile" (default)
  st.compile = Object.assign(defaultCompile(), s.compile || {});
  st.bgOwn = hydrateBg(s.bgOwn);
  if (s.bgOwnBack) st.bgOwnBack = hydrateBg(s.bgOwnBack); // separate back-face bg (compile cards, per-card mode)
  return st;
}

let deck = [];
async function loadDeck() {
  try {
    deck = await idbGetPooled("deck");
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
  idbSetPooled("deck", deck).catch((e) => {
    console.error("saveDeck failed", e);
    notify("Could not save the deck. Your browser storage may be full or blocked.");
  });
}

/* ---------------- Shared per-kind logo + background ---------------- */
function saveShared() { idbSetPooled("deckShared", deckShared).catch((e) => console.warn("saveShared failed", e)); }
function resetShared() {
  deckShared = { title: "", code: "", perCardBg: false, glitchPreset: 1, split: null, protocol: { bg: defaultBg(), logo: defaultLogo() }, compile: { bg: defaultBg(), logo: defaultLogo() } };
}
// First non-empty title across a set of deck cards (title is deck-wide).
function titleFromCards(cards) {
  const c = (cards || []).find((x) => x && x.state && (x.state.title || "").trim());
  return c ? c.state.title : "";
}
// Normalise an arbitrary {bg, logo} into a complete shared entry.
function normalizeShared(src) {
  const s = src || {};
  return { bg: hydrateBg(s.bg), logo: hydrateLogo(s.logo) };
}
function setDeckShared(src) {
  resetShared();
  if (src && typeof src.title === "string") deckShared.title = src.title;
  if (src && typeof src.code === "string") deckShared.code = src.code;
  if (src && typeof src.perCardBg === "boolean") deckShared.perCardBg = src.perCardBg;
  if (src && typeof src.glitchPreset === "number") deckShared.glitchPreset = src.glitchPreset;
  else if (src && typeof src.frontGlitch === "boolean") deckShared.glitchPreset = src.frontGlitch ? 1 : 0; // back-compat
  if (src && src.split) deckShared.split = src.split;
  if (src && src.protocol) deckShared.protocol = normalizeShared(src.protocol);
  if (src && src.compile) deckShared.compile = normalizeShared(src.compile);
}
async function loadShared() {
  let sh = null;
  try { sh = await idbGetPooled("deckShared"); } catch (e) {}
  if (sh) { setDeckShared(sh); return; }
  // Migration: derive from existing per-card title/bg/logo (first card of each
  // kind), falling back to the saved "current" editor card, then defaults.
  resetShared();
  let cur = null;
  try { cur = await idbGetPooled("current"); } catch (e) {}
  deckShared.title = titleFromCards(deck) || (cur && cur.title) || "";
  ["protocol", "compile"].forEach((kind) => {
    const card = deck.find((c) => c && c.state && c.state.kind === kind);
    const src = (card && card.state) || (cur && (cur.kind || "compile") === kind ? cur : null);
    if (src) deckShared[kind] = normalizeShared(src);
  });
  saveShared();
}
// Build shared props from a set of deck cards (first card of each kind) — used
// when loading older saved/imported decks that have no shared block.
function deriveSharedFromCards(cards) {
  resetShared();
  deckShared.title = titleFromCards(cards);
  ["protocol", "compile"].forEach((kind) => {
    const card = (cards || []).find((c) => c && c.state && c.state.kind === kind);
    if (card && card.state) deckShared[kind] = normalizeShared(card.state);
  });
}
// Re-render the cached thumbnails for the deck cards whose shared props changed
// (kind=null → all cards, e.g. the deck-wide title) and refresh the list.
async function refreshDeckThumbs(kind) {
  const cards = deck.filter((c) => c && c.state && (!kind || c.state.kind === kind));
  if (!cards.length) return;
  cards.forEach((c) => { c._loading = true; });
  renderDeck(); // show a spinner on each card being regenerated
  for (const c of cards) {
    c.thumb = await makeThumb(c.state);
    c._loading = false;
    const tile = document.querySelector('.deck-card[data-id="' + c.id + '"] .dc-open');
    if (tile) { tile.classList.remove("loading"); const img = tile.querySelector("img"); if (img) img.src = c.thumb; }
  }
  saveDeck(); markDirty();
}
let sharedPropTimer = null;
function propagateShared() {
  clearTimeout(sharedPropTimer);
  sharedPropTimer = setTimeout(() => { saveShared(); refreshDeckThumbs(state.kind); }, 250);
}
// In per-card mode a background change touches only this card; otherwise it updates
// the deck-wide shared bg for every card of this kind.
function propagateBg() {
  if (deckShared.perCardBg) { onCardEdited(); return; }
  // Default mode: one deck-wide background. Mirror the current bg (incl. any
  // zoom/pan) onto both kinds so the Protocol card stays in sync, then refresh
  // EVERY thumbnail (both kinds), not just the current one.
  const bg = JSON.parse(JSON.stringify(sharedFor(state.kind).bg));
  deckShared.protocol.bg = bg;
  deckShared.compile.bg = JSON.parse(JSON.stringify(bg));
  clearTimeout(sharedPropTimer);
  sharedPropTimer = setTimeout(() => { saveShared(); refreshDeckThumbs(null); }, 250);
}
// The protocol title is deck-wide → refresh every card's thumbnail.
let titlePropTimer = null;
function propagateTitle() {
  clearTimeout(titlePropTimer);
  titlePropTimer = setTimeout(() => { saveShared(); refreshDeckThumbs(null); }, 350);
}

/* ---------------- Form ↔ state sync ---------------- */
const el = (id) => document.getElementById(id);

function syncFormToState() {
  setEditTitle(el("inTitle").value);
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
  el("inTitle").value = editTitle();
  el("inTitleBack").value = editTitle();
  el("inValue").value = state.value;
  setPanelHtml("inTop", state.panelTop);
  setPanelHtml("inMid", state.panelMid);
  setPanelHtml("inBot", state.panelBot);
  const c = state.compile || {};
  el("inCTop").value = c.top || "";
  el("inCSub").value = c.subtitle || "";
  el("inCBot").value = c.bottom || "";
  el("inCBack").value = c.back || "";
  el("inCode").value = deckShared.code || "";
  el("inCustomBg").checked = !!deckShared.perCardBg;
  refreshBgModeLabel();
  el("inGlitchPreset").value = String(deckShared.glitchPreset || 0);
  el("inGlitchPreset").dispatchEvent(new Event("cselect-sync")); // refresh the custom dropdown label
  refreshLogoUI();
  refreshBgSelection();
  syncBgAdjust();
  applyKind();
  refreshBgSideToggle();
}

// Show/hide the two card types' fields and update the type/side toggles.
// kind "protocol" = the landscape "Protocol card"; "compile" = the vertical "Compile card".
function applyKind() {
  const isLandscape = isLandscapeKind(state.kind);
  document.querySelectorAll(".protocol-only").forEach((e) => { e.hidden = isLandscape; });  // .protocol-only = value-card fields
  document.querySelectorAll(".compile-only").forEach((e) => { e.hidden = !isLandscape; });  // .compile-only = landscape fields
  el("btnKindProtocol").classList.toggle("active", isLandscape);   // "Protocol card" button
  el("btnKindCompile").classList.toggle("active", !isLandscape);   // "Compile card" button
}

function refreshLogoUI() {
  const has = !!editLogo().dataUrl;
  el("btnClearLogo").hidden = !has;
  const prev = el("logoPreview");
  prev.hidden = !has;
  if (has) prev.src = editLogo().dataUrl;
  el("logoAdjust").hidden = !has;
  const pct = Math.round((editLogo().zoom || 1) * 100);
  el("inLogoZoom").value = pct;
  el("logoZoomVal").textContent = pct + "%";
}

function refreshBgSelection() {
  document.querySelectorAll(".bg-thumb").forEach((t) => {
    const isPreset = editBg().type === "preset" && t.dataset.name === editBg().name;
    const isCustom = editBg().type === "custom" && !!t.dataset.url && t.dataset.url === editBg().dataUrl;
    t.classList.toggle("active", Boolean(isPreset || isCustom)); // explicit boolean: undefined would TOGGLE
  });
}

/* ---------------- Background pan & zoom ---------------- */
function bgTransform() {
  if (!editBg().transform) editBg().transform = defaultTransform();
  return editBg().transform;
}

// Show the adjust controls only when a background is set, and reflect the zoom.
function syncBgAdjust() {
  const on = editBg().type !== "none";
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
  return isLandscapeKind(state.kind) ? COMPILE_FRONT.hex : ZONES.hex;
}
function pointOn(cnv, e) {
  const r = cnv.getBoundingClientRect(), f = scaleFactor(cnv);
  return { x: (e.clientX - r.left) * f, y: (e.clientY - r.top) * f };
}
function overLogoOn(cnv, e) {
  if (!editLogo().dataUrl) return false;
  const h = hexForCanvas(cnv), p = pointOn(cnv, e);
  return p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h;
}
function clampLogoZoom(z) { return Math.max(0.5, Math.min(3, z)); }

// Interacting with a canvas's background selects that face for editing (compile
// card, per-card mode): the front canvas → front bg, the back canvas → back bg.
function selectBgFaceForCanvas(cnv) {
  if (!deckShared.perCardBg || state.kind !== "protocol") return;
  const side = cnv === canvasBack ? "back" : "front";
  if (bgEditSide === side) return;
  bgEditSide = side;
  refreshBgSideToggle();
  refreshBgSelection();
  syncBgAdjust();
}

// Hold Shift + drag to pan (logo if hovered, else background); Shift + scroll to
// zoom the same target. Wired on both the front and back canvases.
let dragging = false, dragTarget = null, dragCanvas = null, lastPX = 0, lastPY = 0;
function attachPanZoom(cnv) {
  if (!cnv) return;
  cnv.addEventListener("pointerdown", (e) => {
    if (!panZoomKey(e)) return;
    const onLogo = overLogoOn(cnv, e);
    if (!onLogo) selectBgFaceForCanvas(cnv); // dragging the back canvas edits the back bg
    if (!onLogo && editBg().type === "none") return; // nothing to drag
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
      editLogo().offsetX = (editLogo().offsetX || 0) + dx;
      editLogo().offsetY = (editLogo().offsetY || 0) + dy;
    } else {
      const t = bgTransform();
      t.offsetX += dx; t.offsetY += dy;
    }
    lastPX = e.clientX; lastPY = e.clientY;
    scheduleRender(false);
  });
  const end = () => {
    if (!dragging || dragCanvas !== cnv) return;
    const wasLogo = dragTarget === "logo";
    dragging = false; dragTarget = null; dragCanvas = null;
    cnv.classList.remove("grabbing");
    saveCurrent();
    if (wasLogo) propagateShared(); else propagateBg(); // logo is deck-wide; bg may be per-card
  };
  cnv.addEventListener("pointerup", end);
  cnv.addEventListener("pointercancel", end);
  cnv.addEventListener("wheel", (e) => {
    if (!panZoomKey(e)) return;
    const onLogo = overLogoOn(cnv, e);
    if (!onLogo) selectBgFaceForCanvas(cnv);
    if (!onLogo && editBg().type === "none") return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    if (onLogo) {
      editLogo().zoom = clampLogoZoom((editLogo().zoom || 1) * factor);
      refreshLogoUI();
    } else {
      const p = pointOn(cnv, e);
      zoomAtOn(cnv, p.x, p.y, factor);
      syncBgAdjust();
    }
    scheduleRender(false);
    debouncedSave();
    if (onLogo) propagateShared(); else propagateBg();
  }, { passive: false });
}
attachPanZoom(canvas);
attachPanZoom(canvasBack);

/* ---------------- Bindings ---------------- */
["inValue", "inCTop", "inCSub", "inCBot", "inCBack"].forEach((id) => {
  el(id).addEventListener("input", () => { syncFormToState(); layoutOverlay(); debouncedRender(); onCardEdited(); });
});
// The protocol title / compile name appears on both faces — keep the two fields synced.
function onTitleInput(srcId) {
  const v = el(srcId).value;
  if (el("inTitle").value !== v) el("inTitle").value = v;
  if (el("inTitleBack").value !== v) el("inTitleBack").value = v;
  syncFormToState(); layoutOverlay(); debouncedRender();
  propagateTitle(); // title is deck-wide → update every card
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
    onCardEdited();
  });
  e.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); document.execCommand("insertLineBreak"); }
  });
});
// Logo zoom
el("inLogoZoom").addEventListener("input", () => {
  editLogo().zoom = Math.max(0.5, Math.min(3, +el("inLogoZoom").value / 100));
  el("logoZoomVal").textContent = Math.round(editLogo().zoom * 100) + "%";
  scheduleRender(false);
  debouncedSave();
  propagateShared();
});
el("btnLogoReset").addEventListener("click", () => {
  editLogo().zoom = 1;
  editLogo().offsetX = 0;
  editLogo().offsetY = 0;
  refreshLogoUI();
  scheduleRender();
  propagateShared();
});

// Card type toggle (Protocol / Compile)
function setKind(kind) {
  state.kind = kind;
  // In split mode, switching a card TO the Protocol card must not inherit a value
  // cell's zoomed crop — show the full image at 100% (both faces). (Switching back
  // to a value card re-takes its cell via assignSplitCells.)
  if (kind === "protocol" && deckShared.perCardBg && deckShared.split && deckShared.split.dataUrl) {
    state.bgOwn = { type: "custom", name: null, dataUrl: deckShared.split.dataUrl, transform: defaultTransform() };
    state.bgOwnBack = null;
  }
  applyKind();
  refreshLogoUI();      // logo + background are per-kind shared, reflect the new kind
  refreshBgSelection();
  syncBgAdjust();
  refreshBgSideToggle();
  scheduleRender();
  onCardEdited();
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
      editLogo().dataUrl = await normalizeImage(reader.result, 320, 320, "image/png");
      refreshLogoUI();
      scheduleRender();
      propagateShared();
    } catch (err) { notify("Could not read that image file."); }
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});
el("btnClearLogo").addEventListener("click", () => {
  editLogo().dataUrl = null;
  refreshLogoUI();
  scheduleRender();
  propagateShared();
});
// Click the logo hexagon on the card to upload/replace the logo.
el("logoHotspot").addEventListener("click", () => el("inLogo").click());
el("logoHotspotBack").addEventListener("click", () => el("inLogo").click());

// Background upload — recompress to JPEG sized for the card.
el("inBg").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    // Store the image uncompressed (full quality). The pool keeps a single copy and
    // the card downscales at draw time, so zoom / mosaic stays sharp.
    const dataUrl = reader.result;
    if (!customBgs.includes(dataUrl)) customBgs.unshift(dataUrl);
    customBgs = customBgs.slice(0, 12); // keep the picker tidy
    saveCustomBgs();
    buildBgGrid();
    selectBg({ type: "custom", dataUrl }); // set as the single shared bg (kept if the split is cancelled)
    openMosaic({ src: dataUrl });           // offer to split it across the cards
  };
  reader.onerror = () => notify("Could not read that image file.");
  reader.readAsDataURL(file);
  e.target.value = "";
});
el("btnNoBg").addEventListener("click", () => {
  setEditBg({ type: "none", name: null, dataUrl: null, transform: defaultTransform() });
  refreshBgSelection();
  syncBgAdjust();
  scheduleRender();
  propagateBg();
});

// Zoom slider (zooms around the card centre)
el("inBgZoom").addEventListener("input", () => {
  bgTransform().scale = clampScale(+el("inBgZoom").value / 100);
  el("bgZoomVal").textContent = Math.round(bgTransform().scale * 100) + "%";
  scheduleRender(false);
  debouncedSave();
  propagateBg();
});
// Reset pan & zoom
el("btnBgReset").addEventListener("click", () => {
  editBg().transform = defaultTransform();
  syncBgAdjust();
  scheduleRender();
  propagateBg();
});

// Deck-wide "per-card background" mode toggle. ON → every card gets its own bg,
// seeded from the current shared bg so nothing changes visually until each card is
// edited; OFF → all cards fall back to the single shared background.
el("inCustomBg").addEventListener("change", () => {
  const on = el("inCustomBg").checked;
  deckShared.perCardBg = on;
  if (on) {
    const seed = (s) => {
      if (!s.bgOwn || s.bgOwn.type === "none") s.bgOwn = JSON.parse(JSON.stringify(sharedFor(s.kind).bg));
      // the Protocol card (landscape) gets a separate back-face bg, seeded from its
      // own shared bg so nothing changes until you edit it
      if (s.kind === "protocol" && (!s.bgOwnBack || s.bgOwnBack.type === "none")) s.bgOwnBack = JSON.parse(JSON.stringify(sharedFor("protocol").bg));
    };
    seed(state);
    deck.forEach((c) => seed(c.state));
  } else {
    bgEditSide = "front";
    deckShared.split = null; // turning the mode off also exits split, so it can be re-enabled as plain per-card
  }
  commitCurrentCard();   // persist the editor card under the new mode
  saveShared();
  refreshBgSideToggle();
  refreshBgModeLabel();
  refreshBgSelection();
  syncBgAdjust();
  scheduleRender();
  markDirty();
  refreshDeckThumbs(null); // re-render every thumbnail for the new mode
});

// A mosaic split is really "one image, a different crop per card" (not a separate
// image per card), so relabel the toggle when a split is active to make that clear.
function refreshBgModeLabel() {
  const t = document.querySelector(".switch .switch-text");
  if (!t) return;
  const split = !!(deckShared.split && deckShared.split.dataUrl);
  t.textContent = split ? "Single image · split across cards" : "Different background per card";
}

// Deck-wide set code, edited in-place on the card (vertical "Compile card" only).
el("inCode").addEventListener("input", () => {
  deckShared.code = el("inCode").value;
  debouncedRender();
  propagateTitle(); // deck-wide text → re-render every thumbnail + save shared + mark dirty
});

// Replace a native <select> with a themed custom dropdown (the native option list
// can't be styled). The <select> stays as the state source; we mirror it and fire
// its "change" so existing listeners keep working. Listen for "cselect-sync" to
// reflect external value changes (e.g. syncStateToForm).
function enhanceSelect(sel) {
  sel.classList.add("cselect-native");
  const wrap = document.createElement("div"); wrap.className = "cselect";
  sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(sel);
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "cselect-btn"; btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false");
  const label = document.createElement("span"); label.className = "cselect-label";
  const chev = document.createElement("span"); chev.className = "cselect-chev"; chev.textContent = "▾";
  btn.append(label, chev);
  const menu = document.createElement("ul"); menu.className = "cselect-menu"; menu.setAttribute("role", "listbox");
  wrap.append(btn, menu);
  const isOpen = () => wrap.classList.contains("open");
  const setActive = (li) => { [...menu.children].forEach((x) => x.classList.remove("active")); if (li) li.classList.add("active"); };
  function sync() {
    const o = sel.options[sel.selectedIndex] || sel.options[0];
    label.textContent = o ? o.textContent : "";
    [...menu.children].forEach((li) => li.classList.toggle("is-selected", li.dataset.value === sel.value));
  }
  function build() {
    menu.innerHTML = "";
    [...sel.options].forEach((o) => {
      const li = document.createElement("li"); li.className = "cselect-opt"; li.setAttribute("role", "option");
      li.dataset.value = o.value; li.textContent = o.textContent; menu.appendChild(li);
    });
    sync();
  }
  function open() { wrap.classList.add("open"); btn.setAttribute("aria-expanded", "true"); const sel2 = menu.querySelector(".is-selected") || menu.firstChild; setActive(sel2); if (sel2) sel2.scrollIntoView({ block: "nearest" }); }
  function close() { wrap.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); setActive(null); }
  function choose(li) { if (!li) return; if (sel.value !== li.dataset.value) { sel.value = li.dataset.value; sel.dispatchEvent(new Event("change", { bubbles: true })); } sync(); close(); btn.focus(); }
  btn.addEventListener("click", (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
  menu.addEventListener("click", (e) => { const li = e.target.closest(".cselect-opt"); if (li) choose(li); });
  menu.addEventListener("mousemove", (e) => { const li = e.target.closest(".cselect-opt"); if (li) setActive(li); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });
  btn.addEventListener("keydown", (e) => {
    const items = [...menu.children];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!isOpen()) { open(); return; }
      let i = items.findIndex((x) => x.classList.contains("active"));
      i = e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      setActive(items[i]); items[i].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" || e.key === " ") {
      if (isOpen()) { e.preventDefault(); choose(menu.querySelector(".active")); } else { e.preventDefault(); open(); }
    } else if (e.key === "Escape") { close(); }
  });
  sel.addEventListener("change", sync);
  sel.addEventListener("cselect-sync", sync);
  build();
  sel._cselectRebuild = build;
}

// Deck-wide front glitch preset dropdown (0 = none, 1..10 = preset).
el("inGlitchPreset").innerHTML = '<option value="0">No glitch</option>' +
  GLITCH_PRESETS.map((p, i) => `<option value="${i + 1}">Glitch ${i + 1} · ${p.name}</option>`).join("");
enhanceSelect(el("inGlitchPreset"));
el("inGlitchPreset").addEventListener("change", () => {
  deckShared.glitchPreset = +el("inGlitchPreset").value;
  saveShared();
  scheduleRender();
  markDirty();
  refreshDeckThumbs(null); // re-render every thumbnail with the chosen glitch
});

// Front/Back background selector — only shown for the compile (Protocol) card in
// per-card mode, since that card has two faces that can each have their own bg.
function refreshBgSideToggle() {
  // Front/back can differ only in plain "different bg per card" mode — a single-image
  // split uses the same image on both faces of the Protocol card, so no side toggle.
  const split = !!(deckShared.split && deckShared.split.dataUrl);
  const show = state.kind === "protocol" && deckShared.perCardBg && !split;
  el("bgSideToggle").hidden = !show;
  if (!show) bgEditSide = "front";
  el("btnBgFront").classList.toggle("active", bgEditSide === "front");
  el("btnBgBack").classList.toggle("active", bgEditSide === "back");
}
function setBgEditSide(side) {
  bgEditSide = side === "back" ? "back" : "front";
  refreshBgSideToggle();
  refreshBgSelection(); // reflect the selected face's bg in the picker + zoom
  syncBgAdjust();
}
el("btnBgFront").addEventListener("click", () => setBgEditSide("front"));
el("btnBgBack").addEventListener("click", () => setBgEditSide("back"));

// Background grid: uploaded customs first, then the bundled presets.
let customBgs = [];
function selectBg(bg) {
  setEditBg(Object.assign({ type: "none", name: null, dataUrl: null, transform: defaultTransform() }, bg));
  refreshBgSelection();
  syncBgAdjust();
  scheduleRender();
  propagateBg();
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
        if (editBg().type === "custom" && editBg().dataUrl === url) selectBg({ type: "none" });
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
function saveCustomBgs() {
  (async () => {
    const refs = [];
    for (const u of customBgs) refs.push(typeof u === "string" && u.startsWith("data:") ? await poolPut(u) : u);
    idbSet("customBgs", refs).catch(() => {});
  })();
}

/* ---------------- Mosaic splitter: lay one image across the 6 value cards ----------------
   Upload one image, frame a 3×2 grid over it (drag + zoom), and on accept each cell
   becomes one card's per-card background (cropped to that region, in value order). */
let mosaicT = { s: 1, tx: 0, ty: 0 }; // image transform within the stage
let mosaicFit = 1;                    // the "cover the frame" scale (slider = 100%)
let mosaicSrc = "";                   // dataUrl of the loaded image

// The 6 value cards (kind "protocol"), in value order.
function valueCards() {
  return deck.filter((c) => c && c.state && c.state.kind === "compile")
    .sort((a, b) => (parseFloat(a.state.value) || 0) - (parseFloat(b.state.value) || 0));
}
function mosaicFrameRect() { const f = el("mosaicFrame"); return { x: f.offsetLeft, y: f.offsetTop, w: f.offsetWidth, h: f.offsetHeight }; }
function layoutMosaicFrame() {
  const stage = el("mosaicStage"); const sw = stage.clientWidth, sh = stage.clientHeight;
  let fw = sw * 0.86, fh = fw / MOSAIC_ASPECT;
  if (fh > sh * 0.86) { fh = sh * 0.86; fw = fh * MOSAIC_ASPECT; }
  const f = el("mosaicFrame");
  f.style.width = fw + "px"; f.style.height = fh + "px";
  f.style.left = (sw - fw) / 2 + "px"; f.style.top = (sh - fh) / 2 + "px";
}
function applyMosaicTransform() {
  el("mosaicImg").style.transform = `translate(${mosaicT.tx}px, ${mosaicT.ty}px) scale(${mosaicT.s})`;
}
function fitMosaic() {
  const img = el("mosaicImg"); if (!img.naturalWidth) return;
  const f = mosaicFrameRect();
  mosaicFit = Math.max(f.w / img.naturalWidth, f.h / img.naturalHeight);
  mosaicT.s = mosaicFit;
  mosaicT.tx = f.x + f.w / 2 - img.naturalWidth * mosaicFit / 2;
  mosaicT.ty = f.y + f.h / 2 - img.naturalHeight * mosaicFit / 2;
  el("mosaicZoom").value = 100;
  applyMosaicTransform();
}
function setMosaicZoom(pct) {
  const img = el("mosaicImg"); if (!img.naturalWidth) return;
  const f = mosaicFrameRect(); const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const newS = mosaicFit * pct / 100;
  const ix = (cx - mosaicT.tx) / mosaicT.s, iy = (cy - mosaicT.ty) / mosaicT.s; // image point under frame centre
  mosaicT.s = newS; mosaicT.tx = cx - ix * newS; mosaicT.ty = cy - iy * newS;
  applyMosaicTransform();
}
// Restore the modal view so the grid frames a saved image-pixel region.
function viewMosaicRegion(region) {
  const img = el("mosaicImg"); if (!img.naturalWidth || !region) return;
  const f = mosaicFrameRect();
  mosaicFit = Math.max(f.w / img.naturalWidth, f.h / img.naturalHeight);
  mosaicT.s = f.w / region.w;
  mosaicT.tx = f.x - region.ix0 * mosaicT.s;
  mosaicT.ty = f.y - region.iy0 * mosaicT.s;
  el("mosaicZoom").value = Math.round(Math.max(10, Math.min(400, mosaicT.s / mosaicFit * 100)));
  applyMosaicTransform();
}
function loadMosaicImage(dataUrl, region) {
  mosaicSrc = dataUrl;
  const img = el("mosaicImg");
  img.onload = () => {
    img.style.width = img.naturalWidth + "px";
    img.hidden = false; el("mosaicFrame").hidden = false; el("mosaicEmpty").hidden = true;
    el("mosaicZoom").disabled = false; el("mosaicReset").disabled = false; el("mosaicAccept").disabled = false;
    layoutMosaicFrame();
    if (region) viewMosaicRegion(region); else fitMosaic();
  };
  img.src = dataUrl;
}
// A preset background as a data URL, so it can be split like an uploaded image.
async function presetDataUrl(name) {
  try {
    const img = await getPresetImage(name);
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/jpeg", 0.95);
  } catch (e) { return null; }
}
function mosaicEmptyState() {
  mosaicSrc = ""; el("mosaicImg").hidden = true; el("mosaicFrame").hidden = true; el("mosaicEmpty").hidden = false;
  el("mosaicZoom").disabled = true; el("mosaicReset").disabled = true; el("mosaicAccept").disabled = true;
}
function openMosaic(opts) {
  opts = opts || {};
  el("mosaicOverlay").hidden = false;
  const bg = editBg() || {};
  const splitSrc = (deckShared.split && deckShared.split.dataUrl) || null;
  if (opts.src) { loadMosaicImage(opts.src); return; }                                  // a freshly uploaded image
  // A newly-selected background wins over any saved split, so you can re-split with a
  // different image (this is why an existing deck's old split used to keep showing):
  if (bg.type === "preset" && bg.name) {                                                // split a selected default/preset image
    mosaicEmptyState();
    presetDataUrl(bg.name).then((u) => { if (u && !el("mosaicOverlay").hidden) loadMosaicImage(u); });
    return;
  }
  if (bg.type === "custom" && bg.dataUrl && bg.dataUrl !== splitSrc) { loadMosaicImage(bg.dataUrl); return; } // split a different custom bg
  if (splitSrc) { loadMosaicImage(splitSrc, deckShared.split); return; }                // else edit the saved split
  if (bg.type === "custom" && bg.dataUrl) { loadMosaicImage(bg.dataUrl); return; }      // current bg is the split source → split it
  mosaicEmptyState();                                                                   // nothing to split yet — upload inside the modal
}
function closeMosaic() { el("mosaicOverlay").hidden = true; }
// Background for one mosaic cell at grid position `pos` (0=top-left … 5=bottom-right), from the saved split.
function splitCellBg(pos) {
  const sp = deckShared.split;
  if (!sp || !sp.dataUrl || sp.iw == null || pos < 0 || pos > 5) return null;
  const cw = sp.w / 3, ch = sp.h / 2, c = pos % 3, r = Math.floor(pos / 3);
  return { type: "custom", name: null, dataUrl: sp.dataUrl,
           transform: cellTransform(sp.iw, sp.ih, sp.ix0 + c * cw, sp.iy0 + r * ch, cw, ch) };
}
// Split mode: each value card shows the cell for its POSITION (1st value card →
// top-left … 6th → bottom-right). Idempotent — only touches a card whose cell
// changed, refreshing that card's thumbnail (and the live preview if it's the one
// being edited). Never creates cards; a card takes its cell as it joins the list.
function assignSplitCells() {
  if (!deckShared.split || !deckShared.split.dataUrl) return;
  valueCards().forEach((c, i) => {
    const bg = splitCellBg(i);
    if (!bg || sameBg(c.state.bgOwn, bg)) return;
    c.state.bgOwn = bg;
    makeThumb(c.state).then((t) => { c.thumb = t; const img = document.querySelector('.deck-card[data-id="' + c.id + '"] .dc-open img'); if (img) img.src = t; });
    if (c.id === editingId) { state.bgOwn = JSON.parse(JSON.stringify(bg)); scheduleRender(); }
  });
}
function applyMosaic() {
  const img = el("mosaicImg"); const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !mosaicSrc) return;
  const f = mosaicFrameRect();
  const ix0 = (f.x - mosaicT.tx) / mosaicT.s, iy0 = (f.y - mosaicT.ty) / mosaicT.s;
  const gw = f.w / mosaicT.s, gh = f.h / mosaicT.s;
  deckShared.perCardBg = true;
  // Save the split as a TEMPLATE (incl. the source size) instead of creating 6 cards.
  deckShared.split = { dataUrl: mosaicSrc, ix0, iy0, w: gw, h: gh, iw, ih };
  assignSplitCells(); // existing value cards take their cell; new ones take theirs as you make them
  // The landscape Protocol card isn't part of the vertical grid, but it ALSO adopts
  // the single image (full, cover-fit) — overriding any previous bg — and uses the
  // SAME image on both faces (back mirrors front, no separate bgOwnBack).
  deck.forEach((c) => {
    if (!c.state || c.state.kind !== "protocol") return; const s = c.state;
    s.bgOwn = { type: "custom", name: null, dataUrl: mosaicSrc, transform: defaultTransform() };
    s.bgOwnBack = null;
  });
  if (!customBgs.includes(mosaicSrc)) { customBgs.unshift(mosaicSrc); customBgs = customBgs.slice(0, 12); saveCustomBgs(); buildBgGrid(); }
  saveShared(); saveDeck(); markDirty();
  closeMosaic();
  el("inCustomBg").checked = true;
  refreshBgModeLabel();
  // reload the edited card so it picks up its cell (if it's a value card); don't create one
  if (editingId && deck.some((d) => d.id === editingId)) { const card = deck.find((d) => d.id === editingId); setState(normalizeState(JSON.parse(JSON.stringify(card.state)))); syncStateToForm(); scheduleRender(); }
  renderDeck();
  refreshDeckThumbs(null);
}

el("btnMosaic").addEventListener("click", () => openMosaic());
el("mosaicCancel").addEventListener("click", closeMosaic);
el("mosaicAccept").addEventListener("click", applyMosaic);
el("mosaicReset").addEventListener("click", fitMosaic);
el("mosaicZoom").addEventListener("input", () => setMosaicZoom(+el("mosaicZoom").value));
el("mosaicOverlay").addEventListener("click", (e) => { if (e.target === el("mosaicOverlay")) closeMosaic(); });
document.addEventListener("keydown", (e) => { if (!el("mosaicOverlay").hidden && e.key === "Escape") closeMosaic(); });
el("inMosaicImg").addEventListener("change", (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadMosaicImage(reader.result); // full quality, no recompression
  reader.onerror = () => notify("Could not read that image file.");
  reader.readAsDataURL(file); e.target.value = "";
});
(function () { // drag to pan + scroll to zoom inside the stage
  const stage = el("mosaicStage"); let dragging = false, lx = 0, ly = 0;
  stage.addEventListener("pointerdown", (e) => { if (el("mosaicImg").hidden) return; e.preventDefault(); dragging = true; lx = e.clientX; ly = e.clientY; stage.classList.add("grabbing"); stage.setPointerCapture(e.pointerId); });
  stage.addEventListener("dragstart", (e) => e.preventDefault()); // belt & suspenders: never start a native image drag
  stage.addEventListener("pointermove", (e) => { if (!dragging) return; mosaicT.tx += e.clientX - lx; mosaicT.ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; applyMosaicTransform(); });
  const end = () => { dragging = false; stage.classList.remove("grabbing"); };
  stage.addEventListener("pointerup", end); stage.addEventListener("pointercancel", end);
  stage.addEventListener("wheel", (e) => {
    if (el("mosaicImg").hidden) return; e.preventDefault();
    const z = el("mosaicZoom"); z.value = Math.max(10, Math.min(400, (+z.value) * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    setMosaicZoom(+z.value);
  }, { passive: false });
})();

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

// The faces a card exports: the landscape Protocol card has two (front + back);
// a vertical value card has one.
function facesOf(state) { return isLandscapeKind(state.kind) ? ["front", "back"] : ["front"]; }

// Render one face of a card to a print-size (poker) PNG canvas at the export dpi.
async function renderCardCanvas(state, side) {
  const off = document.createElement("canvas");
  await renderKind(state, off, { side, hq: true, scale: exportScale });
  return toPoker(off, exportScale);
}

// Download every face of a card. `base` is the filename stem; a two-faced card
// gets _front/_back suffixes, a single-faced card keeps the plain name. Multi-file
// downloads are paced so the browser doesn't drop them.
async function downloadCardFaces(state, base) {
  const faces = facesOf(state);
  for (let i = 0; i < faces.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 350));
    const side = faces[i];
    const suffix = faces.length > 1 ? "_" + side : "";
    downloadCanvas(await renderCardCanvas(state, side), safeName(base) + suffix + ".png");
  }
}

/* ---------------- Deck ---------------- */
let idCounter = 0;
function newId() {
  idCounter++;
  return "c" + Date.now().toString(36) + "_" + idCounter;
}

async function makeThumb(st) {
  const off = document.createElement("canvas");
  await renderKind(st, off); // landscape (protocol) or vertical (compile), sized by the renderer
  const tw = 240;
  const t = document.createElement("canvas");
  t.width = tw;
  t.height = Math.round(tw * off.height / off.width);
  t.getContext("2d").drawImage(off, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.78);
}

// A fresh, empty per-card snapshot (shared title/bg/logo are kept deck-wide).
function blankCardState() {
  return { value: "", panelTop: "", panelMid: "", panelBot: "", kind: "compile", compile: defaultCompile() };
}

// The card being edited is always a real entry in the deck, so editor changes have
// to flow back into it. Commit the current form into deck[editingId] (no "Add to
// deck" step anymore) and refresh that card's thumbnail.
function commitCurrentCard() {
  const id = editingId;
  if (!id) return;
  clearTimeout(cardEditTimer);
  const idx = deck.findIndex((d) => d.id === id);
  if (idx < 0) return;
  syncFormToState();
  deck[idx].state = cardSnapshot(state);
  saveDeck();
  makeThumb(deck[idx].state).then((t) => {
    const i = deck.findIndex((d) => d.id === id);
    if (i < 0) return;
    deck[i].thumb = t;
    const img = document.querySelector(`.deck-card[data-id="${id}"] .dc-open img`);
    if (img) img.src = t;
  });
}

// Per-card edit (value / panels / kind): mark pending and, debounced, commit into
// the deck card + refresh its thumbnail in place.
let cardEditTimer = null;
function onCardEdited() {
  if (!editingId) return;
  markDirty();
  const id = editingId;
  clearTimeout(cardEditTimer);
  cardEditTimer = setTimeout(async () => {
    const idx = deck.findIndex((d) => d.id === id);
    if (idx < 0) return;
    syncFormToState();
    deck[idx].state = cardSnapshot(state);
    deck[idx].thumb = await makeThumb(deck[idx].state);
    saveDeck();
    // Split mode: a changed value can move the card to a new position → re-sort and
    // let each card re-take the cell that matches its (new) position.
    if (deckShared.split && deckShared.split.dataUrl && deck[idx].state.kind === "compile") { renderDeck(); return; }
    const img = document.querySelector(`.deck-card[data-id="${id}"] .dc-open img`);
    if (img) img.src = deck[idx].thumb;
  }, 300);
}

// "＋ New card" tile: add a fresh blank card to the deck and start editing it.
async function addNewCard() {
  commitCurrentCard();
  const snap = blankCardState();
  const id = newId();
  deck.push({ id, state: snap, thumb: await makeThumb(snap), _new: true }); // pin to end until saved
  saveDeck();
  markDirty();
  setState(normalizeState(JSON.parse(JSON.stringify(snap))));
  compileSide = "front";
  setEditing(id);
  syncStateToForm();
  renderDeck();
  scheduleRender();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Save the current card's content as a NEW card (a copy/variant), then keep editing
// that new card. The change stays pending until "Save changes".
el("btnAddAsNew").addEventListener("click", async () => {
  commitCurrentCard();
  syncFormToState();
  const snapshot = cardSnapshot(state);
  const thumb = await makeThumb(snapshot);
  const id = newId();
  deck.push({ id, state: snapshot, thumb, _new: true }); // pin to end until saved
  saveDeck();
  setEditing(id); // continue editing the freshly added card
  renderDeck();
  markDirty();
  const b = el("btnAddAsNew"); b.textContent = "✓ Saved"; clearTimeout(addNewFlash);
  addNewFlash = setTimeout(() => { b.textContent = "Save as new"; }, 1100);
});
let addNewFlash = null;

el("btnCancelEdit").addEventListener("click", async () => {
  revertPendingChanges();          // discard all unsaved changes → back to the last baseline
  setEditing(null);
  renderSavedDecks();
  await editProtocolCard();        // re-render the reverted deck + select a card to edit
  regenMissingThumbs().then(renderDeck); // rebuild any thumbnails the baseline was missing
});

// Show/hide the editor toolbar buttons. Editing is always active (the current card
// is always in the deck), so every "save" affordance keys off pending changes.
//   · Save changes / Save as new / Cancel → only when there are pending changes
function refreshToolbar() {
  el("btnCancelEdit").hidden = !deckDirty;
  el("btnAddAsNew").hidden = !editingId || !deckDirty;
  el("btnSaveChanges").hidden = !deckDirty;
}

// Flag the working deck as having unsaved changes and reflect it in the toolbar.
function markDirty() {
  if (deckDirty) return;
  deckDirty = true;
  refreshToolbar();
  saveDeckMeta();
}

// Remember the current working state as the baseline Cancel reverts to. Called
// whenever we reach a clean/known checkpoint: load, save, new, clear, import.
function captureRevertBaseline() {
  revertSnapshot = {
    deck: JSON.parse(JSON.stringify(deck)),
    deckShared: JSON.parse(JSON.stringify(deckShared)),
    currentDeckId, currentDeckName, dirty: deckDirty,
  };
}

// Discard all pending changes, restoring the last captured baseline.
function revertPendingChanges() {
  if (!revertSnapshot) return;
  deck = JSON.parse(JSON.stringify(revertSnapshot.deck));
  setDeckShared(JSON.parse(JSON.stringify(revertSnapshot.deckShared)));
  currentDeckId = revertSnapshot.currentDeckId;
  currentDeckName = revertSnapshot.currentDeckName;
  el("inDeckName").value = currentDeckName || "";
  deckDirty = revertSnapshot.dirty;
  saveShared(); saveDeck(); saveDeckMeta();
}

function setEditing(id) {
  editingId = id;
  document.querySelectorAll(".deck-card").forEach((c) => {
    c.classList.toggle("editing", !!id && c.dataset.id === id);
  });
  refreshToolbar();
}

// Keep the working deck ordered: Protocol card (landscape) first, then by value
// asc. Freshly-added cards (_new) stay pinned at the end until the deck is saved,
// so a blank card you're composing doesn't jump around by value while you type.
function sortDeck() {
  deck.sort(compareDeckEntries);
}

function renderDeck() {
  sortDeck();
  assignSplitCells(); // split mode: each value card takes the cell for its position
  const list = el("deckList");
  el("deckCount").textContent = deck.length;
  el("deckEmpty").hidden = deck.length > 0;
  list.innerHTML = "";
  deck.forEach((card) => {
    const wrap = document.createElement("div");
    wrap.className = "deck-card";
    wrap.dataset.id = card.id;
    if (card.id === editingId) wrap.classList.add("editing");
    const title = (deckShared.title || "Untitled").trim() || "Untitled";
    const loading = !card.thumb || card._loading;
    wrap.innerHTML = `
      <button class="dc-open${loading ? " loading" : ""}" title="Click to edit this card">
        <img src="${card.thumb || ""}" alt="${title}">
        <span class="dc-spin"><span class="spin"></span></span>
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
  // Trailing "＋ New card" tile — start a fresh blank card from scratch.
  const add = document.createElement("button");
  add.type = "button";
  add.className = "deck-card-new";
  add.title = "New card from scratch";
  add.innerHTML = `<span class="dcn-plus">＋</span><span class="dcn-txt">New card</span>`;
  add.addEventListener("click", addNewCard);
  list.appendChild(add);
}

function editCard(id) {
  const card = deck.find((d) => d.id === id);
  if (!card) return;
  showPreviewLoading(); // spinner while the (possibly heavy) card renders
  commitCurrentCard();  // flush edits of the card we're leaving into the deck
  setState(normalizeState(JSON.parse(JSON.stringify(card.state))));
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
  markDirty();
}

async function dlCard(card) {
  // Protocol (landscape) cards export both faces; value cards, just the one.
  await downloadCardFaces(card.state, deckShared.title || card.state.value || "card");
}

/* ---------------- Modal (confirm / prompt / share) ---------------- */
let modalResolve = null;
function showModal(opts) {
  const o = Object.assign({ title: "", body: "", confirmLabel: "OK", cancelLabel: "Cancel", danger: false, input: false, value: "", readonly: false }, opts);
  el("modalTitle").textContent = o.title;
  if (o.bodyHtml != null) { el("modalBody").innerHTML = o.bodyHtml; el("modalBody").hidden = !o.bodyHtml; }
  else { el("modalBody").textContent = o.body; el("modalBody").hidden = !o.body; }
  const inp = el("modalInput");
  inp.hidden = !o.input;
  if (o.input) { inp.value = o.value; inp.readOnly = !!o.readonly; }
  const conf = el("modalConfirm");
  conf.textContent = o.confirmLabel;
  conf.classList.toggle("btn-danger", !!o.danger);
  conf.classList.toggle("btn-primary", !o.danger);
  el("modalCancel").textContent = o.cancelLabel;
  el("modalCancel").hidden = !!o.okOnly; // notices show a single OK button
  el("modalOverlay").hidden = false;
  if (o.input) setTimeout(() => { inp.focus(); inp.select(); }, 30);
  return new Promise((resolve) => { modalResolve = resolve; });
}
function showConfirm({ title, body, confirmLabel = "Delete", danger = true }) {
  return showModal({ title, body, confirmLabel, danger });
}
// Styled replacement for window.alert: a single-OK notice in the app's modal.
// Fire-and-forget (callers don't await); returns the modal promise if needed.
function notify(message, title = "") {
  return showModal({ title, body: message, confirmLabel: "OK", okOnly: true, danger: false });
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
  try { savedDecks = (await idbGetPooled("savedDecks")) || []; } catch (e) { savedDecks = []; }
  if (!Array.isArray(savedDecks)) savedDecks = [];
  try { const m = await idbGet("currentDeckMeta"); if (m) { currentDeckId = m.id || null; currentDeckName = m.name || ""; deckDirty = !!m.dirty; } } catch (e) {}
}
function saveSavedDecks() { idbSetPooled("savedDecks", savedDecks).catch((e) => console.warn("saveSavedDecks", e)); }
function saveDeckMeta() { idbSet("currentDeckMeta", { id: currentDeckId, name: currentDeckName, dirty: deckDirty }).catch(() => {}); }

// The background used by a deck (first card that has one) for its row thumbnail.
function deckBgSrc(d) {
  const fromBg = (bg) => {
    if (bg && bg.type === "preset" && bg.name) return `card-backgrounds/thumbs/${bg.name}.jpg`;
    if (bg && bg.type === "custom" && bg.dataUrl) return bg.dataUrl;
    return null;
  };
  // New model: background lives in the per-kind shared block.
  if (d.shared) {
    for (const kind of ["compile", "protocol"]) {
      const src = d.shared[kind] && fromBg(d.shared[kind].bg);
      if (src) return src;
    }
  }
  // Per-card backgrounds (perCardBg mode), then the old per-card model.
  const usePer = !!(d.shared && d.shared.perCardBg);
  for (const c of d.cards || []) {
    const st = c.state || {};
    const src = fromBg(usePer ? st.bgOwn : st.bg);
    if (src) return src;
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
  const shared = JSON.parse(JSON.stringify(deckShared));
  let d = savedDecks.find((x) => x.name === name);
  if (d) { d.cards = cards; d.shared = shared; d.updatedAt = Date.now(); currentDeckId = d.id; }
  else { currentDeckId = newId(); savedDecks.push({ id: currentDeckId, name, cards, shared, updatedAt: Date.now() }); }
  saveSavedDecks(); saveDeckMeta(); renderSavedDecks();
}

// Persist the working deck into the "My decks" library, prompting for a name if it
// has none yet. Returns true on success, false if empty or the user cancelled.
async function saveDeckToLibrary() {
  if (!deck.length) { notify("The deck is empty — add some cards first."); return false; }
  let name = el("inDeckName").value.trim();
  if (!name) {
    name = await showModal({ title: "Save deck", body: "Name this deck:", input: true, value: currentDeckName || "My deck", confirmLabel: "Save", danger: false });
    if (name === null) return false;
    name = name.trim() || "Untitled deck";
  }
  name = name.toUpperCase(); // deck names are always stored/shown uppercase
  el("inDeckName").value = name;
  upsertSavedDeck(name);
  return true;
}

// "Save changes" — the single save action. Commits the card being edited into the
// working deck, then saves the whole deck into "My decks" (named, else prompts).
let saveChangesFlash = null;
async function doSaveChanges() {
  if (editingId) {
    syncFormToState();
    const snapshot = cardSnapshot(state);
    const thumb = await makeThumb(snapshot);
    const idx = deck.findIndex((d) => d.id === editingId);
    if (idx >= 0) { deck[idx].state = snapshot; deck[idx].thumb = thumb; }
    saveDeck();
    renderDeck();
  }
  const ok = await saveDeckToLibrary();
  if (!ok) return; // empty or name prompt cancelled → still pending
  deckDirty = false;
  deck.forEach((c) => { delete c._new; }); // saved → cards now sort by value
  saveDeck();
  renderDeck();                            // reposition any formerly-new cards
  saveDeckMeta();
  captureRevertBaseline();
  // Hide the other pending-change affordances right away; briefly flash "✓ Saved"
  // on the save button before it hides too.
  el("btnCancelEdit").hidden = true;
  el("btnAddAsNew").hidden = true;
  const b = el("btnSaveChanges");
  b.hidden = false;
  b.textContent = "✓ Saved";
  clearTimeout(saveChangesFlash);
  saveChangesFlash = setTimeout(() => { b.textContent = "Save changes"; refreshToolbar(); }, 1000);
}

function loadSavedDeck(id) {
  const d = savedDecks.find((x) => x.id === id);
  if (!d) return;
  withDeckLoading(async () => {
    deck = d.cards.map((c) => ({ id: c.id || newId(), state: normalizeState(c.state || c), thumb: c.thumb || "" }));
    if (d.shared) setDeckShared(d.shared); else deriveSharedFromCards(deck);
    saveShared();
    currentDeckId = id; currentDeckName = d.name; el("inDeckName").value = d.name;
    deckDirty = false; // freshly loaded → matches its saved copy
    captureRevertBaseline();
    setEditing(null); saveDeck(); saveDeckMeta();
    renderDeck(); renderSavedDecks();
    await regenMissingThumbs(); renderDeck();
    await editProtocolCard(); // auto-select the protocol card for editing
  });
}

// Auto-select the first card for editing. The deck is sorted (protocol card first
// when there is one), so this picks the protocol card if present, otherwise the
// first card — never leaving nothing selected.
// Select a card to edit. The deck always keeps a current card, so create a blank
// one first if the deck is empty (e.g. a brand-new or just-cleared deck).
async function editProtocolCard() {
  if (!deck.length) {
    // A brand-new / just-cleared deck starts on the Protocol card (landscape) by default.
    const snap = Object.assign(blankCardState(), { kind: "protocol" });
    deck.push({ id: newId(), state: snap, thumb: await makeThumb(snap) });
    saveDeck();
  }
  sortDeck();
  renderDeck();
  editCard(deck[0].id);
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

el("btnSaveChanges").addEventListener("click", doSaveChanges);
el("inDeckName").addEventListener("input", () => {
  currentDeckName = el("inDeckName").value;
  if (deck.length) markDirty(); else saveDeckMeta();
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
// Expand a shared {bg, logo} entry, resolving pooled image indexes to data URLs.
function expandShareImgs(entry, imgs) {
  const e = entry || {};
  const bg = hydrateBg(e.bg);
  if (e.bg && typeof e.bg.img === "number") bg.dataUrl = imgs[e.bg.img];
  const logo = hydrateLogo(e.logo);
  if (e.logo && typeof e.logo.img === "number") logo.dataUrl = imgs[e.logo.img];
  delete bg.img; delete logo.img;
  return { bg, logo };
}

// Build a compact share payload: uploaded images are stored ONCE in a pool and
// referenced by index (the per-kind shared logo/background dedupe naturally), and
// they're re-encoded smaller so the link fits in a URL. Thumbnails/ids are dropped.
async function buildSharePayload(name, totalBudget) {
  const perCard = !!deckShared.perCardBg;
  // 1) Collect the DISTINCT image URLs first (the per-kind shared bg/logo and, in
  //    per-card mode, each card's own bg dedupe naturally — a single mosaic source
  //    is one entry shared by all 6 cells). This lets us split the link's byte
  //    budget across however few images there actually are.
  const order = []; const idx = new Map();
  const want = (url, kind) => { if (!url || idx.has(url)) return; idx.set(url, order.length); order.push({ url, kind }); };
  for (const kind of ["protocol", "compile"]) {
    const sh = deckShared[kind];
    if (sh.bg.type === "custom" && sh.bg.dataUrl) want(sh.bg.dataUrl, "bg");
    if (sh.logo.dataUrl) want(sh.logo.dataUrl, "logo");
  }
  if (perCard) for (const c of deck) {
    const s = c.state;
    if (s.bgOwn && s.bgOwn.type === "custom" && s.bgOwn.dataUrl) want(s.bgOwn.dataUrl, "bg");
    if (s.kind === "protocol" && s.bgOwnBack && s.bgOwnBack.type === "custom" && s.bgOwnBack.dataUrl) want(s.bgOwnBack.dataUrl, "bg");
  }
  // 2) Budget the image bytes. The caller (btnExport) tunes `totalBudget` so the
  //    url-encoded POST body lands just under dpaste's hard limit. Logos are tiny
  //    PNGs (reserved only if present); the rest is split among the backgrounds —
  //    so a single mosaic source gets the WHOLE budget = max quality.
  const TOTAL = totalBudget || 350 * 1024;
  const bgCount = order.filter((o) => o.kind === "bg").length;
  const logoCount = order.length - bgCount;
  const logoReserve = Math.min(logoCount * 45 * 1024, Math.floor(TOTAL / 2));
  const bgBudget = bgCount ? Math.max(60 * 1024, Math.floor((TOTAL - logoReserve) / bgCount)) : 0;
  const LOGO_BUDGET = 45 * 1024;
  // 3) Encode each distinct image once, spending its share of the budget.
  const imgs = new Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const o = order[i];
    try {
      imgs[i] = o.kind === "logo"
        ? await encodeForShare(o.url, 256, LOGO_BUDGET, "image/png", true)
        : await encodeForShare(o.url, 2400, bgBudget, "image/jpeg", false);
    } catch (e) { imgs[i] = o.url; }
  }
  const ref = (url) => (url && idx.has(url) ? idx.get(url) : undefined);
  // Per-kind shared logo + background (stored once, not per card).
  const shared = {};
  for (const kind of ["protocol", "compile"]) {
    const sh = deckShared[kind];
    const bg = { type: sh.bg.type, name: sh.bg.name, transform: sh.bg.transform };
    if (sh.bg.type === "custom" && sh.bg.dataUrl) bg.img = ref(sh.bg.dataUrl);
    const logo = { zoom: sh.logo.zoom || 1, offsetX: sh.logo.offsetX || 0, offsetY: sh.logo.offsetY || 0 };
    if (sh.logo.dataUrl) logo.img = ref(sh.logo.dataUrl);
    shared[kind] = { bg, logo };
  }
  const cards = [];
  for (const c of deck) {
    const s = c.state;
    const card = { value: s.value, panelTop: s.panelTop, panelMid: s.panelMid, panelBot: s.panelBot, kind: s.kind, compile: s.compile };
    if (perCard && s.bgOwn) {
      const cb = { type: s.bgOwn.type, name: s.bgOwn.name, transform: s.bgOwn.transform };
      if (s.bgOwn.type === "custom" && s.bgOwn.dataUrl) cb.img = ref(s.bgOwn.dataUrl);
      card.bg = cb;
    }
    if (perCard && s.kind === "protocol" && s.bgOwnBack) { // separate back-face bg
      const cbb = { type: s.bgOwnBack.type, name: s.bgOwnBack.name, transform: s.bgOwnBack.transform };
      if (s.bgOwnBack.type === "custom" && s.bgOwnBack.dataUrl) cbb.img = ref(s.bgOwnBack.dataUrl);
      card.bgBack = cbb;
    }
    cards.push(card);
  }
  // Emit in the LEGACY kind format so old and new links read uniformly.
  return flipPayloadKinds({ v: 3, name, title: deckShared.title, code: deckShared.code || "", perCardBg: perCard, glitchPreset: deckShared.glitchPreset || 0, imgs, cards, shared });
}
// Flip kinds in a share/export payload (handles flat cards[].kind, wrapped
// cards[].state.kind, a raw card array, and shared.{protocol,compile}).
function flipPayloadKinds(p) {
  if (!p) return p;
  if (p.shared) flipSharedKeys(p.shared);
  const cards = Array.isArray(p) ? p : (p.cards || []);
  cards.forEach((c) => {
    if (!c) return;
    if (typeof c.kind === "string") c.kind = flipKind(c.kind);
    if (c.state && typeof c.state.kind === "string") c.state.kind = flipKind(c.state.kind);
  });
  return p;
}

const DPASTE_API = "https://dpaste.com/api/v2/"; // CORS-enabled, returns the snippet URL in the body
const DPASTE_BODY_CAP = 505 * 1024; // url-encoded POST body that dpaste accepts (512 KB tested OK; small margin)

// Encode the form body exactly as it's POSTed, so we can size against the real limit.
function dpasteBody(json) { return new URLSearchParams({ content: json, syntax: "text", expiry_days: "365" }); }

// Build the share JSON sized so the url-encoded POST body fits dpaste, spending as
// much of that budget as possible on image quality (only shrinks if it overflows).
async function buildShareJson(name) {
  let budget = 350 * 1024; // image-bytes target; base64 + url-encode overhead is ~1.42×
  let json = "";
  for (let i = 0; i < 4; i++) {
    json = JSON.stringify(await buildSharePayload(name, budget));
    const len = dpasteBody(json).toString().length;
    if (len <= DPASTE_BODY_CAP) break;
    budget = Math.floor(budget * (DPASTE_BODY_CAP / len) * 0.95); // proportional shrink, converges in ~1 step
  }
  return json;
}

el("btnExport").addEventListener("click", async () => {
  if (!deck.length) { notify("The deck is empty."); return; }
  const btn = el("btnExport");
  const orig = btn.textContent; btn.disabled = true; btn.textContent = "…";
  let url, viaService = false;
  try {
    const json = await buildShareJson(el("inDeckName").value.trim() || "Shared deck");
    // Short link: store the deck in a free service so the URL fits anywhere.
    try {
      const res = await fetch(DPASTE_API, { method: "POST", body: dpasteBody(json) }); // form-urlencoded → no CORS preflight
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
  // Short, prominent note (accent colour) — shared images are compressed, so point
  // users at the lossless Export/Import file when they need full quality.
  const headsUp = '<strong style="color:var(--accent)">Heads up:</strong> shared images are compressed. For full quality (e.g. printing), use <strong>Export / Import</strong> instead.';
  const ok = await showModal({
    title: "Share deck",
    bodyHtml: viaService ? headsUp
      : '<span style="color:var(--danger)">Link service unavailable — this is a long, self-contained link.</span><br><br>' + headsUp,
    input: true, value: url, readonly: true, confirmLabel: "Copy link", cancelLabel: "Close", danger: false,
  });
  if (ok) { try { await navigator.clipboard.writeText(url); } catch (e) {} }
});

// Order: the Protocol card (landscape) first, then the rest by value ascending.
function sortDeckStates(states) {
  return states.slice().sort(compareCardStates);
}

// On load: if the URL carries a shared deck, show it in a gallery (view or import).
let sharedStates = null;
let pendingShared = null; // expanded per-kind shared props of the deck being viewed
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
  } catch (e) { console.warn("Shared deck load failed:", e); el("shareView").hidden = true; notify("This shared deck could not be loaded (the link may be invalid or expired)."); return; }
  flipPayloadKinds(data); // legacy share format → coherent in-memory kinds
  const name = (data && data.name) || "Shared deck";
  const imgs = (data && Array.isArray(data.imgs)) ? data.imgs : [];
  let states, expandedShared = null;
  if (data && data.v === 3 && data.shared) {
    // v3: deck-wide title + per-kind shared logo/background stored once.
    const perCardBg = !!data.perCardBg;
    const glitchPreset = data.glitchPreset != null ? data.glitchPreset : (data.frontGlitch ? 1 : 0); // back-compat
    const code = data.code || "";
    expandedShared = {
      title: data.title || data.name || "",
      code, perCardBg, glitchPreset,
      protocol: expandShareImgs(data.shared.protocol, imgs),
      compile: expandShareImgs(data.shared.compile, imgs),
    };
    states = (data.cards || []).map((card) => {
      const st = normalizeState(card);
      const k = st.kind === "protocol" ? "protocol" : "compile"; // shared key matches the card's kind
      st._shared = { title: expandedShared.title, code, perCardBg, glitchPreset, bg: expandedShared[k].bg, logo: expandedShared[k].logo };
      if (card.bg) { // per-card background (perCardBg mode)
        const bg = hydrateBg(card.bg);
        if (typeof card.bg.img === "number") bg.dataUrl = imgs[card.bg.img];
        delete bg.img;
        st.bgOwn = bg;
      }
      if (card.bgBack) { // separate back-face bg
        const bg = hydrateBg(card.bgBack);
        if (typeof card.bgBack.img === "number") bg.dataUrl = imgs[card.bgBack.img];
        delete bg.img;
        st.bgOwnBack = bg;
      }
      return st;
    });
  } else if (data && data.v === 2 && Array.isArray(data.imgs)) {
    // v2: images deduplicated in data.imgs, referenced per card.
    states = (data.cards || []).map((card) => {
      const bg = hydrateBg(card.bg);
      if (card.bg && typeof card.bg.img === "number") bg.dataUrl = imgs[card.bg.img];
      const logo = hydrateLogo(card.logo);
      if (card.logo && typeof card.logo.img === "number") logo.dataUrl = imgs[card.logo.img];
      const st = normalizeState(Object.assign({}, card, { bg, logo }));
      st._shared = { title: st.title, bg: st.bg, logo: st.logo };
      return st;
    });
  } else {
    const raw = Array.isArray(data) ? data : (data && data.cards) || [];
    states = raw.map((c) => { const st = normalizeState(c.state || c); st._shared = { title: st.title, bg: st.bg, logo: st.logo }; return st; });
  }
  if (!states.length) return;
  pendingShared = expandedShared; // {title,protocol,compile} for v3; null for v2/legacy → import derives
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

// Full-resolution card image (crisp when shown large in the share gallery). For a
// compile/Protocol card `side` picks the face ("front" | "back").
async function renderFrontImage(st, side) {
  const off = document.createElement("canvas");
  // Render at 2× with the high-quality downscale so the gallery looks crisp on
  // hi-dpi screens (it's shown large, especially the Protocol card).
  await renderKind(st, off, { side: side || "front", hq: true, scale: 2 });
  return off.toDataURL("image/jpeg", 0.92);
}

async function openShareView(name, states) {
  sharedStates = states;
  el("shareViewTitle").textContent = name;
  el("shareViewCount").textContent = states.length;
  const grid = el("shareGrid");
  el("shareView").hidden = false;
  // keep the big centered loader visible while we render the card images
  const sorted = sortDeckStates(states);
  // A Protocol card (landscape) is shown as both faces, centered.
  const faceHtml = async (st, side) => {
    let url = "";
    try { url = await renderFrontImage(st, side); } catch (e) {}
    return `<div class="sg-card sg-landscape"><img src="${url}" alt=""><span class="sg-label">${side === "back" ? "BACK" : "FRONT"}</span></div>`;
  };
  // Value cards tile into a 3-wide mosaic (their backgrounds line up edge to edge).
  const valueHtml = async (st) => {
    let url = "";
    try { url = await renderFrontImage(st); } catch (e) {}
    const stitle = (st._shared && st._shared.title) || st.title || "—";
    const label = String(st.value).trim() ? "VALUE " + st.value : stitle;
    return `<div class="sg-card"><img src="${url}" alt=""><span class="sg-label">${escapeHtml(label)}</span></div>`;
  };
  const proto = [], values = [];
  for (const st of sorted) {
    if (st.kind === "protocol") { proto.push(await faceHtml(st, "front")); proto.push(await faceHtml(st, "back")); }
    else values.push(await valueHtml(st));
  }
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
  const adopt = pendingShared;
  const name = el("shareViewTitle").textContent || "Shared deck";
  closeShareView();
  // Adopt the shared deck's per-kind logo/background, then drop the per-card view copies.
  if (adopt) setDeckShared(adopt);
  else deriveSharedFromCards(states.map((st) => ({ state: st })));
  saveShared();
  states.forEach((st) => { delete st._shared; });
  deck = states.map((st) => ({ id: newId(), state: st, thumb: "" }));
  currentDeckId = null; currentDeckName = name; el("inDeckName").value = name;
  setEditing(null); saveDeck(); saveDeckMeta(); renderDeck();
  await regenMissingThumbs(); renderDeck();
  editProtocolCard(); // auto-select the protocol card for editing
  markDirty(); // imported deck isn't in "My decks" yet → offer to save it
  captureRevertBaseline(); // the imported deck is the baseline Cancel reverts to
});

async function delCard(id) {
  const card = deck.find((d) => d.id === id);
  const name = (deckShared.title || "").trim() ? `“${deckShared.title}”` : "this card";
  const ok = await showConfirm({ title: "Delete card?", body: `Delete ${name} from the deck? This can't be undone.` });
  if (!ok) return;
  deck = deck.filter((d) => d.id !== id);
  saveDeck();
  markDirty();
  if (editingId === id) {
    setEditing(null);
    await editProtocolCard(); // select another card (or a fresh blank one if none left)
  } else {
    renderDeck();
  }
}


// Download all
el("btnDownloadAll").addEventListener("click", async () => {
  if (deck.length === 0) { notify("The deck is empty."); return; }
  const btn = el("btnDownloadAll");
  btn.disabled = true;
  const original = btn.textContent;
  for (let i = 0; i < deck.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 350)); // pace between cards
    btn.textContent = `${i + 1}/${deck.length}…`;
    // Each card downloads all its faces (Protocol → front + back).
    await downloadCardFaces(deck[i].state, String(i + 1).padStart(2, "0") + "_" + (deckShared.title || "card"));
  }
  btn.textContent = original;
  btn.disabled = false;
});

/* ---------------- Print & play PDF (3×3, 63×88mm) ---------------- */
async function renderToJpeg(st) {
  const off = document.createElement("canvas");
  await renderCard(st, off, true, exportScale);
  return toPoker(off, exportScale).toDataURL("image/jpeg", 0.92);
}

async function renderCompileVerticalJpeg(st, side) {
  const off = document.createElement("canvas");
  await renderCompileVertical(st, side, off, true, exportScale);
  return toPoker(off, exportScale).toDataURL("image/jpeg", 0.92);
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
  if (deck.length === 0) { notify("The deck is empty."); return; }
  const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDFCtor) { notify("PDF library failed to load."); return; }
  const btn = el("btnExportPDF");
  const original = btn.textContent;
  btn.disabled = true;
  try {
    const W = 63.5, H = 88.9, cols = 3, rows = 3, per = 9;   // standard poker card (2.5×3.5"), 3×3 per A4 page
    const pageW = 210, pageH = 297;
    const mx = (pageW - W * cols) / 2, my = (pageH - H * rows) / 2;
    const pdf = new jsPDFCtor({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    const back = await getCardBackPng();
    // Value cards first (they tile into the mosaic on the page), then the Protocol card.
    const ordered = [...valueCards(), ...deck.filter((c) => c.state.kind === "protocol")];
    const pages = Math.ceil(ordered.length / per);
    let firstPage = true;
    for (let p = 0; p < pages; p++) {
      const chunk = ordered.slice(p * per, p * per + per);
      // fronts
      if (!firstPage) pdf.addPage();
      firstPage = false;
      cropMarks(pdf, mx, my, W, H, cols, rows);
      for (let i = 0; i < chunk.length; i++) {
        btn.textContent = `${p * per + i + 1}/${ordered.length}…`;
        const st = chunk[i].state;
        const url = st.kind === "protocol" ? await renderCompileVerticalJpeg(st, "front") : await renderToJpeg(st);
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
        if (st.kind === "protocol") {
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
    notify("Could not generate the PDF: " + e.message);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

// Export / import deck JSON
el("btnExportDeck").addEventListener("click", () => {
  if (deck.length === 0) { notify("The deck is empty."); return; }
  // Lossless + deduplicated: original full-res images are kept verbatim (no
  // re-encode) but pooled once into `imgs`, so a 6-cell mosaic source isn't
  // written 7×. This is the max-quality path for printing / moving a deck.
  const imgs = {};
  const payload = {
    version: 3,
    cards: dehydrateToDict(JSON.parse(JSON.stringify(deck)), imgs),
    shared: dehydrateToDict(JSON.parse(JSON.stringify(deckShared)), imgs),
    imgs,
  };
  flipPayloadKinds(payload); // write in the legacy kind format (matches share + old files)
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
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
    body: "This empties the deck (leaving a single blank card) and deselects the background (your uploaded backgrounds are kept). This can't be undone.",
    confirmLabel: "Clear all",
  });
  if (!ok) return;
  deck = [];
  deckDirty = false;               // fresh deck → nothing pending
  resetShared();                   // clear the shared logo/background for both kinds
  compileSide = "front";
  currentDeckId = null;
  currentDeckName = "";
  el("inDeckName").value = "";
  setEditing(null);
  saveDeck();
  saveShared();
  saveDeckMeta();
  renderSavedDecks();              // clear the "current" highlight on any saved deck
  await editProtocolCard();        // always leave one blank current card in the list
  captureRevertBaseline();         // baseline = the fresh single-card deck
});

el("inImportDeck").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      let data = JSON.parse(reader.result);
      // v3 export file: images are pooled in `imgs` — restore the full-res originals.
      if (data && data.imgs && !Array.isArray(data.imgs)) {
        data = Object.assign({}, data, {
          cards: rehydrateFromDict(data.cards, data.imgs),
          shared: data.shared ? rehydrateFromDict(data.shared, data.imgs) : data.shared,
        });
      }
      flipPayloadKinds(data); // legacy file kind format → coherent in-memory kinds
      const cards = Array.isArray(data) ? data : data.cards;
      if (!Array.isArray(cards)) throw new Error("Invalid format");
      const replace = deck.length === 0 || await showModal({
        title: "Import deck",
        body: "Replace the current deck? (Cancel = append to the end.)",
        confirmLabel: "Replace", cancelLabel: "Append to end", danger: false,
      });
      withDeckLoading(async () => {
        const normalized = cards.map((c) => ({
          id: newId(),
          state: Object.assign(defaultState(), c.state || c),
          thumb: c.thumb || "",
        }));
        deck = replace ? normalized : deck.concat(normalized);
        // Adopt the file's shared logo/background (newer exports), else derive from cards.
        if (replace) {
          if (data && data.shared) setDeckShared(data.shared); else deriveSharedFromCards(deck);
          saveShared();
          setState(defaultState()); syncStateToForm();
        }
        saveDeck();
        markDirty(); // imported deck isn't in "My decks" yet → offer to save it
        captureRevertBaseline(); // the imported deck is the baseline Cancel reverts to
        renderDeck();
        await regenMissingThumbs(); renderDeck();
      });
    } catch (err) {
      notify("Could not import the deck: " + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

async function regenMissingThumbs() {
  for (const card of deck) {
    if (!card.thumb) {
      card.thumb = await makeThumb(card.state);
      const tile = document.querySelector('.deck-card[data-id="' + card.id + '"] .dc-open');
      if (tile) { tile.classList.remove("loading"); const img = tile.querySelector("img"); if (img) img.src = card.thumb; }
    }
  }
  saveDeck();
}

/* ---------------- Init ---------------- */
(async function init() {
  // If the URL carries a shared deck, cover the page with a loading state right away
  // so the editor doesn't flash before the gallery appears.
  const sharedUrl = /[#&](deck|d)=/.test(location.hash);
  if (sharedUrl) showShareLoading();
  else if (stageEl) { bulkLoading = true; stageEl.classList.add("loading"); previewShownAt = performance.now(); } // startup spinner over the editor
  try {
    const raw = (await idbGet("customBgs")) || [];
    customBgs = [];
    for (const e of raw) {
      if (typeof e !== "string") continue;
      if (e.startsWith("data:")) customBgs.push(e);                       // old inline format
      else { const v = await poolGet(e); if (v) customBgs.push(v); }      // pool reference
    }
  } catch (e) { customBgs = []; }
  if (!Array.isArray(customBgs)) customBgs = [];
  buildBgGrid();
  await loadDeck();
  await loadShared();   // per-kind shared logo/background (migrates from old per-card data)
  await loadCurrent();
  await loadSavedDecks();
  el("inDeckName").value = currentDeckName;
  renderDeck();
  renderSavedDecks();
  syncStateToForm();
  refreshToolbar(); // reflect any restored pending-changes state

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
  // The deck always has a current card to edit (creating a blank one if empty),
  // unless the URL carries a shared deck (handled by the gallery below).
  if (!sharedUrl) {
    await editProtocolCard();
    captureRevertBaseline(); // baseline = the startup deck (incl. any auto-created card)
    // Clear the startup spinner (kept up for a clearly-visible minimum).
    const wait = Math.max(0, 480 - (performance.now() - previewShownAt));
    setTimeout(() => { bulkLoading = false; if (stageEl) stageEl.classList.remove("loading"); }, wait);
  }
  await checkSharedDeck(); // import a deck if the URL carries one
})();
