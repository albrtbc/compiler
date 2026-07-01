"use strict";

import { PANEL_FONT, PANEL_MAX, PANEL_MIN, LINE_FACTOR } from "../config.js";

/* Canvas text layout: single-line auto-fit, word wrap, and the rich (**bold** /
   __underline__) panel text. Functions take a 2D context and are otherwise pure;
   `panelFitSize` uses a private offscreen context just to measure. */

// Own offscreen context for measuring (mirrors what the canvas would compute).
// Created lazily so this module can be imported in non-DOM environments (tests).
let _measureCtx = null;
function measureCtx() {
  return _measureCtx || (_measureCtx = document.createElement("canvas").getContext("2d"));
}

export function fitSingleLine(ctx, text, fontFam, maxW, maxH, maxSize, minSize) {
  let size = maxSize;
  for (; size >= minSize; size--) {
    ctx.font = `${size}px ${fontFam}`;
    const m = ctx.measureText(text);
    const h = (m.actualBoundingBoxAscent || size * 0.8) + (m.actualBoundingBoxDescent || size * 0.2);
    if (m.width <= maxW && h <= maxH) break;
  }
  return Math.max(size, minSize);
}

export function wrapLines(ctx, text, fontFam, size, maxW) {
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

export function drawLine(ctx, text, zone, color) {
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
export function parseRich(text) {
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
export function richParagraphs(text) {
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

export function pieceFont(p, size) { return `${size}px ${p.bold ? "SupermolotB" : PANEL_FONT}`; }

export function wordWidth(ctx, word, size) {
  let w = 0;
  for (const p of word) { ctx.font = pieceFont(p, size); w += ctx.measureText(p.text).width; }
  return w;
}

export function wrapRich(ctx, paragraphs, size, maxW) {
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

export function drawPanelText(ctx, text, zone, color) {
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

// Font size + line count the canvas uses for a wrapped panel (mirrors drawPanelText).
export function panelFitSize(text, zone) {
  const t = (text || "").replace(/\s+$/g, "");
  if (!t.trim()) return { size: PANEL_MAX, lines: 1 };
  const paras = richParagraphs(t);
  let size = PANEL_MAX, wrapped = null;
  const mctx = measureCtx();
  for (; size >= PANEL_MIN; size--) {
    wrapped = wrapRich(mctx, paras, size, zone.w);
    if (wrapped.lines.length * size * LINE_FACTOR <= zone.h) break;
  }
  return { size, lines: wrapped ? Math.max(1, wrapped.lines.length) : 1 };
}

/* ---- Marker string <-> HTML (contenteditable panels) ---- */
export function escapeHtmlText(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export function markersToHtml(str) {
  return (str || "").split("\n").map((line) =>
    parseRich(line).map((r) => {
      let h = escapeHtmlText(r.text);
      if (r.underline) h = `<u>${h}</u>`;
      if (r.bold) h = `<b>${h}</b>`;
      return h;
    }).join("")
  ).join("<br>");
}

export function htmlToMarkers(root) {
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
