import { describe, it, expect } from "vitest";
import { fitNameLine, fitSingleLine, drawLine } from "../src/render/text.js";
import { ZONES, COMPILE_FRONT, COMPILE_BACK } from "../src/config.js";

const K = 0.5; // glyph width in em

// Fake 2D context: width = chars*size*K + chars*letterSpacingPx. Records fillText calls.
// withTracking=false leaves out the letterSpacing property (older browsers).
function fakeCtx({ withTracking = true, letterSpacing = "0px" } = {}) {
  const ctx = {
    font: "",
    fillText(...args) { ctx.calls.push({ args, letterSpacing: ctx.letterSpacing, font: ctx.font }); },
    measureText(text) {
      const size = parseFloat(ctx.font);
      const ls = withTracking ? parseFloat(ctx.letterSpacing) || 0 : 0;
      const n = [...text].length;
      return { width: n * size * K + n * ls, actualBoundingBoxAscent: size * 0.7, actualBoundingBoxDescent: size * 0.1 };
    },
    calls: [],
  };
  if (withTracking) ctx.letterSpacing = letterSpacing;
  return ctx;
}

const avail = (z) => z.w - 2 * (z.padX || 0);
const drawn = (ctx, text, r, z) => {
  ctx.font = `${r.size}px ${z.font}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = r.trackingPx + "px";
  return ctx.measureText(text).width * r.scaleX;
};

describe("fitNameLine", () => {
  const z = ZONES.title; // max 60, min 18, availW 204
  it("returns zone.max, no tracking, no squeeze for a short name (same as fitSingleLine)", () => {
    const ctx = fakeCtx();
    const r = fitNameLine(ctx, "CODE", z);
    expect(r).toEqual({ size: z.max, trackingPx: 0, scaleX: 1 });
    expect(r.size).toBe(fitSingleLine(fakeCtx(), "CODE", z.font, avail(z), z.h, z.max, z.min));
  });

  it("keeps a larger size than fitSingleLine for a long name, within the floors", () => {
    const text = "ASSIMILATION"; // 12 chars: 360 px at 60, over 204
    const ctx = fakeCtx();
    const r = fitNameLine(ctx, text, z);
    const plain = fitSingleLine(fakeCtx(), text, z.font, avail(z), z.h, z.max, z.min);
    expect(r.size).toBeGreaterThan(plain);
    expect(r.scaleX).toBeGreaterThanOrEqual(z.fit.minScaleX);
    expect(r.scaleX).toBeLessThanOrEqual(1);
    expect(r.trackingPx / r.size).toBeGreaterThanOrEqual(z.fit.tracking - 1e-9);
    expect(r.trackingPx).toBeLessThan(0);
    expect(drawn(ctx, text, r, z)).toBeLessThanOrEqual(avail(z) + 1e-6);
  });

  it("falls back to zone.min with a squeeze below the floor for a 40-character name", () => {
    const text = "A".repeat(40);
    const ctx = fakeCtx();
    const r = fitNameLine(ctx, text, z);
    expect(r.size).toBe(z.min);
    expect(r.scaleX).toBeLessThan(z.fit.minScaleX);
    expect(r.trackingPx / r.size).toBeCloseTo(z.fit.tracking, 9);
    expect(drawn(ctx, text, r, z)).toBeLessThanOrEqual(avail(z) + 1e-6);
  });

  it("without letterSpacing support uses no tracking and still fits", () => {
    const text = "ASSIMILATION";
    const ctx = fakeCtx({ withTracking: false });
    const r = fitNameLine(ctx, text, z);
    expect(r.trackingPx).toBe(0);
    expect(r.scaleX).toBeGreaterThanOrEqual(z.fit.minScaleX);
    expect(r.scaleX).toBeLessThan(1);
    expect(drawn(ctx, text, r, z)).toBeLessThanOrEqual(avail(z) + 1e-6);
    expect("letterSpacing" in ctx).toBe(false);
    const long = fitNameLine(ctx, "A".repeat(40), z);
    expect(long.trackingPx).toBe(0);
    expect(drawn(ctx, "A".repeat(40), long, z)).toBeLessThanOrEqual(avail(z) + 1e-6);
  });

  it("restores ctx.letterSpacing", () => {
    for (const text of ["CODE", "ASSIMILATION", "A".repeat(40)]) {
      const ctx = fakeCtx({ letterSpacing: "3px" });
      fitNameLine(ctx, text, z);
      expect(ctx.letterSpacing).toBe("3px");
    }
  });

  it("restores ctx.letterSpacing and rethrows when measureText throws after it changed", () => {
    const ctx = fakeCtx({ letterSpacing: "3px" });
    let calls = 0;
    const measure = ctx.measureText;
    ctx.measureText = (text) => {
      if (++calls > 1) throw new Error("measure failed");
      return measure(text);
    };
    expect(() => fitNameLine(ctx, "ASSIMILATION", z)).toThrow("measure failed");
    expect(calls).toBe(2);
    expect(ctx.letterSpacing).toBe("3px");
  });

  it("does not blow up on empty text or a zone without fit", () => {
    expect(fitNameLine(fakeCtx(), "", z)).toEqual({ size: z.max, trackingPx: 0, scaleX: 1 });
    const r = fitNameLine(fakeCtx(), "A".repeat(40), { ...z, fit: undefined });
    expect(Number.isFinite(r.scaleX)).toBe(true);
    expect(Number.isFinite(r.trackingPx)).toBe(true);
  });
});

describe("drawLine", () => {
  it("on a zone without fit matches the fitSingleLine call and never touches letterSpacing", () => {
    const z = COMPILE_FRONT.subtitle;
    const text = "A fairly long subtitle that has to shrink to fit the zone width";
    const ctx = fakeCtx({ letterSpacing: "5px" });
    let touched = false;
    let ls = ctx.letterSpacing;
    Object.defineProperty(ctx, "letterSpacing", { get: () => ls, set: (v) => { touched = true; ls = v; } });
    drawLine(ctx, text, z, "#fff");
    const size = fitSingleLine(fakeCtx({ letterSpacing: "5px" }), text, z.font, avail(z), z.h, z.max, z.min);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].args).toEqual([text, z.x + z.w / 2, z.y + z.h / 2, avail(z)]);
    expect(ctx.calls[0].font).toBe(`${size}px ${z.font}`);
    expect(touched).toBe(false);
    expect(ls).toBe("5px");
  });

  it("on a fit zone passes availW as maxWidth, tracks while drawing and resets to 0px", () => {
    for (const z of [ZONES.title, COMPILE_FRONT.name, COMPILE_BACK.name]) {
      const text = "ASSIMILATION PROTOCOL";
      const ctx = fakeCtx({ letterSpacing: "4px" });
      const r = fitNameLine(fakeCtx(), text, z);
      drawLine(ctx, text, z, "#fff");
      expect(ctx.calls).toHaveLength(1);
      const [t, , , maxW] = ctx.calls[0].args;
      expect(t).toBe(text);
      expect(maxW).toBe(avail(z));
      expect(ctx.calls[0].font).toBe(`${r.size}px ${z.font}`);
      expect(ctx.calls[0].letterSpacing).toBe(r.trackingPx + "px");
      expect(ctx.letterSpacing).toBe("0px");
    }
  });

  it("on a fit zone with a name that fits draws exactly like today", () => {
    const z = COMPILE_FRONT.name;
    const ctx = fakeCtx();
    drawLine(ctx, "CODE", z, "#fff");
    const size = fitSingleLine(fakeCtx(), "CODE", z.font, avail(z), z.h, z.max, z.min);
    expect(ctx.calls[0].font).toBe(`${size}px ${z.font}`);
    expect(ctx.calls[0].letterSpacing).toBe("0px");
    expect(ctx.calls[0].args[3]).toBe(avail(z));
  });

  it("on a fit zone without letterSpacing support does not add the property", () => {
    const ctx = fakeCtx({ withTracking: false });
    drawLine(ctx, "ASSIMILATION PROTOCOL", ZONES.title, "#fff");
    expect("letterSpacing" in ctx).toBe(false);
    expect(ctx.calls).toHaveLength(1);
  });
});
