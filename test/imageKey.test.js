import { describe, it, expect } from "vitest";
import { imgKey } from "../src/core/imageKey.js";

describe("imgKey", () => {
  it("is stable for identical content", () => {
    const url = "data:image/png;base64,AAAA";
    expect(imgKey(url)).toBe(imgKey(url));
  });
  it("is namespaced under img:", () => {
    expect(imgKey("data:foo")).toMatch(/^img:/);
  });
  it("differs when content differs", () => {
    expect(imgKey("data:image/png;base64,AAAA")).not.toBe(imgKey("data:image/png;base64,BBBB"));
  });
  it("encodes the length so same-hash-different-length stays distinct", () => {
    const a = imgKey("data:x");
    const b = imgKey("data:xx");
    expect(a.endsWith("_6")).toBe(true);
    expect(b.endsWith("_7")).toBe(true);
  });
});
