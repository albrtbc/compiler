import { describe, it, expect } from "vitest";
import { parseRich, markersToHtml, pieceFont } from "../src/render/text.js";

describe("parseRich", () => {
  it("returns a single plain run for unmarked text", () => {
    expect(parseRich("hello")).toEqual([{ text: "hello", bold: false, underline: false }]);
  });
  it("toggles bold on **", () => {
    expect(parseRich("a **b** c")).toEqual([
      { text: "a ", bold: false, underline: false },
      { text: "b", bold: true, underline: false },
      { text: " c", bold: false, underline: false },
    ]);
  });
  it("toggles underline on __", () => {
    expect(parseRich("__u__")).toEqual([{ text: "u", bold: false, underline: true }]);
  });
  it("supports nested bold + underline", () => {
    expect(parseRich("**__x__**")).toEqual([{ text: "x", bold: true, underline: true }]);
  });
});

describe("markersToHtml", () => {
  it("wraps bold and underline", () => {
    expect(markersToHtml("**b**")).toBe("<b>b</b>");
    expect(markersToHtml("__u__")).toBe("<u>u</u>");
    expect(markersToHtml("**__x__**")).toBe("<b><u>x</u></b>");
  });
  it("escapes HTML-special characters", () => {
    expect(markersToHtml("a<b>&")).toBe("a&lt;b&gt;&amp;");
  });
  it("turns newlines into <br>", () => {
    expect(markersToHtml("a\nb")).toBe("a<br>b");
  });
  it("handles empty / null", () => {
    expect(markersToHtml("")).toBe("");
    expect(markersToHtml(null)).toBe("");
  });
});

describe("pieceFont", () => {
  it("picks the bold face only when bold", () => {
    expect(pieceFont({ bold: false }, 20)).toBe("20px SupermolotR");
    expect(pieceFont({ bold: true }, 20)).toBe("20px SupermolotB");
  });
});
