import { describe, it, expect } from "vitest";
import { clampScale, bgBaseScale, cellTransform } from "../src/core/geometry.js";
import { SCALE_MIN, SCALE_MAX } from "../src/config.js";

describe("clampScale", () => {
  it("defaults falsy input to 1", () => {
    expect(clampScale(0)).toBe(1);
    expect(clampScale(undefined)).toBe(1);
    expect(clampScale(null)).toBe(1);
  });
  it("clamps to [SCALE_MIN, SCALE_MAX]", () => {
    expect(clampScale(0.01)).toBe(SCALE_MIN);
    expect(clampScale(9999)).toBe(SCALE_MAX);
    expect(clampScale(2)).toBe(2);
  });
});

describe("bgBaseScale", () => {
  it("covers the box (largest of the two ratios)", () => {
    expect(bgBaseScale({ width: 744, height: 1039 }, 744, 1039)).toBe(1);
    // wide image into a portrait card → height ratio dominates
    expect(bgBaseScale({ width: 2000, height: 1000 }, 744, 1039)).toBeCloseTo(1039 / 1000, 6);
  });
});

// toEqual treats -0 and 0 as distinct; cellTransform can legitimately return -0
// (e.g. -0 * s). Compare field-by-field with toBeCloseTo, which does not.
const expectTransform = (t, { scale, offsetX, offsetY }) => {
  expect(t.scale).toBeCloseTo(scale, 6);
  expect(t.offsetX).toBeCloseTo(offsetX, 6);
  expect(t.offsetY).toBeCloseTo(offsetY, 6);
};

describe("cellTransform", () => {
  it("maps a whole card-shaped image to the identity transform", () => {
    expectTransform(cellTransform(744, 1039, 0, 0, 744, 1039), { scale: 1, offsetX: 0, offsetY: 0 });
  });
  it("computes the right-half region of a double-wide image", () => {
    expectTransform(cellTransform(1488, 1039, 744, 0, 744, 1039), { scale: 1, offsetX: -372, offsetY: 0 });
  });
  it("always returns finite numbers", () => {
    const t = cellTransform(3000, 2000, 500, 400, 1000, 700);
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(Number.isFinite(t.offsetX)).toBe(true);
    expect(Number.isFinite(t.offsetY)).toBe(true);
  });
});
