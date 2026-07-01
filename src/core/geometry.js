"use strict";

import { CARD_W, CARD_H, SCALE_MIN, SCALE_MAX } from "../config.js";

/* Pure geometry helpers for background cover-fit and the mosaic splitter.
   No canvas, no DOM — take plain numbers / {width,height} and return numbers. */

// Clamp a user zoom multiplier to the allowed range (defaults to 1 when falsy).
export function clampScale(s) {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, s || 1));
}

// Base "cover" scale so scale=1 exactly fills a dw×dh box with `img`.
export function bgBaseScale(img, dw = CARD_W, dh = CARD_H) {
  return Math.max(dw / img.width, dh / img.height);
}

// The card-render transform that makes a CARD_W×CARD_H card show image region
// (ix, iy, cw, ch) of an iw×ih source image.
export function cellTransform(iw, ih, ix, iy, cw, ch) {
  const s = CARD_W / cw; // image px → card px
  const base = Math.max(CARD_W / iw, CARD_H / ih);
  return {
    scale: s / base,
    offsetX: -ix * s - (CARD_W - iw * s) / 2,
    offsetY: -iy * s - (CARD_H - ih * s) / 2,
  };
}
