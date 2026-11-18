import {
  adjustLightness,
  ColorParseError,
  type ContrastUse,
  compositeOver,
  contrastRatio,
  meetsRatio,
  oklabLightness,
  type ParsedColor,
  parseColor,
  type Rgba,
  requiredRatio,
  successCriterion,
  toHex,
  type WcagLevel,
} from "@pairlint/contrast";
import {
  aliasTarget,
  compileTokenPattern,
  isCssPath,
  type SourceLocation,
  TokenFileError,
  TokenSet,
  type TokenSetInput,
} from "@pairlint/tokens-core";
import {
  type Config,
  type ModeConfig,
  modeMatches,
  type PairRule,
  type PairUse,
} from "./config.js";
import { InputError } from "./errors.js";
import type { ReadFile } from "./files.js";

export const MAX_CHECKS = 1_000_000;

/** How far, in OKLab lightness (0 to 1), a background suggestion may move from the current shade. */
export const MAX_BACKGROUND_SHIFT = 0.2;

/** "baselined" is a failure accepted for now by an entry in the baseline file. */
export type PairStatus = "pass" | "fail" | "exempt" | "baselined" | "error";

export interface PairResult {
  mode: string;
  fg: string;
  bg: string;
  use: PairUse;
  status: PairStatus;
  /** Contrast after compositing. Missing when the pair is exempt or could not be checked. */
  ratio?: number;
  required?: number;
  /** WCAG success criterion, for example "1.4.3". Missing for custom minimums. */
  criterion?: string;
  criterionLevel?: WcagLevel;
  fgColor?: string;
  bgColor?: string;
  reason?: string;
  message?: string;
  fgLocation?: SourceLocation;
  bgLocation?: SourceLocation;
  /** For failing pairs, the smallest change that would make the pair pass, when one exists. */
  suggestion?: Suggestion;
  /** The baseline entry that covers this pair, when there is one. */
  baseline?: { reason: string; owner: string; expires?: string };
  /** True when the baseline entry has expired, so the pair fails again. */
  baselineExpired?: boolean;
}

/**
 * A way to fix a failing pair. "token" points the token at another shade from the same scale,
 * which keeps the design system intact. "color" is a new value with the lightness adjusted.
 */
export type Suggestion =
  | {
      kind: "token";
      side: "fg" | "bg";
      token: string;
      value: string;
      /** The suggested shade's own color, before blending. */
      color: string;
      ratio: number;
    }
  | { kind: "color"; side: "fg"; token: string; value: string; oklch: string; ratio: number };

export interface Warning {
  mode: string;
  message: string;
  location?: SourceLocation;
}

export interface CheckReport {
  level: WcagLevel;
  modes: string[];
  results: PairResult[];
  warnings: Warning[];
}

export interface CheckOptions {
  level?: WcagLevel;
  /** Check only these modes. */
  modes?: string[];
}

const STATUS_ORDER: Record<PairStatus, number> = {
  error: 0,
  fail: 1,
  baselined: 2,
  pass: 3,
  exempt: 4,
};

export function runCheck(
  config: Config,
  readFile: ReadFile,
  options: CheckOptions = {},
): CheckReport {
  const level = options.level ?? config.level;
  const modes = selectModes(config, options.modes);

  const results: PairResult[] = [];
  const warnings: Warning[] = [];
  let checks = 0;

  for (const mode of modes) {
    const checker = new ModeChecker(mode, loadTokens(mode, config, readFile), level, warnings);
    for (const [fg, bg, rule] of checker.expandPairs(config.pairs)) {
      checks++;
      if (checks > MAX_CHECKS) {
        throw new InputError(
          `The pairs in ${config.file} expand to more than ${MAX_CHECKS.toLocaleString("en-US")} checks. Narrow the patterns.`,
        );
      }
      results.push(checker.check(fg, bg, rule));
    }
  }

  return { level, modes: modes.map((mode) => mode.name), results, warnings };
}

export interface SideDetail {
  token: string;
  /** Alias chain from the token to its final value. */
  chain: readonly string[];
  /** The token's own color as hex, before blending. */
  color?: string;
  location?: SourceLocation;
  error?: string;
}

export interface Explanation {
  mode: string;
  /** False when no pair in the config covers these tokens, so they were checked as body text. */
  inPairs: boolean;
  result: PairResult;
  fg: SideDetail;
  bg: SideDetail;
  /** The base color translucent backgrounds sit on in this mode. */
  base?: string;
}

