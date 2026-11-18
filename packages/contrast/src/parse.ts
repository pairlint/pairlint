import { ColorParseError, type ParsedColor } from "./color.js";
import {
  gammaToLinearRgb,
  hslToRgb,
  linearP3ToLinearRgb,
  oklchToOklab,
  type Vec3,
} from "./convert.js";
import { mapLinearRgbToSrgb, mapOklabToSrgb } from "./gamut.js";

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const FUNCTION = /^([a-z-]+)\((.*)\)$/s;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/;
const HUE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/;

const SUPPORTED =
  "Use hex, rgb(), hsl(), oklch(), oklab() or color() with srgb, srgb-linear or display-p3.";

/** Parses a CSS color string or a DTCG color object. */
export function parseColor(input: unknown): ParsedColor {
  if (typeof input === "string") return parseCssColor(input);
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return parseDtcgColor(input as Record<string, unknown>);
  }
  throw new ColorParseError(`Expected a color but found ${describe(input)}`);
}

export function parseCssColor(input: string): ParsedColor {
  const text = input.trim().toLowerCase();
  if (text.startsWith("#")) return parseHex(text, input);
  if (text === "transparent") return srgb([0, 0, 0], 0);
  if (text === "black") return srgb([0, 0, 0], 1);
  if (text === "white") return srgb([1, 1, 1], 1);

  const match = FUNCTION.exec(text);
  if (!match)
    throw new ColorParseError(`"${input}" is not a color pairlint understands. ${SUPPORTED}`);
  const name = match[1] ?? "";
  const { values, alpha } = splitArguments(match[2] ?? "", input);
  const alphaValue = alpha === undefined ? 1 : parseAlpha(alpha, input);

  switch (name) {
    case "rgb":
    case "rgba": {
      expectCount(values, 3, input);
      const rgb = values.map((v) => clamp01(parseNumberOrPercent(v, 255, input) / 255)) as Vec3;
      return srgb(rgb, alphaValue);
    }
    case "hsl":
    case "hsla": {
      expectCount(values, 3, input);
      const [h, s, l] = values as [string, string, string];
      return srgb(
        hslToRgb(
          parseHue(h, input),
          clamp01(parseNumberOrPercent(s, 100, input) / 100),
          clamp01(parseNumberOrPercent(l, 100, input) / 100),
        ),
        alphaValue,
      );
    }
    case "oklch": {
      expectCount(values, 3, input);
      const [l, c, h] = values as [string, string, string];
      const lightness = clamp01(parseNumberOrPercent(l, 1, input));
      const chroma = Math.max(0, parseNumberOrPercent(c, 0.4, input));
      return fromOklab(oklchToOklab(lightness, chroma, parseHue(h, input)), alphaValue);
    }
    case "oklab": {
      expectCount(values, 3, input);
      const [l, a, b] = values as [string, string, string];
      return fromOklab(
        [
          clamp01(parseNumberOrPercent(l, 1, input)),
          parseNumberOrPercent(a, 0.4, input),
          parseNumberOrPercent(b, 0.4, input),
        ],
        alphaValue,
      );
    }
    case "color": {
      expectCount(values, 4, input);
      const [space, ...rest] = values as [string, string, string, string];
      const components = rest.map((v) => parseNumberOrPercent(v, 1, input)) as Vec3;
      return fromSpace(space, components, alphaValue, input);
    }
    default:
      throw new ColorParseError(
        `"${input}" uses ${name}(), which pairlint does not support yet. ${SUPPORTED}`,
      );
  }
}

function parseDtcgColor(object: Record<string, unknown>): ParsedColor {
  const { colorSpace, components, alpha, hex } = object;
  if (typeof colorSpace !== "string" || !Array.isArray(components)) {
    throw new ColorParseError(
      'A color object needs a "colorSpace" string and a "components" array (DTCG color format)',
    );
  }
  if (components.length !== 3) {
    throw new ColorParseError(
      `A ${colorSpace} color needs 3 components, found ${components.length}`,
    );
  }
  const values = components.map((component) => {
    if (component === "none") return 0;
    if (typeof component === "number" && Number.isFinite(component)) return component;
    throw new ColorParseError(
      `Color components must be numbers or "none", found ${describe(component)}`,
    );
  }) as Vec3;
  let alphaValue = 1;
  if (alpha !== undefined) {
    if (typeof alpha !== "number" || !Number.isFinite(alpha)) {
      throw new ColorParseError(`Color alpha must be a number, found ${describe(alpha)}`);
    }
    alphaValue = clamp01(alpha);
  }

  switch (colorSpace) {
    case "srgb":
    case "srgb-linear":
    case "display-p3":
      return fromSpace(colorSpace, values, alphaValue, colorSpace);
    case "hsl":
      return srgb(
        hslToRgb(values[0], clamp01(values[1] / 100), clamp01(values[2] / 100)),
        alphaValue,
      );
    case "oklab":
      return fromOklab([clamp01(values[0]), values[1], values[2]], alphaValue);
    case "oklch":
      return fromOklab(
        oklchToOklab(clamp01(values[0]), Math.max(0, values[1]), values[2]),
        alphaValue,
      );
    default:
      if (typeof hex === "string") {
        const parsed = parseHex(hex.trim().toLowerCase(), hex);
        return { rgba: { ...parsed.rgba, alpha: alphaValue }, outOfGamut: parsed.outOfGamut };
      }
      throw new ColorParseError(
        `Color space "${colorSpace}" is not supported yet. Add a "hex" fallback or use srgb, srgb-linear, display-p3, hsl, oklab or oklch.`,
      );
  }
}

