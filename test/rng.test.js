import { describe, it, expect } from "vitest";
import { mulberry32, hashStr } from "../src/core/rng.js";

describe("hashStr", () => {
  it("is deterministic", () => {
    expect(hashStr("glitch")).toBe(hashStr("glitch"));
  });
  it("returns an unsigned 32-bit int", () => {
    const h = hashStr("Water|protocol|Fire");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
  it("differs for different input", () => {
    expect(hashStr("a")).not.toBe(hashStr("b"));
  });
});

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(123), b = mulberry32(123);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });
  it("yields floats in [0, 1)", () => {
    const r = mulberry32(hashStr("seed"));
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("different seeds produce different sequences", () => {
    const a = mulberry32(1), b = mulberry32(2);
    expect(a()).not.toBe(b());
  });
});
