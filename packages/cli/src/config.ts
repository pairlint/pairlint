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
  /** For modes built from groups, the group values joined with "/", like "acme/dark". */
  name: string;
  /** Group name to value, for modes built from groups, like { brand: "acme", theme: "dark" }. */
  axes?: Record<string, string>;
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

/** Every top-level config setting. schema.json must list the same ones. */
export const CONFIG_KEYS: readonly string[] = [
  "$schema",
  "level",
  "format",
  "tokens",
  "modes",
  "base",
  "pairs",
  "baseline",
];
/** Every setting a pair accepts. */
export const PAIR_KEYS: readonly string[] = ["fg", "bg", "use", "min", "reason", "modes"];
const USES: readonly PairUse[] = ["body", "large", "ui", "exempt"];
const LEVELS: readonly WcagLevel[] = ["AA", "AAA"];
const FORMATS = ["auto", "dtcg", "tokens-studio", "style-dictionary"] as const;

/** Brand × theme × density adds up quickly. Past this, the config is almost certainly a mistake. */
export const MAX_MODES = 256;
const AXIS_SEPARATOR = "/";

/**
 * True when `name` picks out this mode: its full name, or one of its group values, so "dark"
 * matches "acme/dark" and "zen/dark".
 */
export function modeMatches(mode: ModeConfig, name: string): boolean {
  return mode.name === name || (mode.axes !== undefined && Object.values(mode.axes).includes(name));
}

