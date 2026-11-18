import { describe, expect, it } from "vitest";
import { compileTokenPattern, PatternError } from "../src/index.js";

const ids = [
  "color.text.primary",
  "color.text.secondary",
  "color.text.on-brand",
  "color.surface.base",
  "color.surface.raised.hover",
  "space.4",
];

const match = (pattern: string) => ids.filter(compileTokenPattern(pattern));

describe("compileTokenPattern", () => {
  it("matches exact ids", () => {
    expect(match("color.text.primary")).toEqual(["color.text.primary"]);
    expect(match("color.text")).toEqual([]);
  });

  it("uses * for one whole segment", () => {
    expect(match("color.text.*")).toEqual([
      "color.text.primary",
      "color.text.secondary",
      "color.text.on-brand",
    ]);
    expect(match("color.*.base")).toEqual(["color.surface.base"]);
  });

  it("uses * inside a segment without crossing dots", () => {
    expect(match("color.text.*ary")).toEqual(["color.text.primary", "color.text.secondary"]);
    expect(match("color.text.on-*")).toEqual(["color.text.on-brand"]);
    expect(match("color.surface.r*")).toEqual([]);
  });

  it("uses ** for any number of segments, including none", () => {
    expect(match("color.surface.**")).toEqual(["color.surface.base", "color.surface.raised.hover"]);
    expect(match("**.hover")).toEqual(["color.surface.raised.hover"]);
    expect(match("color.**.primary")).toEqual(["color.text.primary"]);
    expect(match("**")).toEqual(ids);
  });

  it("treats regex characters literally", () => {
    const matches = compileTokenPattern("a.b+c.*");
    expect(matches("a.b+c.x")).toBe(true);
    expect(matches("a.bbc.x")).toBe(false);
  });

  it("handles many ** segments without blowing up", () => {
    const long = Array.from({ length: 40 }, (_, i) => `s${i}`).join(".");
    const start = performance.now();
    expect(compileTokenPattern("**.**.**.**.**.**.nope")(long)).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it.each([
    ["", "cannot be empty"],
    [" color.*", "spaces"],
    ["color..text", "empty segment"],
    ["color.text**", "whole segment"],
  ])("rejects %j", (pattern, message) => {
    expect(() => compileTokenPattern(pattern)).toThrow(PatternError);
    expect(() => compileTokenPattern(pattern)).toThrow(message);
  });
});
