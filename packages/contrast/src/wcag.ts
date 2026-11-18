import type { Rgba } from "./color.js";
import { gammaToLinear } from "./convert.js";

export type ContrastUse = "body" | "large" | "ui";
export type WcagLevel = "AA" | "AAA";

export interface SuccessCriterion {
  id: "1.4.3" | "1.4.6" | "1.4.11";
  level: WcagLevel;
}

/** Minimum contrast ratio WCAG 2.2 asks for, for this kind of content at this level. */
export function requiredRatio(use: ContrastUse, level: WcagLevel): number {
  switch (use) {
    case "body":
      return level === "AAA" ? 7 : 4.5;
    case "large":
      return level === "AAA" ? 4.5 : 3;
    case "ui":
      return 3;
  }
}

export function successCriterion(use: ContrastUse, level: WcagLevel): SuccessCriterion {
  if (use === "ui") return { id: "1.4.11", level: "AA" };
  return level === "AAA" ? { id: "1.4.6", level: "AAA" } : { id: "1.4.3", level: "AA" };
}

/** WCAG 2.x relative luminance. Alpha is ignored; composite first. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  return 0.2126 * gammaToLinear(r) + 0.7152 * gammaToLinear(g) + 0.0722 * gammaToLinear(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

/** WCAG thresholds are exact: 4.499:1 does not meet 4.5:1. */
export function meetsRatio(ratio: number, required: number): boolean {
  return ratio >= required;
}

/** Source-over compositing in gamma-encoded sRGB, the way browsers blend. */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const alpha = top.alpha + bottom.alpha * (1 - top.alpha);
  if (alpha === 0) return { r: 0, g: 0, b: 0, alpha: 0 };
  const blend = (t: number, b: number) =>
    (t * top.alpha + b * bottom.alpha * (1 - top.alpha)) / alpha;
  return {
    r: blend(top.r, bottom.r),
    g: blend(top.g, bottom.g),
    b: blend(top.b, bottom.b),
    alpha,
  };
}

/**
 * Formats a ratio for people, truncated to two decimals so a failing ratio never displays
 * as the threshold it missed. Pass the requirement to get extra precision right at the edge.
 */
export function formatRatio(ratio: number, required?: number): string {
  const truncated = Math.floor(ratio * 100) / 100;
  if (required !== undefined && ratio < required && truncated >= required) {
    return (Math.floor(ratio * 1e6) / 1e6).toFixed(6).replace(/0+$/, "");
  }
  return truncated.toFixed(2);
}