function fromSpace(space: string, components: Vec3, alpha: number, input: string): ParsedColor {
  switch (space) {
    case "srgb":
      return fromLinear(gammaToLinearRgb(components), alpha);
    case "srgb-linear":
      return fromLinear(components, alpha);
    case "display-p3":
      return fromLinear(linearP3ToLinearRgb(gammaToLinearRgb(components)), alpha);
    default:
      throw new ColorParseError(
        `"${input}" uses the ${space} color space, which pairlint does not support yet. ${SUPPORTED}`,
      );
  }
}

function fromLinear(linear: Vec3, alpha: number): ParsedColor {
  const { rgb, outOfGamut } = mapLinearRgbToSrgb(linear);
  return { rgba: { r: rgb[0], g: rgb[1], b: rgb[2], alpha }, outOfGamut };
}

function fromOklab(lab: Vec3, alpha: number): ParsedColor {
  const { rgb, outOfGamut } = mapOklabToSrgb(lab);
  return { rgba: { r: rgb[0], g: rgb[1], b: rgb[2], alpha }, outOfGamut };
}

function srgb(rgb: Vec3, alpha: number): ParsedColor {
  return {
    rgba: { r: clamp01(rgb[0]), g: clamp01(rgb[1]), b: clamp01(rgb[2]), alpha: clamp01(alpha) },
    outOfGamut: false,
  };
}

function parseHex(text: string, input: string): ParsedColor {
  if (!HEX.test(text)) throw new ColorParseError(`"${input}" is not a valid hex color`);
  let digits = text.slice(1);
  if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
  const byte = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16) / 255;
  return srgb([byte(0), byte(2), byte(4)], digits.length === 8 ? byte(6) : 1);
}

function splitArguments(body: string, input: string): { values: string[]; alpha?: string } {
  const trimmed = body.trim();
  if (trimmed.includes(",")) {
    if (trimmed.includes("/")) {
      throw new ColorParseError(`"${input}" mixes commas and "/". Use one syntax or the other.`);
    }
    const parts = trimmed.split(",").map((part) => part.trim());
    if (parts.length === 4) {
      return { values: parts.slice(0, 3), alpha: parts[3] as string };
    }
    return { values: parts };
  }
  const slash = trimmed.split("/");
  if (slash.length > 2) throw new ColorParseError(`"${input}" has more than one "/"`);
  const values = (slash[0] ?? "").trim().split(/\s+/).filter(Boolean);
  const alpha = slash[1]?.trim();
  return alpha === undefined ? { values } : { values, alpha };
}

function expectCount(values: string[], count: number, input: string): void {
  if (values.length !== count) {
    throw new ColorParseError(`"${input}" should have ${count} values, found ${values.length}`);
  }
}

function parseNumberOrPercent(token: string, percentReference: number, input: string): number {
  if (token === "none") return 0;
  if (token.endsWith("%")) {
    const number = token.slice(0, -1);
    if (!NUMBER.test(number)) throw invalidValue(token, input);
    return (Number(number) / 100) * percentReference;
  }
  if (!NUMBER.test(token)) throw invalidValue(token, input);
  return Number(token);
}

function parseHue(token: string, input: string): number {
  if (token === "none") return 0;
  const match = HUE.exec(token);
  if (!match) throw invalidValue(token, input);
  const value = Number(match[1]);
  switch (match[2]) {
    case "grad":
      return value * 0.9;
    case "rad":
      return (value * 180) / Math.PI;
    case "turn":
      return value * 360;
    default:
      return value;
  }
}

function parseAlpha(token: string, input: string): number {
  return clamp01(parseNumberOrPercent(token, 1, input));
}

function invalidValue(token: string, input: string): ColorParseError {
  return new ColorParseError(`"${token}" is not a valid value in "${input}"`);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "object") return "an object";
  return String(value);
}
