"use strict";

import { GLITCH_PRESETS } from "../config.js";
import { mulberry32, hashStr } from "../core/rng.js";

/* Datamosh-style front "glitch". Deterministic per card (seeded), so each card's
   glitch is stable across re-renders. Pure: draws only into the given context. */

// A seed that's stable per card but varies between cards.
export function glitchSeed(st) { return (st.value || "") + "|" + st.kind + "|" + (st.title || ""); }

// Run AFTER the background and BEFORE the frame/panels/text so only the bg is glitched.
export function applyFrontGlitch(ctx, w, h, seedStr, cfg) {
  cfg = cfg || GLITCH_PRESETS[0];
  const rnd = mulberry32(hashStr(seedStr || "glitch"));
  const sc = (ctx.getTransform && ctx.getTransform().a) || 1; // physical px per logical unit (hi-res export)
  const off = document.createElement("canvas");
  off.width = ctx.canvas.width; off.height = ctx.canvas.height; // physical snapshot
  off.getContext("2d").drawImage(ctx.canvas, 0, 0);
  const lerp = (r) => r[0] + rnd() * (r[1] - r[0]);

  // 1) Displaced shards. Source coords physical (×sc), dest coords logical.
  let y = 0;
  while (y < h) {
    const rh = h * lerp(cfg.rowH);
    let x = 0;
    while (x < w) {
      const rw = w * lerp(cfg.colW);
      const cw = Math.min(rw, w - x), ch = Math.min(rh, h - y);
      if (rnd() < cfg.shardChance) {
        const dx = (rnd() - 0.5) * w * cfg.shardDX;
        ctx.drawImage(off, x * sc, y * sc, cw * sc, ch * sc, x + dx, y, cw, ch);
      }
      x += rw;
    }
    y += rh;
  }

  // 2) Duplicated squares: copy chunks and stamp them elsewhere (cloned-block look).
  for (let i = 0; i < cfg.dupes; i++) {
    const sz = w * lerp(cfg.dupSize);
    const sw = Math.min(sz, w), sh = Math.min(sz, h);
    const sx = rnd() * (w - sw), sy = rnd() * (h - sh);
    const copies = 1 + Math.floor(rnd() * cfg.dupCopies);
    for (let k = 0; k < copies; k++) {
      const dx = rnd() * (w - sw);
      const dy = (rnd() < 0.6) ? sy + (rnd() - 0.5) * h * 0.06 : rnd() * (h - sh);
      ctx.drawImage(off, sx * sc, sy * sc, sw * sc, sh * sc, dx, Math.max(0, Math.min(h - sh, dy)), sw, sh);
    }
  }

  // 3) Bright chromatic slices for a fringe.
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = cfg.chromaA;
  for (let i = 0; i < cfg.chroma; i++) {
    const sy = rnd() * h, sh = h * (0.004 + rnd() * 0.02), dx = (rnd() - 0.5) * w * cfg.chromaDX;
    ctx.drawImage(off, 0, sy * sc, off.width, sh * sc, dx, sy, w, sh);
  }
  ctx.restore();
}
