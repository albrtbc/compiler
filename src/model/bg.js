"use strict";

import { PRESET_MIGRATION } from "../config.js";

/* Background / logo value objects and their (de)normalisation.
   Pure factories + a single `hydrateBg` that replaces the copy-pasted
   `Object.assign(defaultBg(), …); transform = …; migrateBg()` pattern. */

export const defaultTransform = () => ({ scale: 1, offsetX: 0, offsetY: 0 });
export const defaultBg = () => ({ type: "none", name: null, dataUrl: null, transform: defaultTransform() });
export const defaultLogo = () => ({ dataUrl: null, zoom: 1, offsetX: 0, offsetY: 0 });

// Rename old Spanish preset names in place. Returns true if it changed anything.
export function migrateBg(bg) {
  if (bg && bg.type === "preset" && bg.name && PRESET_MIGRATION[bg.name]) {
    bg.name = PRESET_MIGRATION[bg.name];
    return true;
  }
  return false;
}

// Merge an arbitrary/partial bg with defaults, normalise its transform and run
// the preset-name migration. Always returns a complete, safe bg object.
export function hydrateBg(src) {
  const bg = Object.assign(defaultBg(), src || {});
  bg.transform = Object.assign(defaultTransform(), (src && src.transform) || {});
  migrateBg(bg);
  return bg;
}

// Merge an arbitrary/partial logo with defaults.
export function hydrateLogo(src) {
  return Object.assign(defaultLogo(), src || {});
}

// Whether two backgrounds render identically (same image + same transform,
// within tiny tolerances). Used by the mosaic splitter to skip no-op updates.
export function sameBg(a, b) {
  return !!a && !!b && a.dataUrl === b.dataUrl && !!a.transform && !!b.transform &&
    Math.abs(a.transform.offsetX - b.transform.offsetX) < 0.5 &&
    Math.abs(a.transform.offsetY - b.transform.offsetY) < 0.5 &&
    Math.abs(a.transform.scale - b.transform.scale) < 1e-4;
}
