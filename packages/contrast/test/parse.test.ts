import { describe, expect, it } from "vitest";
import { ColorParseError, parseColor, toHex } from "../src/index.js";

const hex = (input: unknown) => toHex(parseColor(input).rgba);

describe("parseColor with CSS strings", () => {
  it.each([
    ["#fff", "#ffffff"],
    ["#FFF", "#ffffff"],
    ["#1a2b3c", "#1a2b3c"],
    ["#1a2b3c80", "#1a2b3c80"],
    ["#0008", "#00000088"],
    ["  #ABCDEF  ", "#abcdef"],
    ["rgb(255, 0, 0)", "#ff0000"],
    ["rgba(255, 0, 0, 0.5)", "#ff000080"],
    ["rgb(255 0 0 / 50%)", "#ff000080"],
    ["rgb(100% 50% 0%)", "#ff8000"],
    ["rgb(300 -20 0)", "#ff0000"],
    ["hsl(0, 100%, 50%)", "#ff0000"],
    ["hsl(120deg 100% 25%)", "#008000"],
    ["hsl(0.5turn 100 50)", "#00ffff"],
    ["hsla(240, 100%, 50%, 0.25)", "#0000ff40"],
    ["oklch(0% 0 0)", "#000000"],
    ["oklch(100% 0 0)", "#ffffff"],
    ["oklch(0.6279 0.2577 29.23)", "#ff0000"],
    ["oklab(0.6279 0.2249 0.1258)", "#ff0000"],
    ["color(srgb 1 0 0)", "#ff0000"],
    ["color(srgb-linear 0.21586 0.21586 0.21586)", "#808080"],
    ["color(display-p3 0 0 0 / 0.5)", "#00000080"],
    ["transparent", "#00000000"],
    ["black", "#000000"],
    ["White", "#ffffff"],
  ])("parses %s", (input, expected) => {
    expect(hex(input)).toBe(expected);
  });

  it("maps out-of-gamut colors into sRGB and flags them", () => {
    const vivid = parseColor("color(display-p3 0 1 0)");
    expect(vivid.outOfGamut).toBe(true);
    for (const channel of [vivid.rgba.r, vivid.rgba.g, vivid.rgba.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
    expect(parseColor("oklch(0.7 0.4 150)").outOfGamut).toBe(true);
    expect(parseColor("#00ff00").outOfGamut).toBe(false);
    expect(parseColor("color(display-p3 1 1 1)").outOfGamut).toBe(false);
  });

  it.each([
    ["#ff", "not a valid hex color"],
    ["#gggggg", "not a valid hex color"],
    ["red", "not a color pairlint understands"],
    ["lab(50% 20 20)", "lab(), which pairlint does not support yet"],
    ["rgb(1, 2)", "should have 3 values, found 2"],
    ["rgb(1, 2, 3 / 0.5)", "mixes commas"],
    ["rgb(1 2 3 / 0.5 / 1)", 'more than one "/"'],
    ["rgb(1 2 three)", '"three" is not a valid value'],
    ["hsl(10px 50% 50%)", '"10px" is not a valid value'],
    ["color(rec2020 1 0 0)", "rec2020 color space"],
  ])("rejects %s", (input, message) => {
    expect(() => parseColor(input)).toThrow(ColorParseError);
    expect(() => parseColor(input)).toThrow(message);
  });

  it.each([42, null, ["#fff"], true])("rejects %j as a color", (input) => {
    expect(() => parseColor(input)).toThrow(/Expected a color/);
  });
});

describe("parseColor with DTCG color objects", () => {
  it.each([
    [{ colorSpace: "srgb", components: [1, 0, 0] }, "#ff0000"],
    [{ colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 }, "#00000080"],
    [{ colorSpace: "srgb", components: ["none", 1, "none"] }, "#00ff00"],
    [{ colorSpace: "hsl", components: [120, 100, 25] }, "#008000"],
    [{ colorSpace: "oklch", components: [1, 0, 0] }, "#ffffff"],
    [{ colorSpace: "oklab", components: [0, 0, 0] }, "#000000"],
    [{ colorSpace: "display-p3", components: [1, 1, 1] }, "#ffffff"],
    [{ colorSpace: "srgb-linear", components: [0, 0, 0] }, "#000000"],
    [{ colorSpace: "lab", components: [50, 0, 0], hex: "#777777" }, "#777777"],
  ])("parses %j", (input, expected) => {
    expect(hex(input)).toBe(expected);
  });

  it.each([
    [{ components: [1, 0, 0] }, 'needs a "colorSpace"'],
    [{ colorSpace: "srgb", components: [1, 0] }, "needs 3 components"],
    [{ colorSpace: "srgb", components: [1, "x", 0] }, 'must be numbers or "none"'],
    [{ colorSpace: "srgb", components: [1, 0, 0], alpha: "1" }, "alpha must be a number"],
    [{ colorSpace: "lab", components: [50, 0, 0] }, 'Color space "lab" is not supported yet'],
  ])("rejects %j", (input, message) => {
    expect(() => parseColor(input)).toThrow(message);
  });
});

describe("messages for values that are not one color", () => {
  it("calls a shorthand of several values not a color, quoting it whole", () => {
    const shorthand = "var(--Weight-Large) var(--Size-Large) / var(--Line-Height)";
    expect(() => parseColor(shorthand)).toThrow(
      `"${shorthand}" is not a color pairlint understands.`,
    );
  });

  it("quotes a bad value with its original case", () => {
    expect(() => parseColor("RGB(1 2 Three)")).toThrow(
      '"Three" is not a valid value in "RGB(1 2 Three)"',
    );
    expect(parseColor("RGB(255 0 0)").rgba).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(parseColor("oklch(60% 0.1 120DEG)").rgba.alpha).toBe(1);
  });
});