/** Every name modeMatches accepts for these modes, in config order. */
export function modeNames(modes: readonly ModeConfig[]): string[] {
  const names = new Set<string>();
  for (const mode of modes) {
    names.add(mode.name);
    for (const value of Object.values(mode.axes ?? {})) names.add(value);
  }
  return [...names];
}

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
    this.checkKeys(root, CONFIG_KEYS, []);

    const level = this.readEnum(root.level, LEVELS, ["level"], "AA");
    if (root.format === "css") {
      this.fail(
        ["format"],
        '"format" is for JSON token files. Files ending in .css are always read as CSS, so leave "format" out',
      );
    }
    const format = this.readEnum(root.format, FORMATS, ["format"], "auto");
    const modes = this.readModes(root);
    this.applyBase(root.base, modes);

    if (root.pairs === undefined) {
      this.fail([], 'Add a "pairs" list that says which tokens are checked against which');
    }
    if (!Array.isArray(root.pairs) || root.pairs.length === 0) {
      this.fail(["pairs"], '"pairs" must be a list with at least one pair');
    }
    const names = modeNames(modes);
    const pairs = root.pairs.map((pair, index) => this.readPair(pair, index, names));

    let baseline = DEFAULT_BASELINE;
    if (root.baseline !== undefined) {
      if (typeof root.baseline !== "string" || root.baseline.trim() === "") {
        this.fail(["baseline"], '"baseline" must be a file path, like "pairlint.baseline.json"');
      }
      baseline = root.baseline;
    }

    return { file: this.file, level, format, modes, pairs, baseline };
  }

  /**
   * "tokens" alone is one mode. "modes" is several, and "tokens" next to it is loaded first in
   * every mode. A mode whose value is an object is a group, and groups combine: brand × theme.
   */
  private readModes(root: Record<string, unknown>): ModeConfig[] {
    if (root.tokens === undefined && root.modes === undefined) {
      this.fail(
        [],
        'Say where your tokens are: "tokens": ["tokens.json"] or "modes": { "light": [...], "dark": [...] }',
      );
    }
    const shared = root.tokens === undefined ? [] : this.readSources(root.tokens, ["tokens"]);
    if (root.modes === undefined) {
      return [{ name: DEFAULT_MODE, sources: shared, base: DEFAULT_BASE }];
    }
    if (!isPlainObject(root.modes) || Object.keys(root.modes).length === 0) {
      this.fail(["modes"], '"modes" must be an object like { "light": ["light.json"] }');
    }

    const entries = Object.entries(root.modes);
    const groups = entries.filter((entry): entry is [string, Record<string, unknown>] =>
      isPlainObject(entry[1]),
    );
    if (groups.length === 0) {
      return entries.map(([name, sources]) => ({
        name,
        sources: [...shared, ...this.readSources(sources, ["modes", name])],
        base: DEFAULT_BASE,
      }));
    }
    if (groups.length !== entries.length) {
      const list = entries.find(([, value]) => !isPlainObject(value))?.[0] ?? "";
      this.fail(
        ["modes", list],
        `"${list}" is a list of files, but "${groups[0]?.[0]}" is a group of modes. ` +
          'Use { "light": [...], "dark": [...] } for one set of modes, or ' +
          '{ "brand": { "acme": [...] }, "theme": { "light": [...] } } to combine groups',
      );
    }
    return this.combineGroups(groups, shared);
  }

  /** Builds one mode per combination of group values: "acme/light", "acme/dark", "zen/light"... */
  private combineGroups(
    groups: [string, Record<string, unknown>][],
    shared: TokenSource[],
  ): ModeConfig[] {
    const owner = new Map<string, string>();
    const options = groups.map(([group, values]) => {
      const names = Object.keys(values);
      if (names.length === 0) {
        this.fail(
          ["modes", group],
          `"${group}" needs at least one mode, like { "light": ["light.json"] }`,
        );
      }
      return names.map((value) => {
        const path = ["modes", group, value];
        if (value.includes(AXIS_SEPARATOR) || value.trim() === "") {
          this.fail(path, `Mode names in a group cannot be empty or contain "${AXIS_SEPARATOR}"`);
        }
        const other = owner.get(value);
        if (other !== undefined) {
          this.fail(
            path,
            `"${value}" is in both "${other}" and "${group}". Give each mode its own name`,
          );
        }
        owner.set(value, group);
        return { value, sources: this.readSources(values[value], path) };
      });
    });

    const total = options.reduce((count, values) => count * values.length, 1);
    if (total > MAX_MODES) {
      this.fail(
        ["modes"],
        `These groups combine into ${total} modes. pairlint allows up to ${MAX_MODES}, so split the config or use fewer groups`,
      );
    }

    let combinations: { values: string[]; sources: TokenSource[] }[] = [
      { values: [], sources: shared },
    ];
    for (const values of options) {
      combinations = combinations.flatMap((combination) =>
        values.map((option) => ({
          values: [...combination.values, option.value],
          sources: [...combination.sources, ...option.sources],
        })),
      );
    }
    return combinations.map(({ values, sources }) => ({
      name: values.join(AXIS_SEPARATOR),
      axes: Object.fromEntries(groups.map(([group], index) => [group, values[index] ?? ""])),
      sources,
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

  /**
   * A base color can be set for every mode, for a group value like "dark", or for one full mode
   * name like "acme/dark". Full names win over group values, and later groups win over earlier.
   */
  private applyBase(value: unknown, modes: ModeConfig[]): void {
    if (value === undefined) return;
    if (typeof value === "string") {
      for (const mode of modes) mode.base = value;
      return;
    }
    if (!isPlainObject(value)) {
      this.fail(["base"], '"base" must be a color, or an object with a color per mode');
    }
    const names = modeNames(modes);
    for (const [name, base] of Object.entries(value)) {
      if (!names.includes(name)) this.unknown(["base", name], name, names, "mode");
      if (typeof base !== "string") this.fail(["base", name], "A base color must be a string");
    }
    for (const mode of modes) {
      for (const groupValue of Object.values(mode.axes ?? {})) {
        const base = value[groupValue];
        if (typeof base === "string") mode.base = base;
      }
      const own = value[mode.name];
      if (typeof own === "string") mode.base = own;
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

  private checkKeys(
    object: Record<string, unknown>,
    allowed: readonly string[],
    path: string[],
  ): void {
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
