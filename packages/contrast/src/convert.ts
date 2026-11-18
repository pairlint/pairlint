export type Vec3 = [number, number, number];

/** sRGB transfer function, sign-preserving so out-of-gamut values survive the round trip. */
export function gammaToLinear(channel: number): number {
  const abs = Math.abs(channel);
  const linear = abs <= 0.04045 ? abs / 12.92 : ((abs + 0.055) / 1.055) ** 2.4;
  return Math.sign(channel) * linear;
}

export function linearToGamma(channel: number): number {
  const abs = Math.abs(channel);
  const gamma = abs <= 0.0031308 ? abs * 12.92 : 1.055 * abs ** (1 / 2.4) - 0.055;
  return Math.sign(channel) * gamma;
}

export function gammaToLinearRgb(rgb: Vec3): Vec3 {
  return [gammaToLinear(rgb[0]), gammaToLinear(rgb[1]), gammaToLinear(rgb[2])];
}

export function linearToGammaRgb(rgb: Vec3): Vec3 {
  return [linearToGamma(rgb[0]), linearToGamma(rgb[1]), linearToGamma(rgb[2])];
}

/** CSS Color 4 hsl() to gamma-encoded sRGB. Saturation and lightness are 0..1. */
export function hslToRgb(hue: number, saturation: number, lightness: number): Vec3 {
  const h = ((hue % 360) + 360) % 360;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

export function oklchToOklab(lightness: number, chroma: number, hueDegrees: number): Vec3 {
  const h = (hueDegrees * Math.PI) / 180;
  return [lightness, chroma * Math.cos(h), chroma * Math.sin(h)];
}

export function oklabToLinearRgb([L, a, b]: Vec3): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function linearRgbToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

type Mat3 = [Vec3, Vec3, Vec3];

function multiply(matrix: Mat3, [x, y, z]: Vec3): Vec3 {
  const [r0, r1, r2] = matrix;
  return [
    r0[0] * x + r0[1] * y + r0[2] * z,
    r1[0] * x + r1[1] * y + r1[2] * z,
    r2[0] * x + r2[1] * y + r2[2] * z,
  ];
}

// Matrices from CSS Color 4, sample code section.
const LINEAR_P3_TO_XYZ: Mat3 = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];

const XYZ_TO_LINEAR_SRGB: Mat3 = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];

export function linearP3ToLinearRgb(p3: Vec3): Vec3 {
  return multiply(XYZ_TO_LINEAR_SRGB, multiply(LINEAR_P3_TO_XYZ, p3));
}
