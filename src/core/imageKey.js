"use strict";

import { hashStr } from "./rng.js";

// Content-addressed key for a data URL, used by the image pool so a given image
// is stored once and referenced by key. Stable for identical input.
export function imgKey(dataUrl) {
  return "img:" + (hashStr(dataUrl) >>> 0).toString(36) + "_" + dataUrl.length;
}
