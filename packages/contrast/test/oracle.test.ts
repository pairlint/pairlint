import { converter, differenceEuclidean, toGamut, wcagContrast } from "culori";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseColor, toHex } from "../src/index.js";

// culori is an independent, widely used implementation. These tests compare against it
// across many random colors so a wrong matrix or transfer function cannot slip through.

const toRgb = converter("rgb");
// @types/culori lags the runtime here: culori 4 takes (dest, mode, delta, jnd).
const toGamutWithDelta = toGamut as unknown as (
  dest: string,
  mode: string,
  delta: ReturnType<typeof differenceEuclidean>,
  jnd: number,
) => ReturnType<typeof toGamut>;
const mapToSrgb = toGamutWithDelta("rgb", "oklch", differenceEuclidean("oklab"), 0.02);

const byte = fc.integer({ min: 0, max: 255 });
const hexColor = fc
  .tuple(byte, byte, byte)
  .map(([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);

const expectClose = (
  actual: { r: number; g: number; b: number },
  expected: { r: number; g: number; b: number },
  tolerance: number,
) => {
  expect(Math.abs(actual.r - expected.r)).toBeLessThan(tolerance);
  expect(Math.abs(actual.g - expected.g)).toBeLessThan(tolerance);
  expect(Math.abs(actual.b - expected.b)).toBeLessThan(tolerance);
};

describe("agreement with culori", () => {
  it("computes the same WCAG contrast for any two hex colors", () => {
    fc.assert(
      fc.property(hexColor, hexColor, (a, b) => {
        const ours = contrastRatio(parseColor(a).rgba, parseColor(b).rgba);
        expect(ours).toBeCloseTo(wcagContrast(a, b), 10);
      }),
      { numRuns: 2000 },
    );
  });

  it("converts in-gamut OKLCH the same way", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        (l, c, h) => {
          const expected = toRgb({ mode: "oklch", l, c, h });
          const inGamut = [expected.r, expected.g, expected.b].every((v) => v >= 0 && v <= 1);
          fc.pre(inGamut);
          const ours = parseColor(`oklch(${l} ${c} ${h})`);
          expect(ours.outOfGamut).toBe(false);
          expectClose(ours.rgba, expected, 1e-6);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("gamut maps out-of-gamut OKLCH like CSS Color 4", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.double({ min: 0.1, max: 0.5, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        (l, c, h) => {
          const raw = toRgb({ mode: "oklch", l, c, h });
          fc.pre([raw.r, raw.g, raw.b].some((v) => v < -0.001 || v > 1.001));
          const expected = mapToSrgb({ mode: "oklch", l, c, h });
          const ours = parseColor(`oklch(${l} ${c} ${h})`);
          expect(ours.outOfGamut).toBe(true);
          expectClose(ours.rgba, toRgb(expected), 0.004);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("converts display-p3 the same way", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (r, g, b) => {
          const expected = toRgb({ mode: "p3", r, g, b });
          fc.pre([expected.r, expected.g, expected.b].every((v) => v >= 0 && v <= 1));
          expectClose(parseColor(`color(display-p3 ${r} ${g} ${b})`).rgba, expected, 1e-6);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("converts hsl the same way", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (h, s, l) => {
          const expected = toRgb({ mode: "hsl", h, s, l });
          expectClose(parseColor(`hsl(${h} ${s * 100}% ${l * 100}%)`).rgba, expected, 1e-9);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("round-trips hex through our parser", () => {
    fc.assert(
      fc.property(hexColor, (value) => {
        expect(toHex(parseColor(value).rgba)).toBe(value);
      }),
    );
  });
});
