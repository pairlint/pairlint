/** Gamma-encoded sRGB with every channel and alpha in 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

export interface ParsedColor {
  rgba: Rgba;
  /** True when the input was outside sRGB and had to be gamut mapped, so results are approximate. */
  outOfGamut: boolean;
}

export class ColorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ColorParseError";
  }
}

export function toHex({ r, g, b, alpha }: Rgba): string {
  const byte = (channel: number) =>
    Math.round(Math.min(1, Math.max(0, channel)) * 255)
      .toString(16)
      .padStart(2, "0");
  const hex = `#${byte(r)}${byte(g)}${byte(b)}`;
  return alpha < 1 ? `${hex}${byte(alpha)}` : hex;
}
