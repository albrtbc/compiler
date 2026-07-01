import { describe, it, expect } from "vitest";
import { bytesToB64url, b64urlToBytes } from "../src/core/base64.js";

describe("base64url round-trip", () => {
  it("restores arbitrary bytes exactly", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63, 43, 47]);
    const back = b64urlToBytes(bytesToB64url(bytes));
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
  it("produces URL-safe output (no +, /, =)", () => {
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    const s = bytesToB64url(bytes);
    expect(s).not.toMatch(/[+/=]/);
  });
  it("round-trips a UTF-8 payload", () => {
    const src = "◆ COMPILER · glitch — año";
    const bytes = new TextEncoder().encode(src);
    const back = new TextDecoder().decode(b64urlToBytes(bytesToB64url(bytes)));
    expect(back).toBe(src);
  });
});
