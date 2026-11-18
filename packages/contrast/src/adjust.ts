import type { Rgba } from "./color.js";
import { gammaToLinearRgb, linearRgbToOklab, type Vec3 } from "./convert.js";
import { mapOklabToSrgb } from "./gamut.js";
import { parseCssColor } from "./parse.js";
import { compositeOver, contrastRatio } from "./wcag.js";

export interface LightnessFix {
  /** The adjusted color as hex, alpha kept from the original. */
  hex: string;
  /** The same color as an oklch() string, for design tools that work in OKLCH. */
  oklch: string;
  /** Contrast of the adjusted color, after blending, as hex will render it. */
  ratio: number;
  /** How far OKLCH lightness moved, from 0 to 1. */
  lightnessChange: number;
}

const SEARCH_STEPS = 40;

/**
 * Finds the smallest change to the foreground's OKLCH lightness that reaches the required ratio
 * against an opaque background, keeping hue, chroma and alpha. Returns undefined when no lightness
 * can reach it, for example a very translucent foreground.
 */
export function adjustLightness(
  foreground: Rgba,
  background: Rgba,
  required: number,
): LightnessFix | undefined {
  const [lightness, a, b] = toOklab(foreground);
  const candidates = [searchToward(0), searchToward(1)].filter(
    (fix): fix is LightnessFix => fix !== undefined,
  );
  candidates.sort((x, y) => x.lightnessChange - y.lightnessChange);
  return candidates[0];

  function searchToward(target: 0 | 1): LightnessFix | undefined {
    if (!passes(target)) return undefined;
    // Binary search between the current lightness (fails) and the target (passes).
    let failing = lightness;
    let passing: number = target;
    for (let step = 0; step < SEARCH_STEPS; step++) {
      const middle = (failing + passing) / 2;
      if (passes(middle)) passing = middle;
      else failing = middle;
    }
    // Hex rounding can push a color just below the line, so step until the hex itself passes.
    for (let nudge = 0; nudge <= 100; nudge++) {
      const l = clamp01(passing + (target === 0 ? -nudge : nudge) * 0.001);
      const fix = build(l);
      if (fix.ratio >= required) return fix;
      if (l === target) break;
    }
    return undefined;
  }

  function passes(l: number): boolean {
    return ratioFor(colorAt(l)) >= required;
  }

  function colorAt(l: number): Rgba {
    const { rgb } = mapOklabToSrgb([l, a, b]);
    return { r: rgb[0], g: rgb[1], b: rgb[2], alpha: foreground.alpha };
  }

  function ratioFor(color: Rgba): number {
    return contrastRatio(compositeOver(color, background), background);
  }

  function build(l: number): LightnessFix {
    const color = colorAt(l);
    const hex = toHexWithAlpha(color);
    const rendered = parseCssColor(hex).rgba;
    const chroma = Math.hypot(a, b);
    const hue = chroma < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    const alpha = foreground.alpha < 1 ? ` / ${round(foreground.alpha, 3)}` : "";
    return {
      hex,
      oklch: `oklch(${round(l * 100, 1)}% ${round(chroma, 3)} ${round(hue, 1)}${alpha})`,
      ratio: ratioFor(rendered),
      lightnessChange: Math.abs(l - lightness),
    };
  }
}

/** OKLCH lightness of a color, from 0 to 1. Useful for finding the nearest shade in a scale. */
export function oklabLightness(color: Rgba): number {
  return toOklab(color)[0];
}

function toOklab(color: Rgba): Vec3 {
  return linearRgbToOklab(gammaToLinearRgb([color.r, color.g, color.b]));
}

function toHexWithAlpha(color: Rgba): string {
  const byte = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, "0");
  const hex = `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
  return color.alpha < 1 ? `${hex}${byte(color.alpha)}` : hex;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
