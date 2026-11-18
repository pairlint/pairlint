import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compositeOver,
  contrastRatio,
  formatRatio,
  meetsRatio,
  parseColor,
  type Rgba,
  relativeLuminance,
  requiredRatio,
  successCriterion,
} from "../src/index.js";

const rgba = (hex: string) => parseColor(hex).rgba;
const ratio = (a: string, b: string) => contrastRatio(rgba(a), rgba(b));

const channel = fc.double({ min: 0, max: 1, noNaN: true });
const opaque = fc.record({ r: channel, g: channel, b: channel, alpha: fc.constant(1) });
const translucent = fc.record({ r: channel, g: channel, b: channel, alpha: channel });

describe("contrast ratio reference values", () => {
  // Values match the WebAIM contrast checker and the WCAG understanding documents.
  it.each([
    ["#000000", "#ffffff", 21],
    ["#ffffff", "#ffffff", 1],
    ["#767676", "#ffffff", 4.54],
    ["#777777", "#ffffff", 4.47],
    ["#595959", "#ffffff", 7],
    ["#0000ff", "#ffffff", 8.59],
    ["#ff0000", "#ffffff", 3.99],
    ["#008000", "#ffffff", 5.13],
  ])("%s on %s is %s:1", (fg, bg, expected) => {
    expect(Math.floor(ratio(fg, bg) * 100) / 100).toBe(expected);
  });

  it("uses the WCAG relative luminance for pure channels", () => {
    expect(relativeLuminance(rgba("#ff0000"))).toBeCloseTo(0.2126, 10);
    expect(relativeLuminance(rgba("#00ff00"))).toBeCloseTo(0.7152, 10);
    expect(relativeLuminance(rgba("#0000ff"))).toBeCloseTo(0.0722, 10);
  });
});

describe("thresholds", () => {
  it("follows WCAG 2.2 for each use and level", () => {
    expect(requiredRatio("body", "AA")).toBe(4.5);
    expect(requiredRatio("body", "AAA")).toBe(7);
    expect(requiredRatio("large", "AA")).toBe(3);
    expect(requiredRatio("large", "AAA")).toBe(4.5);
    expect(requiredRatio("ui", "AA")).toBe(3);
    expect(requiredRatio("ui", "AAA")).toBe(3);
  });

  it("names the matching success criterion", () => {
    expect(successCriterion("body", "AA")).toEqual({ id: "1.4.3", level: "AA" });
    expect(successCriterion("large", "AAA")).toEqual({ id: "1.4.6", level: "AAA" });
    expect(successCriterion("ui", "AAA")).toEqual({ id: "1.4.11", level: "AA" });
  });

  it("never rounds a failing ratio up to a pass", () => {
    expect(meetsRatio(4.4999999, 4.5)).toBe(false);
    expect(meetsRatio(4.5, 4.5)).toBe(true);
    expect(formatRatio(4.4999999, 4.5)).toBe("4.49");
    expect(formatRatio(4.499999999999999, 4.5)).toBe("4.49");
    expect(formatRatio(4.4999)).toBe("4.49");
    expect(formatRatio(4.5)).toBe("4.50");
    expect(formatRatio(21)).toBe("21.00");
  });
});

describe("contrast properties", () => {
  it("is symmetric and between 1 and 21", () => {
    fc.assert(
      fc.property(opaque, opaque, (a, b) => {
        const forward = contrastRatio(a, b);
        expect(forward).toBe(contrastRatio(b, a));
        expect(forward).toBeGreaterThanOrEqual(1);
        expect(forward).toBeLessThanOrEqual(21 + 1e-9);
      }),
    );
  });

  it("is exactly 1 for a color against itself", () => {
    fc.assert(
      fc.property(opaque, (a) => {
        expect(contrastRatio(a, a)).toBe(1);
      }),
    );
  });

  it("gets no worse as text moves away from the background in lightness", () => {
    fc.assert(
      fc.property(channel, channel, (x, y) => {
        const [low, high] = x < y ? [x, y] : [y, x];
        const gray = (v: number): Rgba => ({ r: v, g: v, b: v, alpha: 1 });
        expect(contrastRatio(gray(0), gray(high))).toBeGreaterThanOrEqual(
          contrastRatio(gray(low), gray(high)) - 1e-12,
        );
      }),
    );
  });
});

describe("compositeOver", () => {
  it("returns the top color when it is opaque", () => {
    fc.assert(
      fc.property(opaque, translucent, (top, bottom) => {
        expect(compositeOver(top, bottom)).toEqual({ ...top, alpha: 1 });
      }),
    );
  });

  it("returns the bottom color when the top is fully transparent", () => {
    fc.assert(
      fc.property(channel, channel, channel, opaque, (r, g, b, bottom) => {
        const result = compositeOver({ r, g, b, alpha: 0 }, bottom);
        expect(result.r).toBeCloseTo(bottom.r, 12);
        expect(result.g).toBeCloseTo(bottom.g, 12);
        expect(result.b).toBeCloseTo(bottom.b, 12);
        expect(result.alpha).toBe(1);
      }),
    );
  });

  it("always produces an opaque result over an opaque bottom", () => {
    fc.assert(
      fc.property(translucent, opaque, (top, bottom) => {
        const result = compositeOver(top, bottom);
        expect(result.alpha).toBeCloseTo(1, 12);
        for (const value of [result.r, result.g, result.b]) {
          expect(value).toBeGreaterThanOrEqual(-1e-12);
          expect(value).toBeLessThanOrEqual(1 + 1e-12);
        }
      }),
    );
  });

  it("blends 50% black over white to mid gray", () => {
    const result = compositeOver({ r: 0, g: 0, b: 0, alpha: 0.5 }, rgba("#ffffff"));
    expect(result).toEqual({ r: 0.5, g: 0.5, b: 0.5, alpha: 1 });
  });

  it("handles two transparent layers", () => {
    expect(compositeOver(rgba("transparent"), rgba("transparent")).alpha).toBe(0);
  });
});
