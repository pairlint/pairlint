import type { ContrastUse, WcagLevel } from "@pairlint/contrast";
import {
  compileTokenPattern,
  isPlainObject,
  JsonParseError,
  PatternError,
  type Position,
  parseJson,
  type SourceLocation,
  type TokenFormat,
  toPointer,
} from "@pairlint/tokens-core";
import { InputError } from "./errors.js";
import { closest } from "./suggest.js";

export const CONFIG_FILE = "pairlint.config.json";
export const DEFAULT_MODE = "default";
export const DEFAULT_BASE = "#ffffff";
export const DEFAULT_BASELINE = "pairlint.baseline.json";

export type PairUse = ContrastUse | "exempt";

export interface TokenSource {
  path: string;
  set?: string;
}

export interface ModeConfig {
  name: string;
  sources: TokenSource[];
  /** Color or "{alias}" that translucent backgrounds sit on. */
  base: string;
}

export interface PairRule {
  fg: string[];
  bg: string[];
  use: PairUse;
  min?: number;
  reason?: string;
  modes?: string[];
  location: SourceLocation;
}

export interface Config {
  file: string;
  level: WcagLevel;
  format: TokenFormat | "auto";
  modes: ModeConfig[];
  pairs: PairRule[];
  /** Baseline file, relative to the config. */
  baseline: string;
}

const TOP_LEVEL_KEYS = [
  "$schema",
  "level",
  "format",
  "tokens",
  "modes",
  "base",
  "pairs",
  "baseline",
];
const PAIR_KEYS = ["fg", "bg", "use", "min", "reason", "modes"];
const USES: readonly PairUse[] = ["body", "large", "ui", "exempt"];
const LEVELS: readonly WcagLevel[] = ["AA", "AAA"];
const FORMATS = ["auto", "dtcg", "tokens-studio"] as const;

/** Parses and validates pairlint.config.json. `file` is the display path used in messages. */
export function parseConfig(text: string, file: string): Config {
  let parsed: ReturnType<typeof parseJson>;
  try {
    parsed = parseJson(text, { jsonc: true });
  } catch (error) {
    if (error instanceof JsonParseError) {
      throw new InputError(`${file} is not valid JSON: ${error.reason}`, {
        file,
        line: error.line,
        column: error.column,
      });
    }
    throw error;
  }
  return new ConfigReader(file, parsed.positions).read(parsed.value);
}

class ConfigReader {
  constructor(
    private readonly file: string,
    private readonly positions: Map<string, Position>,
  ) {}

  read(root: unknown): Config {
    if (!isPlainObject(root)) this.fail([], "The config must be a JSON object");
    this.checkKeys(root, TOP_LEVEL_KEYS, []);

    const level = this.readEnum(root.level, LEVELS, ["level"], "AA");
    const format = this.readEnum(root.format, FORMATS, ["format"], "auto");
    const modes = this.readModes(root);
    this.applyBase(root.base, modes);

    if (root.pairs === undefined) {
      this.fail([], 'Add a "pairs" list that says which tokens are checked against which');
    }
    if (!Array.isArray(root.pairs) || root.pairs.length === 0) {
      this.fail(["pairs"], '"pairs" must be a list with at least one pair');
    }
    const modeNames = modes.map((mode) => mode.name);
    const pairs = root.pairs.map((pair, index) => this.readPair(pair, index, modeNames));

    let baseline = DEFAULT_BASELINE;
    if (root.baseline !== undefined) {
      if (typeof root.baseline !== "string" || root.baseline.trim() === "") {
        this.fail(["baseline"], '"baseline" must be a file path, like "pairlint.baseline.json"');
      }
      baseline = root.baseline;
    }

    return { file: this.file, level, format, modes, pairs, baseline };
  }

  private readModes(root: Record<string, unknown>): ModeConfig[] {
    const hasTokens = root.tokens !== undefined;
    const hasModes = root.modes !== undefined;
    if (hasTokens && hasModes) {
      this.fail(["modes"], 'Use either "tokens" (one mode) or "modes" (several), not both');
    }
    if (!hasTokens && !hasModes) {
      this.fail(
        [],
        'Say where your tokens are: "tokens": ["tokens.json"] or "modes": { "light": [...], "dark": [...] }',
      );
    }
    if (hasTokens) {
      return [
        {
          name: DEFAULT_MODE,
          sources: this.readSources(root.tokens, ["tokens"]),
          base: DEFAULT_BASE,
        },
      ];
    }
    if (!isPlainObject(root.modes) || Object.keys(root.modes).length === 0) {
      this.fail(["modes"], '"modes" must be an object like { "light": ["light.json"] }');
    }
    return Object.entries(root.modes).map(([name, sources]) => ({
      name,
      sources: this.readSources(sources, ["modes", name]),
      base: DEFAULT_BASE,
    }));
  }

