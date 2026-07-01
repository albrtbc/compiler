"use strict";

import { CARD_W, CARD_H, POKER_W, POKER_H } from "../config.js";
import { bgBaseScale, clampScale } from "../core/geometry.js";
import { hqDownscaled } from "../core/images.js";

/* Stateless canvas drawing primitives: the hexagon logo clip, cover-fit
   background, the rotated set-code, and the print-size resample. */

// Hexagon outline matching the frame: "v" = points top/bottom (vertical card),
// "h" = points left/right (rotated/landscape card). Flat sides over the middle 50%.
export function hexPath(ctx, box, pointy) {
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
export function drawLogoHex(ctx, img, box, pointy, logo) {
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

/* ---- Background draw (cover + pan/zoom) ---- */
// base "cover" scale so scale=1 exactly fills the card; the user transform
// multiplies that scale and offsets from the centred position (card pixels).
export function drawBackground(ctx, img, t, dw = CARD_W, dh = CARD_H, hq = false) {
  const s = bgBaseScale(img, dw, dh) * clampScale(t ? t.scale : 1);
  const w = img.width * s;
  const h = img.height * s;
  const x = (dw - w) / 2 + (t ? t.offsetX : 0);
  const y = (dh - h) / 2 + (t ? t.offsetY : 0);
  const physScale = (ctx.getTransform && ctx.getTransform().a) || 1; // device px per logical unit (hi-res export)
  ctx.drawImage(hq ? hqDownscaled(img, w * physScale) : img, x, y, w, h);
}

// Small deck-wide "set code" (e.g. HMBW / MN01) drawn on the card edge, like the
// official cards. `vertical` draws it rotated, reading bottom-to-top.
export function drawSideCode(ctx, text, opts) {
  const t = (text || "").trim().toUpperCase();
  if (!t) return;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 4;
  ctx.font = (opts.size || 20) + "px " + (opts.font || "SupermolotR");
  ctx.textBaseline = "middle";
  if (opts.letterSpacing != null) { try { ctx.letterSpacing = opts.letterSpacing + "px"; } catch (e) {} }
  if (opts.vertical) {
    ctx.translate(opts.x, opts.y);
    ctx.rotate(-Math.PI / 2); // text reads bottom-to-top
    if (opts.condense) ctx.scale(opts.condense, 1); // squish along the run → flatter (achatada)
    ctx.textAlign = opts.topAnchor ? "right" : "center"; // topAnchor → run grows down from anchor y
    ctx.fillText(t, 0, 0);
  } else {
    ctx.textAlign = opts.align || "right";
    ctx.fillText(t, opts.x, opts.y);
  }
  ctx.restore();
}

// Resize a freshly-rendered card to the exact print size (poker 63.5×88.9mm),
// keeping orientation. `scale` is the dpi factor (1 = 300dpi, 2 = 600dpi).
export function toPoker(master, scale) {
  const landscape = master.width > master.height;
  const w = Math.round((landscape ? POKER_H : POKER_W) * scale);
  const h = Math.round((landscape ? POKER_W : POKER_H) * scale);
  if (master.width === w && master.height === h) return master;
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const cx = out.getContext("2d"); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
  cx.drawImage(master, 0, 0, w, h);
  return out;
}
