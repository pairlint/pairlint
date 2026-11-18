import {
  ColorParseError,
  type ContrastUse,
  compositeOver,
  contrastRatio,
  meetsRatio,
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
  type SourceLocation,
  TokenFileError,
  TokenSet,
  type TokenSetInput,
} from "@pairlint/tokens-core";
import type { Config, ModeConfig, PairRule, PairUse } from "./config.js";
import { InputError } from "./errors.js";
import type { ReadFile } from "./files.js";

export const MAX_CHECKS = 1_000_000;

export type PairStatus = "pass" | "fail" | "exempt" | "error";

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
}

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

const STATUS_ORDER: Record<PairStatus, number> = { error: 0, fail: 1, pass: 2, exempt: 3 };

export function runCheck(
  config: Config,
  readFile: ReadFile,
  options: CheckOptions = {},
): CheckReport {
  const level = options.level ?? config.level;
  const modes = options.modes
    ? config.modes.filter((mode) => options.modes?.includes(mode.name))
    : config.modes;

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
    const active = rules.filter((rule) => !rule.modes || rule.modes.includes(this.mode.name));
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
    return result;
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

export function exitCode(report: CheckReport): 0 | 1 | 2 {
  if (report.results.some((result) => result.status === "error")) return 2;
  if (report.results.some((result) => result.status === "fail")) return 1;
  return 0;
}
