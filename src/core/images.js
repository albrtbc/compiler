"use strict";

/* Image loading, caching and (re)compression. No app state — just images and
   canvases. Uploaded photos are downscaled/recompressed so they fit storage and
   the share link; large backgrounds are stepped down for crisp draws. */

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load: " + src));
    img.src = src;
  });
}

const presetCache = new Map();    // name -> Image (full-res)
const dataUrlCache = new Map();   // dataUrl -> Image
const valueOverlayCache = new Map(); // value token -> Image | null

// Downscale + recompress an uploaded image so it fits comfortably in storage
// (a full-res photo as base64 easily blows the ~5MB quota). The card only
// renders ~744px wide, so we never need more than that.
export function normalizeImage(dataUrl, maxW, maxH, mime, quality) {
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

// Bytes carried by a dataURL's base64 body (≈ what it costs in the share link).
export function dataUrlBytes(u) { const i = u.indexOf(","); return Math.ceil((u.length - i - 1) * 0.75); }

// High-quality downscale by repeated halving: a single big drawImage step (e.g.
// 8000→744) is soft/aliased, so we step the image down to ~the displayed width
// first. Cached per image so exports of several cards reuse the work.
const hqCache = new WeakMap(); // img -> Map(targetWidth -> canvas)
export function hqDownscaled(img, targetW) {
  const tw = Math.max(1, Math.round(targetW));
  if (!img.width || img.width <= tw * 1.5) return img; // upscaling / minor → no benefit
  let m = hqCache.get(img); if (!m) { m = new Map(); hqCache.set(img, m); }
  if (m.has(tw)) return m.get(tw);
  let cur = img, cw = img.width, ch = img.height;
  while (cw > tw * 2) {
    const nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(1, Math.round(ch * nw / cw));
    const c = document.createElement("canvas"); c.width = nw; c.height = nh;
    const cx = c.getContext("2d"); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.drawImage(cur, 0, 0, nw, nh); cur = c; cw = nw; ch = nh;
  }
  const fh = Math.max(1, Math.round(ch * tw / cw));
  const fc = document.createElement("canvas"); fc.width = tw; fc.height = fh;
  const fcx = fc.getContext("2d"); fcx.imageSmoothingEnabled = true; fcx.imageSmoothingQuality = "high";
  fcx.drawImage(cur, 0, 0, tw, fh);
  if (m.size > 8) m.clear();
  m.set(tw, fc);
  return fc;
}

// Encode an image for the share link: stepped high-quality downscale, then JPEG
// (or PNG for logos) with quality/size lowered only as needed to fit `budgetBytes`.
// The share transport (dpaste) caps the whole payload at <1 MB, so we spend that
// budget on the FEW pooled images instead of crushing everything to 720px.
export function encodeForShare(dataUrl, maxDim, budgetBytes, mime, isLogo) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longSide = Math.max(img.width, img.height);
      const encode = (targetLong, q) => {
        const scale = Math.min(1, targetLong / longSide);
        const tw = Math.max(1, Math.round(img.width * scale));
        const th = Math.max(1, Math.round(img.height * scale));
        const src = hqDownscaled(img, tw); // pre-stepped so the final draw is ~1:1 → crisp
        const c = document.createElement("canvas"); c.width = tw; c.height = th;
        const cx = c.getContext("2d"); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
        cx.drawImage(src, 0, 0, tw, th);
        return c.toDataURL(mime, q);
      };
      let dim = Math.min(maxDim, longSide);
      if (isLogo) { resolve(encode(dim, 1)); return; } // small PNG, no need to tune
      // Spend the budget on the LARGEST size that still fits at decent quality:
      // at each size try quality high→low and take the first that fits; only shrink
      // the image if even q=0.6 won't fit. Keeps resolution and avoids muddy q=0.5.
      let best = null;
      for (let i = 0; i < 8 && dim >= 600; i++) {
        for (const q of [0.9, 0.84, 0.78, 0.72, 0.66, 0.6]) {
          const out = encode(dim, q);
          if (dataUrlBytes(out) <= budgetBytes) { best = out; break; }
        }
        if (best) break;
        dim = Math.round(dim * 0.85);
      }
      resolve(best || encode(Math.max(600, dim), 0.5));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export async function getImageFromDataUrl(dataUrl) {
  if (!dataUrl) return null;
  if (dataUrlCache.has(dataUrl)) return dataUrlCache.get(dataUrl);
  const img = await loadImage(dataUrl);
  dataUrlCache.set(dataUrl, img);
  return img;
}

export async function getPresetImage(name) {
  if (presetCache.has(name)) return presetCache.get(name);
  const img = await loadImage(`card-backgrounds/${name}.jpg`);
  presetCache.set(name, img);
  return img;
}

// Per-value art (card-frame/value_<n>.png) drawn behind the frame on normal
// cards. Only numeric values map to a file; anything without a matching file
// resolves to null (cached) so the card just renders without it — no error.
export async function getValueOverlay(value) {
  const v = String(value == null ? "" : value).trim();
  if (!/^[0-9]+$/.test(v)) return null;
  if (valueOverlayCache.has(v)) return valueOverlayCache.get(v);
  let img = null;
  try { img = await loadImage(`card-frame/value_${v}.png`); } catch (e) { img = null; }
  valueOverlayCache.set(v, img);
  return img;
}

// Rotate an image 90° counter-clockwise into a new canvas (vertical frame → landscape).
export function rotate90ccw(img) {
  const c = document.createElement("canvas");
  c.width = img.height; c.height = img.width;
  const x = c.getContext("2d");
  x.translate(0, c.height);
  x.rotate(-Math.PI / 2);
  x.drawImage(img, 0, 0);
  return c;
}
