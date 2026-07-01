import { describe, it, expect } from "vitest";
import { glitchSeed } from "../src/render/glitch.js";

describe("glitchSeed", () => {
  it("combines value, kind and title into a stable key", () => {
    expect(glitchSeed({ value: "3", kind: "compile", title: "NEON" })).toBe("3|compile|NEON");
  });
  it("tolerates missing fields", () => {
    expect(glitchSeed({ kind: "protocol" })).toBe("|protocol|");
    expect(glitchSeed({})).toBe("|undefined|");
  });
  it("is stable for the same card and differs across cards", () => {
    const a = { value: "1", kind: "compile", title: "X" };
    expect(glitchSeed(a)).toBe(glitchSeed(a));
    expect(glitchSeed(a)).not.toBe(glitchSeed({ value: "2", kind: "compile", title: "X" }));
  });
});