/** Checks one pair in each mode and returns everything that went into the result. */
export function explainPair(
  config: Config,
  readFile: ReadFile,
  fg: string,
  bg: string,
  options: CheckOptions = {},
): Explanation[] {
  const level = options.level ?? config.level;
  const modes = selectModes(config, options.modes);

  return modes.map((mode) => {
    const checker = new ModeChecker(mode, loadTokens(mode, config, readFile), level, []);
    const rule = checker.ruleFor(fg, bg, config.pairs);
    const effective: PairRule = rule ?? {
      fg: [fg],
      bg: [bg],
      use: "body",
      location: { file: config.file, line: 1, column: 1 },
    };
    const explanation: Explanation = {
      mode: mode.name,
      inPairs: rule !== undefined,
      result: checker.check(fg, bg, effective),
      fg: checker.describe(fg),
      bg: checker.describe(bg),
    };
    const base = checker.baseHex();
    if (base) explanation.base = base;
    return explanation;
  });
}

const STEP_WORDS = ["lightest", "lighter", "light", "medium", "dark", "darker", "darkest"];

/** Shade names: "500", "050", "A100", "light", "darker". */
function isStep(name: string): boolean {
  return /^[a-z]?\d+$/i.test(name) || STEP_WORDS.includes(name.toLowerCase());
}

/**
 * The scale a token belongs to, when its name ends in a shade step: "color.gray.500" is in
 * "color.gray", and "gray-500" (CSS) is in "gray". Hue names like "color.base.red" are not steps,
 * so their siblings are never offered as replacements.
 */
function scaleOf(id: string): { prefix: string; separator: "." | "-" } | undefined {
  for (const separator of [".", "-"] as const) {
    const at = id.lastIndexOf(separator);
    if (at > 0 && isStep(id.slice(at + 1))) return { prefix: id.slice(0, at), separator };
  }
  return undefined;
}

/** The modes -m picks. It takes full mode names and group values like "dark". */
export function selectModes(config: Config, names: readonly string[] | undefined): ModeConfig[] {
  if (!names) return config.modes;
  return config.modes.filter((mode) => names.some((name) => modeMatches(mode, name)));
}

function loadTokens(mode: ModeConfig, config: Config, readFile: ReadFile): TokenSet {
  const inputs: TokenSetInput[] = mode.sources.map((source) => {
    const input: TokenSetInput = { file: readFile(source.path), format: config.format };
    if (source.set !== undefined) input.set = source.set;
    return input;
  });
  try {
    return TokenSet.fromFiles(inputs);
  } catch (error) {
    if (error instanceof TokenFileError) throw new InputError(error.message, error.location);
    throw error;
  }
}

type ColorLookup =
  | { ok: true; color: ParsedColor; location: SourceLocation }
  | { ok: false; error: string; location?: SourceLocation };

class ModeChecker {
  private readonly colors = new Map<string, ColorLookup>();
  private readonly gamutWarned = new Set<string>();
  private base: Rgba | undefined;

  constructor(
    private readonly mode: ModeConfig,
    private readonly tokens: TokenSet,
    private readonly level: WcagLevel,
    private readonly warnings: Warning[],
  ) {
    for (const diagnostic of tokens.diagnostics) {
      const warning: Warning = { mode: mode.name, message: diagnostic.message };
      if (diagnostic.location) warning.location = diagnostic.location;
      warnings.push(warning);
    }
  }