  private readSources(value: unknown, path: string[]): TokenSource[] {
    if (typeof value === "string") value = [value];
    if (!Array.isArray(value) || value.length === 0) {
      this.fail(path, 'List at least one token file, for example ["tokens/light.json"]');
    }
    return value.map((entry, index) => {
      if (typeof entry !== "string" || entry.trim() === "") {
        this.fail([...path, String(index)], "Token file paths must be non-empty strings");
      }
      const hash = entry.indexOf("#");
      if (hash === -1) return { path: entry };
      const set = entry.slice(hash + 1);
      if (set === "")
        this.fail([...path, String(index)], `"${entry}" has "#" but no set name after it`);
      return { path: entry.slice(0, hash), set };
    });
  }

  private applyBase(value: unknown, modes: ModeConfig[]): void {
    if (value === undefined) return;
    if (typeof value === "string") {
      for (const mode of modes) mode.base = value;
      return;
    }
    if (!isPlainObject(value)) {
      this.fail(["base"], '"base" must be a color, or an object with a color per mode');
    }
    const names = modes.map((mode) => mode.name);
    for (const [name, base] of Object.entries(value)) {
      const mode = modes.find((m) => m.name === name);
      if (!mode) this.unknown(["base", name], name, names, "mode");
      if (typeof base !== "string") this.fail(["base", name], "A base color must be a string");
      mode.base = base;
    }
  }

  private readPair(value: unknown, index: number, modeNames: string[]): PairRule {
    const path = ["pairs", String(index)];
    if (!isPlainObject(value)) {
      this.fail(path, 'Each pair must be an object like { "fg": "text.*", "bg": "surface.*" }');
    }
    this.checkKeys(value, PAIR_KEYS, path);
    const use = this.readEnum(value.use, USES, [...path, "use"], "body");
    const rule: PairRule = {
      fg: this.readPatterns(value.fg, [...path, "fg"]),
      bg: this.readPatterns(value.bg, [...path, "bg"]),
      use,
      location: this.locate(path),
    };

    if (value.min !== undefined) {
      if (typeof value.min !== "number" || value.min < 1 || value.min > 21) {
        this.fail([...path, "min"], '"min" must be a contrast ratio between 1 and 21, like 4.5');
      }
      rule.min = value.min;
    }
    if (value.reason !== undefined) {
      if (typeof value.reason !== "string" || value.reason.trim() === "") {
        this.fail([...path, "reason"], '"reason" must be a short sentence');
      }
      rule.reason = value.reason;
    }
    if (use === "exempt" && rule.reason === undefined) {
      this.fail(path, 'Exempt pairs need a "reason", so the next person knows why');
    }
    if (value.modes !== undefined) {
      if (!Array.isArray(value.modes) || value.modes.length === 0) {
        this.fail([...path, "modes"], '"modes" must be a list of mode names');
      }
      rule.modes = value.modes.map((name, i) => {
        if (typeof name !== "string" || !modeNames.includes(name)) {
          this.unknown([...path, "modes", String(i)], String(name), modeNames, "mode");
        }
        return name;
      });
    }
    return rule;
  }

  private readPatterns(value: unknown, path: string[]): string[] {
    if (value === undefined) this.fail(path.slice(0, -1), `This pair needs "${path.at(-1)}"`);
    const list = typeof value === "string" ? [value] : value;
    if (!Array.isArray(list) || list.length === 0) {
      this.fail(path, "Give a token id or pattern, or a list of them");
    }
    return list.map((pattern, i) => {
      const itemPath = Array.isArray(value) ? [...path, String(i)] : path;
      if (typeof pattern !== "string") this.fail(itemPath, "Token patterns must be strings");
      try {
        compileTokenPattern(pattern);
      } catch (error) {
        if (error instanceof PatternError) this.fail(itemPath, error.message);
        throw error;
      }
      return pattern;
    });
  }

  private readEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    path: string[],
    fallback: T,
  ): T {
    if (value === undefined) return fallback;
    if (typeof value === "string" && (allowed as readonly string[]).includes(value))
      return value as T;
    const hint = typeof value === "string" ? closest(value, allowed) : undefined;
    this.fail(
      path,
      `"${String(value)}" is not allowed here. Use ${allowed.map((a) => `"${a}"`).join(", ")}${
        hint ? `. Did you mean "${hint}"?` : ""
      }`,
    );
  }

  private checkKeys(object: Record<string, unknown>, allowed: string[], path: string[]): void {
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key)) this.unknown([...path, key], key, allowed, "setting");
    }
  }

  private unknown(
    path: string[],
    name: string,
    candidates: readonly string[],
    kind: string,
  ): never {
    const hint = closest(name, candidates);
    this.fail(path, `Unknown ${kind} "${name}"${hint ? `. Did you mean "${hint}"?` : ""}`);
  }

  private locate(path: string[]): SourceLocation {
    const position = this.positions.get(toPointer(path)) ?? { line: 1, column: 1 };
    return { file: this.file, ...position };
  }

  private fail(path: string[], message: string): never {
    throw new InputError(message, this.locate(path));
  }
}
