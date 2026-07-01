import { describe, it, expect } from "vitest";
import { kindPriority, compareCardStates, compareDeckEntries } from "../src/model/order.js";

// Current semantics: kind "protocol" = the landscape Protocol card (sorts first),
// kind "compile" = a vertical value card.
const proto = { kind: "protocol", value: "" };
const v = (n) => ({ kind: "compile", value: String(n) });

describe("kindPriority", () => {
  it("puts the landscape Protocol card (protocol) first", () => {
    expect(kindPriority(proto)).toBe(0);
    expect(kindPriority(v(3))).toBe(1);
  });
});

describe("compareCardStates", () => {
  it("orders protocol card first, then value cards ascending", () => {
    const sorted = [v(3), proto, v(1), v(2)].slice().sort(compareCardStates);
    expect(sorted.map((s) => (s.kind === "protocol" ? "P" : s.value))).toEqual(["P", "1", "2", "3"]);
  });
  it("treats blank/non-numeric values as 0", () => {
    const sorted = [v(2), v("")].slice().sort(compareCardStates);
    expect(sorted.map((s) => s.value)).toEqual(["", "2"]);
  });
});

describe("compareDeckEntries", () => {
  const entry = (state, _new = false) => ({ state, _new });
  it("keeps freshly-added (_new) cards pinned to the end", () => {
    const list = [entry(v(5), true), entry(v(1)), entry(v(3))];
    const sorted = list.slice().sort(compareDeckEntries);
    expect(sorted.map((e) => e.state.value + (e._new ? "*" : ""))).toEqual(["1", "3", "5*"]);
  });
  it("protocol card stays first even if new value cards exist", () => {
    const list = [entry(v(2)), entry(proto), entry(v(1), true)];
    const sorted = list.slice().sort(compareDeckEntries);
    expect(sorted[0].state.kind).toBe("protocol");
  });
});
