import { describe, it, expect } from "vitest";
import {
  defaultTransform, defaultBg, defaultLogo,
  migrateBg, hydrateBg, hydrateLogo, sameBg,
} from "../src/model/bg.js";

describe("factories", () => {
  it("produce fresh, independent objects", () => {
    expect(defaultTransform()).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(defaultBg()).toEqual({ type: "none", name: null, dataUrl: null, transform: { scale: 1, offsetX: 0, offsetY: 0 } });
    expect(defaultLogo()).toEqual({ dataUrl: null, zoom: 1, offsetX: 0, offsetY: 0 });
    expect(defaultBg().transform).not.toBe(defaultBg().transform);
  });
});

describe("migrateBg", () => {
  it("renames old Spanish preset names in place", () => {
    const bg = { type: "preset", name: "Fuego" };
    expect(migrateBg(bg)).toBe(true);
    expect(bg.name).toBe("Fire");
  });
  it("leaves current names untouched", () => {
    const bg = { type: "preset", name: "Fire" };
    expect(migrateBg(bg)).toBe(false);
    expect(bg.name).toBe("Fire");
  });
  it("ignores non-preset backgrounds", () => {
    expect(migrateBg({ type: "custom", name: "Fuego" })).toBe(false);
  });
});

describe("hydrateBg", () => {
  it("fills defaults for a partial bg", () => {
    expect(hydrateBg({ type: "preset", name: "Fire" })).toEqual({
      type: "preset", name: "Fire", dataUrl: null,
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
    });
  });
  it("normalises a partial transform and migrates names", () => {
    const bg = hydrateBg({ type: "preset", name: "Agua", transform: { scale: 2 } });
    expect(bg.name).toBe("Water");
    expect(bg.transform).toEqual({ scale: 2, offsetX: 0, offsetY: 0 });
  });
  it("handles null/undefined", () => {
    expect(hydrateBg(null)).toEqual(defaultBg());
    expect(hydrateBg(undefined)).toEqual(defaultBg());
  });
});

describe("hydrateLogo", () => {
  it("fills defaults", () => {
    expect(hydrateLogo({ zoom: 2 })).toEqual({ dataUrl: null, zoom: 2, offsetX: 0, offsetY: 0 });
    expect(hydrateLogo(null)).toEqual(defaultLogo());
  });
});

describe("sameBg", () => {
  const base = { dataUrl: "x", transform: { scale: 1, offsetX: 0, offsetY: 0 } };
  it("true for identical bgs", () => {
    expect(sameBg(base, { dataUrl: "x", transform: { scale: 1, offsetX: 0, offsetY: 0 } })).toBe(true);
  });
  it("tolerates sub-pixel offset / tiny scale drift", () => {
    expect(sameBg(base, { dataUrl: "x", transform: { scale: 1.000001, offsetX: 0.2, offsetY: 0 } })).toBe(true);
  });
  it("false for different image or scale", () => {
    expect(sameBg(base, { dataUrl: "y", transform: base.transform })).toBe(false);
    expect(sameBg(base, { dataUrl: "x", transform: { scale: 1.5, offsetX: 0, offsetY: 0 } })).toBe(false);
  });
  it("false when either is missing", () => {
    expect(sameBg(null, base)).toBe(false);
    expect(sameBg(base, null)).toBe(false);
  });
});
