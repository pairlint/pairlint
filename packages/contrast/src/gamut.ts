import {
  gammaToLinearRgb,
  linearRgbToOklab,
  linearToGammaRgb,
  oklabToLinearRgb,
  type Vec3,
} from "./convert.js";

const JND = 0.02;
const EPSILON = 0.0001;
const GAMUT_TOLERANCE = 1e-5;

export interface GamutResult {
  /** Gamma-encoded sRGB, every channel within 0..1. */
  rgb: Vec3;
  outOfGamut: boolean;
}

export function inSrgbGamut(rgb: Vec3): boolean {
  return rgb.every((c) => c >= -GAMUT_TOLERANCE && c <= 1 + GAMUT_TOLERANCE);
}

function clip(rgb: Vec3): Vec3 {
  return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function deltaEOK(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function oklabToGamma(lab: Vec3): Vec3 {
  return linearToGammaRgb(oklabToLinearRgb(lab));
}

function gammaToOklab(rgb: Vec3): Vec3 {
  return linearRgbToOklab(gammaToLinearRgb(rgb));
}

/**
 * Brings an OKLab color into sRGB with the CSS Color 4 gamut mapping algorithm:
 * reduce chroma at constant lightness and hue until clipping is visually negligible.
 */
export function mapOklabToSrgb(lab: Vec3): GamutResult {
  const direct = oklabToGamma(lab);
  if (inSrgbGamut(direct)) return { rgb: clip(direct), outOfGamut: false };

  const [lightness, a, b] = lab;
  if (lightness >= 1) return { rgb: [1, 1, 1], outOfGamut: true };
  if (lightness <= 0) return { rgb: [0, 0, 0], outOfGamut: true };

  const hue = Math.atan2(b, a);
  const atChroma = (chroma: number): Vec3 => [
    lightness,
    chroma * Math.cos(hue),
    chroma * Math.sin(hue),
  ];

  let clipped = clip(direct);
  if (deltaEOK(gammaToOklab(clipped), lab) < JND) return { rgb: clipped, outOfGamut: true };

  let min = 0;
  let max = Math.hypot(a, b);
  let minInGamut = true;
  while (max - min > EPSILON) {
    const chroma = (min + max) / 2;
    const current = atChroma(chroma);
    const currentRgb = oklabToGamma(current);
    if (minInGamut && inSrgbGamut(currentRgb)) {
      min = chroma;
      continue;
    }
    clipped = clip(currentRgb);
    const delta = deltaEOK(gammaToOklab(clipped), current);
    if (delta < JND) {
      if (JND - delta < EPSILON) return { rgb: clipped, outOfGamut: true };
      minInGamut = false;
      min = chroma;
    } else {
      max = chroma;
    }
  }
  return { rgb: clipped, outOfGamut: true };
}

/** Maps linear sRGB (possibly outside 0..1) into gamma-encoded sRGB. */
export function mapLinearRgbToSrgb(linear: Vec3): GamutResult {
  const gamma = linearToGammaRgb(linear);
  if (inSrgbGamut(gamma)) return { rgb: clip(gamma), outOfGamut: false };
  return mapOklabToSrgb(linearRgbToOklab(linear));
}