  /** Expands rules into concrete pairs. An exempt rule wins over every other rule for the same pair. */
  *expandPairs(rules: readonly PairRule[]): Generator<[string, string, PairRule]> {
    const active = rules.filter(
      (rule) => !rule.modes || rule.modes.some((name) => modeMatches(this.mode, name)),
    );
    const expanded = active.map((rule) => ({
      rule,
      fg: this.matchColors(rule.fg, rule, "fg"),
      bg: this.matchColors(rule.bg, rule, "bg"),
    }));

    const exempt = new Set<string>();
    for (const { rule, fg, bg } of expanded) {
      if (rule.use !== "exempt") continue;
      for (const f of fg) for (const b of bg) exempt.add(`${f}\u0000${b}`);
    }

    const seen = new Set<string>();
    for (const { rule, fg, bg } of expanded) {
      for (const f of fg) {
        for (const b of bg) {
          if (f === b) continue;
          const pair = `${f}\u0000${b}`;
          if (rule.use !== "exempt" && exempt.has(pair)) continue;
          const key = `${pair}\u0000${rule.use}\u0000${rule.min ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          yield [f, b, rule];
        }
      }
    }
  }

  check(fg: string, bg: string, rule: PairRule): PairResult {
    const result: PairResult = { mode: this.mode.name, fg, bg, use: rule.use, status: "pass" };
    if (rule.reason !== undefined) result.reason = rule.reason;

    const fgColor = this.lookup(fg);
    const bgColor = this.lookup(bg);
    if (fgColor.location) result.fgLocation = fgColor.location;
    if (bgColor.location) result.bgLocation = bgColor.location;

    if (rule.use === "exempt") {
      result.status = "exempt";
      return result;
    }
    if (!fgColor.ok || !bgColor.ok) {
      result.status = "error";
      result.message = !fgColor.ok ? fgColor.error : (bgColor as { error: string }).error;
      return result;
    }

    let base: Rgba;
    try {
      base = this.baseColor();
    } catch (error) {
      if (error instanceof InputError) {
        result.status = "error";
        result.message = error.message;
        return result;
      }
      throw error;
    }

    const background = compositeOver(bgColor.color.rgba, base);
    const foreground = compositeOver(fgColor.color.rgba, background);
    const ratio = contrastRatio(foreground, background);
    const required = rule.min ?? requiredRatio(rule.use as ContrastUse, this.level);

    result.ratio = ratio;
    result.required = required;
    if (rule.min === undefined) {
      const criterion = successCriterion(rule.use as ContrastUse, this.level);
      result.criterion = criterion.id;
      result.criterionLevel = criterion.level;
    }
    result.fgColor = toHex(foreground);
    result.bgColor = toHex(background);
    result.status = meetsRatio(ratio, required) ? "pass" : "fail";
    if (result.status === "fail") {
      const suggestion = this.suggest(
        fg,
        bg,
        fgColor.color.rgba,
        bgColor.color.rgba,
        base,
        required,
      );
      if (suggestion) result.suggestion = suggestion;
    }
    return result;
  }

  describe(id: string): SideDetail {
    const resolution = this.tokens.resolve(id);
    const detail: SideDetail = { token: id, chain: resolution.chain };
    const lookup = this.lookup(id);
    if (lookup.location) detail.location = lookup.location;
    if (lookup.ok) detail.color = toHex(lookup.color.rgba);
    else detail.error = lookup.error;
    return detail;
  }

  /** The finished base color for translucent backgrounds, or undefined when it is invalid. */
  baseHex(): string | undefined {
    try {
      return toHex(this.baseColor());
    } catch (error) {
      if (error instanceof InputError) return undefined;
      throw error;
    }
  }

  /** Finds the rule that covers this pair, the same way a full check would. */
  ruleFor(fg: string, bg: string, rules: readonly PairRule[]): PairRule | undefined {
    for (const [f, b, rule] of this.expandPairs(rules)) {
      if (f === fg && b === bg) return rule;
    }
    return undefined;
  }

  private suggest(
    fg: string,
    bg: string,
    fgRgba: Rgba,
    bgRgba: Rgba,
    base: Rgba,
    required: number,
  ): Suggestion | undefined {
    const background = compositeOver(bgRgba, base);
    const fromFgScale = this.nearestInScale(fg, "fg", required, (candidate) =>
      contrastRatio(compositeOver(candidate, background), background),
    );
    if (fromFgScale) return fromFgScale;

    const bgRatio = (candidate: Rgba) => {
      const next = compositeOver(candidate, base);
      return contrastRatio(compositeOver(fgRgba, next), next);
    };
    // A background is shared by many pairs, so only nudge it. Turning a dark surface light to
    // fix one pair would break the theme.
    const fromBgScale = this.nearestInScale(bg, "bg", required, bgRatio, MAX_BACKGROUND_SHIFT);
    if (fromBgScale) return fromBgScale;

    const fix = adjustLightness(fgRgba, background, required);
    if (!fix) return this.nearestInScale(bg, "bg", required, bgRatio);
    return {
      kind: "color",
      side: "fg",
      token: fg,
      value: fix.hex,
      oklch: fix.oklch,
      ratio: fix.ratio,
    };
  }

  /**
   * When a token is an alias into a scale, like {color.gray.500}, looks for the passing sibling
   * (color.gray.*) closest in lightness to the current one.
   */
  private nearestInScale(
    id: string,
    side: "fg" | "bg",
    required: number,
    ratioOf: (candidate: Rgba) => number,
    maxShift = Number.POSITIVE_INFINITY,
  ): Suggestion | undefined {
    const resolution = this.tokens.resolve(id);
    if (!resolution.ok || resolution.chain.length < 2) return undefined;
    const target = resolution.chain[resolution.chain.length - 1] as string;
    const scale = scaleOf(target);
    if (!scale) return undefined;
    const current = this.lookup(target);
    if (!current.ok) return undefined;
    const currentLightness = oklabLightness(current.color.rgba);

    let best: { id: string; color: string; ratio: number; distance: number } | undefined;
    for (const candidate of this.tokens.match(`${scale.prefix}${scale.separator}*`)) {
      if (candidate === target || !isStep(candidate.slice(scale.prefix.length + 1))) continue;
      const lookup = this.lookup(candidate);
      if (!lookup.ok) continue;
      const ratio = ratioOf(lookup.color.rgba);
      if (ratio < required) continue;
      const distance = Math.abs(oklabLightness(lookup.color.rgba) - currentLightness);
      if (distance > maxShift) continue;
      if (!best || distance < best.distance) {
        best = { id: candidate, color: toHex(lookup.color.rgba), ratio, distance };
      }
    }
    if (!best) return undefined;
    const css = isCssPath(resolution.token.source.file);
    return {
      kind: "token",
      side,
      token: id,
      value: css ? `var(--${best.id})` : `{${best.id}}`,
      color: best.color,
      ratio: best.ratio,
    };
  }

  private matchColors(patterns: readonly string[], rule: PairRule, side: "fg" | "bg"): string[] {
    const ids = new Set<string>();
    for (const pattern of patterns) {
      const matcher = compileTokenPattern(pattern);
      let matched = 0;
      for (const id of this.tokens.ids()) {
        if (!matcher(id)) continue;
        const resolution = this.tokens.resolve(id);
        if (resolution.ok && resolution.type !== undefined && resolution.type !== "color") continue;
        ids.add(id);
        matched++;
      }
      if (matched === 0) {
        throw new InputError(
          `"${pattern}" (${side}) matched no color tokens in mode "${this.mode.name}"`,
          rule.location,
        );
      }
    }
    return [...ids].sort();
  }

  private lookup(id: string): ColorLookup {
    const cached = this.colors.get(id);
    if (cached) return cached;
    const lookup = this.lookupUncached(id);
    this.colors.set(id, lookup);
    return lookup;
  }

  private lookupUncached(id: string): ColorLookup {
    const resolution = this.tokens.resolve(id);
    const location = this.tokens.get(id)?.source;
    if (!resolution.ok) {
      return location
        ? { ok: false, error: resolution.error, location }
        : { ok: false, error: resolution.error };
    }
    try {
      const color = parseColor(resolution.value);
      if (color.outOfGamut && !this.gamutWarned.has(id)) {
        this.gamutWarned.add(id);
        this.warnings.push({
          mode: this.mode.name,
          message: `${id} is outside the sRGB gamut, so results that use it are approximate`,
          location: resolution.token.source,
        });
      }
      return { ok: true, color, location: resolution.token.source };
    } catch (error) {
      if (error instanceof ColorParseError) {
        return { ok: false, error: `${id}: ${error.message}`, location: resolution.token.source };
      }
      throw error;
    }
  }

  private baseColor(): Rgba {
    if (this.base) return this.base;
    const source = this.mode.base;
    const alias = aliasTarget(source);
    let parsed: ParsedColor;
    try {
      if (alias !== undefined) {
        const lookup = this.lookup(alias);
        if (!lookup.ok)
          throw new InputError(`Base color for mode "${this.mode.name}": ${lookup.error}`);
        parsed = lookup.color;
      } else {
        parsed = parseColor(source);
      }
    } catch (error) {
      if (error instanceof ColorParseError) {
        throw new InputError(`Base color for mode "${this.mode.name}": ${error.message}`);
      }
      throw error;
    }
    const white: Rgba = { r: 1, g: 1, b: 1, alpha: 1 };
    this.base = parsed.rgba.alpha < 1 ? compositeOver(parsed.rgba, white) : parsed.rgba;
    return this.base;
  }
}

export function sortResults(
  results: readonly PairResult[],
  modeOrder: readonly string[],
): PairResult[] {
  return [...results].sort(
    (a, b) =>
      modeOrder.indexOf(a.mode) - modeOrder.indexOf(b.mode) ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      compareText(a.fg, b.fg) ||
      compareText(a.bg, b.bg) ||
      compareText(a.use, b.use),
  );
}

// Plain code-unit order, so output is identical on every machine regardless of locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function exitCode(report: { results: readonly PairResult[] }): 0 | 1 | 2 {
  if (report.results.some((result) => result.status === "error")) return 2;
  if (report.results.some((result) => result.status === "fail")) return 1;
  return 0;
}
