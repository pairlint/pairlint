import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  adjustLightness,
  compositeOver,
  contrastRatio,
  oklabLightness,
  parseColor,
  type Rgba,
} from "../src/index.js";

const rgba = (input: string) => parseColor(input).rgba;
const opaqueHex = fc
  .tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  )
  .map(([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);

const renderedRatio = (hex: string, background: Rgba) =>
  contrastRatio(compositeOver(rgba(hex), background), background);

describe("adjustLightness", () => {
  it("darkens gray text on white just enough to pass", () => {
    const fix = adjustLightness(rgba("#9aa0a6"), rgba("#ffffff"), 4.5);
    expect(fix).toBeDefined();
    if (!fix) return;
    expect(fix.ratio).toBeGreaterThanOrEqual(4.5);
    expect(fix.ratio).toBeLessThan(4.6);
    expect(oklabLightness(rgba(fix.hex))).toBeLessThan(oklabLightness(rgba("#9aa0a6")));
    expect(fix.oklch).toMatch(/^oklch\(\d+(\.\d)?% [\d.]+ [\d.]+\)$/);
  });

  it("lightens text on a dark background", () => {
    const fix = adjustLightness(rgba("#5f6368"), rgba("#121212"), 4.5);
    expect(fix && oklabLightness(rgba(fix.hex))).toBeGreaterThan(oklabLightness(rgba("#5f6368")));
  });

  it("keeps the hue of colored text", () => {
    const fix = adjustLightness(rgba("oklch(0.7 0.15 250)"), rgba("#ffffff"), 4.5);
    expect(fix?.oklch).toMatch(/ 0\.15 25\d(\.\d)?\)$/);
  });

  it("keeps alpha and accounts for blending", () => {
    const background = rgba("#ffffff");
    const fix = adjustLightness(rgba("rgb(0 0 255 / 80%)"), background, 7);
    expect(fix?.hex).toMatch(/cc$/);
    expect(fix?.oklch).toContain("/ 0.8");
    if (fix) expect(renderedRatio(fix.hex, background)).toBeGreaterThanOrEqual(4.5);
  });

  it("returns nothing when no lightness can reach the ratio", () => {
    expect(adjustLightness(rgba("rgb(0 0 0 / 10%)"), rgba("#ffffff"), 4.5)).toBeUndefined();
    expect(adjustLightness(rgba("#777777"), rgba("#777777"), 21)).toBeUndefined();
  });

  it("always returns a hex value that really passes", () => {
    fc.assert(
      fc.property(opaqueHex, opaqueHex, fc.constantFrom(3, 4.5, 7), (fg, bg, required) => {
        const background = rgba(bg);
        const fix = adjustLightness(rgba(fg), background, required);
        if (fix) {
          expect(fix.ratio).toBeGreaterThanOrEqual(required);
          expect(renderedRatio(fix.hex, background)).toBeGreaterThanOrEqual(required);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("finds a fix whenever pure black or white text would pass", () => {
    fc.assert(
      fc.property(opaqueHex, opaqueHex, (fg, bg) => {
        const background = rgba(bg);
        const best = Math.max(
          contrastRatio(rgba("#000000"), background),
          contrastRatio(rgba("#ffffff"), background),
        );
        fc.pre(best >= 4.6);
        expect(adjustLightness(rgba(fg), background, 4.5)).toBeDefined();
      }),
      { numRuns: 300 },
    );
  });
});
