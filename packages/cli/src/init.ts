import { type Dirent, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { ColorParseError, parseColor } from "@pairlint/contrast";
import {
  aliasTarget,
  compileTokenPattern,
  isCssPath,
  listCssContexts,
  MAX_ALIAS_DEPTH,
  parseTokenFile,
  type SourceFile,
  type Token,
  TokenFileError,
} from "@pairlint/tokens-core";
import { MAX_FILE_BYTES, toDisplayPath } from "./files.js";

/** A token file or one part of it (a Tokens Studio set or a CSS selection) that has colors. */
export interface FoundSource {
  /** Config entry, like "tokens/dark.json" or "theme.css#[data-theme=\"dark\"]". */
  entry: string;
  /** The theme this part belongs to, like "dark", or undefined when every mode shares it. */
  theme: string | undefined;
  /** Color token ids. */
  colors: string[];
}

export interface InferredPair {
  fg: string[];
  bg: string[];
  use?: "ui" | "exempt";
  reason?: string;
}

export interface InferredConfig {
  /** One entry for a single mode, or one per theme, each with its full list of files. */
  modes: { name: string; sources: string[] }[];
  pairs: InferredPair[];
  /** True when token names did not show which are text and which are backgrounds. */
  guessed: boolean;
  colorCount: number;
  fileCount: number;
  /** CSS selections with colors that did not look like themes, for a hint in the config. */
  skipped: string[];
}

const THEME_ORDER = [
  "light",
  "dark",
  "dim",
  "high-contrast",
  "light-high-contrast",
  "dark-high-contrast",
];
const HIGH_CONTRAST = "-high-contrast";
const NOT_TEXT_WORDS = ["shadow", "elevation", "gradient", "scrim", "overlay", "backdrop"];
const MAX_SCAN_DEPTH = 6;
const MAX_FILES = 2000;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "storybook-static",
]);
const SKIP_FILES =
  /^(package(-lock)?|tsconfig.*|jsconfig|composer|bower|lerna|turbo|nx|vercel|renovate|biome|pairlint\..*|.*\.schema|.*\.min)\.(json|css)$/i;

/**
 * Finds token files below `root`: JSON files with tokens and CSS files with custom properties.
 * It skips hidden folders, dependencies and build output, does not follow symlinks, and reads at
 * most MAX_FILES files.
 */
export function findTokenFiles(root: string): SourceFile[] {
  const found: SourceFile[] = [];
  let seen = 0;
  const visit = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (seen >= MAX_FILES) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH && !SKIP_DIRS.has(entry.name)) visit(path, depth + 1);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!entry.isFile() || (ext !== ".json" && ext !== ".css") || SKIP_FILES.test(entry.name)) {
        continue;
      }
      seen++;
      if (lstatSync(path).size > MAX_FILE_BYTES) continue;
      found.push({ path: toDisplayPath(relative(root, path)), text: readFileSync(path, "utf8") });
    }
  };
  visit(root, 0);
  return found;
}

/** Works out modes and pairs from token files. Files without color tokens are left out. */
export function inferConfig(files: readonly SourceFile[]): InferredConfig {
  const lookup = tokenLookup(files);
  const sources: FoundSource[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    for (const source of readSources(file, skipped, lookup)) sources.push(source);
  }

  const themes = [...new Set(sources.map((s) => s.theme).filter((t) => t !== undefined))];
  const shared = sources.filter((s) => s.theme === undefined).map((s) => s.entry);
  const entriesFor = (theme: string) =>
    sources.filter((s) => s.theme === theme).map((s) => s.entry);
  const modes =
    themes.length === 0
      ? [{ name: "default", sources: shared }]
      : orderThemes(themes).map((name) => {
          // A high contrast variant usually overrides only some tokens of its base theme, so it
          // loads that theme's files first.
          const base = name.endsWith(HIGH_CONTRAST) ? name.slice(0, -HIGH_CONTRAST.length) : "";
          const inherited = themes.includes(base) ? entriesFor(base) : [];
          return { name, sources: [...shared, ...inherited, ...entriesFor(name)] };
        });
  // A theme found only as an override (dark.json) still needs a mode for the shared files.
  if (themes.length > 0 && !themes.includes("light") && shared.length > 0) {
    modes.unshift({ name: "light", sources: shared });
  }

  const colors = [...new Set(sources.flatMap((s) => s.colors))].sort();
  // Untyped tokens that are not colors, like "text.body.size": 16px. The check matches them too,
  // so a pattern must not cover them.
  const others = new Set<string>();
  for (const token of lookup.values()) {
    if (kindOf(token, lookup) === "untyped") others.add(token.id);
  }
  const { pairs, guessed } = inferPairs(colors, others);
  return {
    modes: modes.filter((mode) => mode.sources.length > 0),
    pairs,
    guessed,
    colorCount: colors.length,
    fileCount: new Set(sources.map((s) => s.entry.split("#")[0])).size,
    skipped,
  };
}

/**
 * Every token in every file and CSS selection, by id, so init can follow an alias to see whether
 * it ends at a color. Later definitions win, the way files in a mode merge.
 */
function tokenLookup(files: readonly SourceFile[]): Map<string, Token> {
  const lookup = new Map<string, Token>();
  for (const file of files) {
    let contexts: (string | undefined)[] = [undefined];
    if (isCssPath(file.path)) {
      try {
        contexts = listCssContexts(file);
      } catch (error) {
        if (error instanceof TokenFileError) continue;
        throw error;
      }
    }
    for (const context of contexts) {
      try {
        const options = context === undefined || context === ":root" ? {} : { set: context };
        for (const token of parseTokenFile(file, options).tokens) {
          lookup.set(token.id, token);
        }
      } catch (error) {
        if (!(error instanceof TokenFileError)) throw error;
      }
    }
  }
  return lookup;
}

function readSources(
  file: SourceFile,
  skipped: string[],
  lookup: ReadonlyMap<string, Token>,
): FoundSource[] {
  if (isCssPath(file.path)) {
    let contexts: string[];
    try {
      contexts = listCssContexts(file);
    } catch (error) {
      if (error instanceof TokenFileError) return [];
      throw error;
    }
    const result: FoundSource[] = [];
    const themesInFile = new Set<string>();
    for (const context of contexts) {
      const colors = colorIds(
        () => parseTokenFile(file, context === ":root" ? {} : { set: context }).tokens,
        lookup,
      );
      if (colors.length === 0) continue;
      const theme = context === ":root" ? undefined : themeOf(context);
      if (context !== ":root" && (theme === undefined || themesInFile.has(theme))) {
        // Not a theme, or a second selection for a theme already found, like a media query that
        // repeats [data-theme=dark]. Listed in the config so it is easy to add by hand.
        skipped.push(`${file.path}#${context}`);
        continue;
      }
      if (theme !== undefined) themesInFile.add(theme);
      result.push({
        entry: context === ":root" ? file.path : `${file.path}#${context}`,
        theme,
        colors,
      });
    }
    return result;
  }

  let parsed: ReturnType<typeof parseTokenFile>;
  try {
    parsed = parseTokenFile(file);
  } catch (error) {
    if (error instanceof TokenFileError) return [];
    throw error;
  }
  const sets = studioSets(file);
  if (parsed.format === "tokens-studio" && sets.length > 0) {
    return sets.flatMap((set) => {
      const colors = colorIds(() => parseTokenFile(file, { set }).tokens, lookup);
      return colors.length > 0
        ? [{ entry: `${file.path}#${set}`, theme: themeOf(set), colors }]
        : [];
    });
  }
  const colors = colorIds(() => parsed.tokens, lookup);
  if (colors.length === 0) return [];
  const name =
    file.path
      .split("/")
      .pop()
      ?.replace(/\.json$/i, "") ?? file.path;
  return [{ entry: file.path, theme: themeOf(name), colors }];
}

function studioSets(file: SourceFile): string[] {
  try {
    const document = JSON.parse(file.text) as Record<string, unknown>;
    if (!("$themes" in document) && !("$metadata" in document)) return [];
    const order = (document.$metadata as { tokenSetOrder?: unknown } | undefined)?.tokenSetOrder;
    if (Array.isArray(order)) return order.filter((set): set is string => typeof set === "string");
    return Object.keys(document).filter((key) => !key.startsWith("$"));
  } catch {
    return [];
  }
}

function colorIds(read: () => Token[], lookup: ReadonlyMap<string, Token>): string[] {
  let tokens: Token[];
  try {
    tokens = read();
  } catch (error) {
    if (error instanceof TokenFileError) return [];
    throw error;
  }
  return tokens.filter((token) => kindOf(token, lookup) === "color").map((token) => token.id);
}

/**
 * "color" for a color, "typed" for a token with another $type, and "untyped" for an untyped
 * token that is not a color, like a Style Dictionary font size. Aliases are followed, so
 * "button.font-family": "{typography.font-family}" is not a color.
 */
function kindOf(token: Token, lookup: ReadonlyMap<string, Token>): "color" | "typed" | "untyped" {
  let current = token;
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
    if (current.type !== undefined) return current.type === "color" ? "color" : "typed";
    const target = aliasTarget(current.value);
    if (target === undefined) return parsesAsColor(current.value) ? "color" : "untyped";
    const next = lookup.get(target);
    // A missing target is reported by the check. Most aliases point at palette colors.
    if (!next) return "color";
    current = next;
  }
  return "color";
}

function parsesAsColor(value: unknown): boolean {
  try {
    parseColor(value);
    return true;
  } catch (error) {
    if (error instanceof ColorParseError) return false;
    throw error;
  }
}

/** "dark" from "dark.json", "[data-theme=dark]" or "@media (prefers-color-scheme: dark)". */
export function themeOf(label: string): string | undefined {
  // Attribute names like data-light-theme say nothing about the theme. Their values do.
  const text = label.replace(/\[\s*[\w-]+\s*(?=[~|^$*]?=|\])/g, "[").toLowerCase();
  const words = text.split(/[^a-z0-9]+/);
  const base = ["light", "dark", "dim"].find((word) => words.includes(word));
  if (words.includes("hc") || words.includes("contrast") || words.includes("highcontrast")) {
    // Light and dark high contrast are different themes, so they stay apart.
    return base === "light" || base === "dark" ? `${base}${HIGH_CONTRAST}` : "high-contrast";
  }
  return base;
}

function orderThemes(themes: string[]): string[] {
  return [...themes].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}

function rank(theme: string): number {
  const index = THEME_ORDER.indexOf(theme);
  return index === -1 ? THEME_ORDER.length : index;
}

type Role = "fg" | "bg" | "ui" | "on" | "disabled";

const ROLE_WORDS: Record<"fg" | "bg" | "ui", readonly string[]> = {
  fg: [
    "text",
    "font",
    "fg",
    "foreground",
    "content",
    "icon",
    "link",
    "heading",
    "label",
    "ink",
    "copy",
  ],
  bg: ["bg", "background", "surface", "canvas", "page", "backdrop", "container", "layer", "fill"],
  ui: ["border", "outline", "stroke", "divider", "separator", "ring", "focus"],
};

/**
 * The lowercase words in a token id. Dots, dashes, underscores, spaces and camelCase all separate
 * words, so "button-fgColor.Fill Muted" gives button, fg, color, fill and muted.
 */
function wordsOf(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[.\-_\s]+/)
    .filter((word) => word !== "");
}

/** What a token is for, from the words in its name. The word nearest the end wins. */
export function roleOf(id: string): Role | undefined {
  const words = wordsOf(id);
  let base: "fg" | "bg" | "ui" | undefined;
  for (let i = words.length - 1; i >= 0 && base === undefined; i--) {
    const word = words[i] ?? "";
    base = (["fg", "bg", "ui"] as const).find((role) => ROLE_WORDS[role].includes(word));
  }
  // Named after the CSS property, like "button.color" next to "button.background-color". A
  // shadow's or gradient's color is not text, though.
  if (
    base === undefined &&
    id.split(".").pop()?.toLowerCase() === "color" &&
    !words.some((word) => NOT_TEXT_WORDS.includes(word))
  ) {
    base = "fg";
  }
  // A disabled background is not text. It is left out instead of checked as a foreground.
  if (words.includes("disabled")) return base === "bg" ? undefined : "disabled";
  if (words.includes("on")) return "on";
  return base;
}

function inferPairs(
  colors: string[],
  others: ReadonlySet<string>,
): { pairs: InferredPair[]; guessed: boolean } {
  const roles = new Map(colors.map((id) => [id, roleOf(id)]));
  const ids = (wanted: Role[]) => colors.filter((id) => wanted.includes(roles.get(id) as Role));

  // Fills that on- colors sit on, like brand.fill for text.on-brand, are not general surfaces.
  const fills = new Map(ids(["on"]).map((id) => [id, fillsFor(id, colors, roles)]));
  const fillIds = new Set([...fills.values()].flat());

  const blocked = blockedPatterns(others);
  const fg = compress(
    ids(["fg", "on", "disabled"]),
    colors,
    roles,
    ["fg", "on", "disabled"],
    blocked,
  );
  const bg = compress(
    ids(["bg"]).filter((id) => !fillIds.has(id)),
    colors,
    roles,
    ["bg"],
    blocked,
    fillIds,
  );
  const ui = compress(ids(["ui"]), colors, roles, ["ui"], blocked);
  if (fg.length === 0 || bg.length === 0) {
    return {
      pairs: [{ fg: ["color.text.*"], bg: ["color.surface.*"] }],
      guessed: true,
    };
  }

  const pairs: InferredPair[] = [{ fg, bg }];
  if (ui.length > 0) pairs.push({ fg: ui, bg, use: "ui" });

  const covered = (id: string) => fg.some((pattern) => compileTokenPattern(pattern)(id));
  const onIds = ids(["on"]).filter(covered);
  if (onIds.length > 0) {
    pairs.push({
      fg: onIds,
      bg,
      use: "exempt",
      reason: "On- colors sit on their own fill, which is checked separately",
    });
    for (const id of onIds) {
      const own = fills.get(id) ?? [];
      if (own.length > 0) pairs.push({ fg: [id], bg: own });
    }
  }
  const disabled = ids(["disabled"]).filter(covered);
  if (disabled.length > 0) {
    pairs.push({
      fg: disabled,
      bg,
      use: "exempt",
      reason: "WCAG 1.4.3 does not apply to disabled controls",
    });
  }
  return { pairs, guessed: false };
}

/**
 * Turns ids into as few patterns as possible. "color.text.*" replaces its children only when every
 * color it would match has one of the allowed roles, so a pattern never pulls in other tokens.
 */
/** Answers, once per pattern, whether it would also match one of `others`. */
function blockedPatterns(others: ReadonlySet<string>): (pattern: string) => boolean {
  const cache = new Map<string, boolean>();
  return (pattern) => {
    let blocked = cache.get(pattern);
    if (blocked === undefined) {
      const matcher = compileTokenPattern(pattern);
      blocked = false;
      for (const id of others) {
        if (matcher(id)) {
          blocked = true;
          break;
        }
      }
      cache.set(pattern, blocked);
    }
    return blocked;
  };
}

function compress(
  ids: string[],
  colors: string[],
  roles: Map<string, Role | undefined>,
  allowed: Role[],
  blocked: (pattern: string) => boolean,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const patterns = new Set<string>();
  for (const id of ids) {
    const dot = id.lastIndexOf(".");
    const dash = id.indexOf("-");
    const candidate =
      dot > 0 ? `${id.slice(0, dot)}.*` : dash > 0 ? `${id.slice(0, dash)}*` : undefined;
    if (candidate) {
      const matches = colors.filter(compileTokenPattern(candidate));
      if (
        matches.length > 1 &&
        matches.every((m) => allowed.includes(roles.get(m) as Role) && !exclude.has(m)) &&
        !blocked(candidate)
      ) {
        patterns.add(candidate);
        continue;
      }
    }
    patterns.add(id);
  }
  // Drop exact ids a kept pattern already covers.
  const list = [...patterns];
  return list
    .filter(
      (p) =>
        p.includes("*") ||
        !list.some((q) => q !== p && q.includes("*") && compileTokenPattern(q)(p)),
    )
    .sort();
}

/** For "on-brand" or "color.on.primary", the fills named "brand" or "primary". */
function fillsFor(id: string, colors: string[], roles: Map<string, Role | undefined>): string[] {
  const words = wordsOf(id);
  const name = words.slice(words.indexOf("on") + 1).join("-");
  if (name === "") return [];
  return colors
    .filter((other) => {
      if (other === id || roles.get(other) === "on" || roles.get(other) === "fg") return false;
      const otherWords = wordsOf(other);
      return otherWords.join("-").includes(name) && otherWords.includes(name.split("-")[0] ?? "");
    })
    .slice(0, 5);
}

/** Writes the config as commented JSON. */
export function renderConfig(config: InferredConfig, schemaPath: string): string {
  const lines = ["{", `  "$schema": ${JSON.stringify(schemaPath)},`];
  const modeWord = config.modes.length === 1 ? "mode" : "modes";
  lines.push(
    `  // Found ${config.colorCount} color tokens in ${config.fileCount} ${config.fileCount === 1 ? "file" : "files"}.`,
  );
  if (config.modes.length === 1 && config.modes[0]?.name === "default") {
    lines.push(`  "tokens": ${inline(config.modes[0].sources)},`);
  } else {
    lines.push(
      `  // ${config.modes.length} ${modeWord}, named after the themes in your file names and selectors.`,
    );
    lines.push('  "modes": {');
    config.modes.forEach((mode, index) => {
      const comma = index < config.modes.length - 1 ? "," : "";
      lines.push(`    ${JSON.stringify(mode.name)}: ${inline(mode.sources)}${comma}`);
    });
    lines.push("  },");
  }
  for (const entry of config.skipped) {
    lines.push(`  // Also has colors, but does not look like a theme: ${entry}`);
  }
  if (config.guessed) {
    lines.push("  // pairlint could not tell text tokens from backgrounds by their names.");
    lines.push(
      '  // Replace these patterns with yours, like "color.text.*" and "color.surface.*".',
    );
  } else {
    lines.push(
      "  // Pairs inferred from token names. Check that each one is a real combination in your UI.",
    );
  }
  lines.push('  "pairs": [');
  config.pairs.forEach((pair, index) => {
    const parts = [`"fg": ${inline(pair.fg)}`, `"bg": ${inline(pair.bg)}`];
    if (pair.use) parts.push(`"use": ${JSON.stringify(pair.use)}`);
    if (pair.reason) parts.push(`"reason": ${JSON.stringify(pair.reason)}`);
    const comma = index < config.pairs.length - 1 ? "," : "";
    lines.push(`    { ${parts.join(", ")} }${comma}`);
  });
  lines.push("  ]", "}");
  return `${lines.join("\n")}\n`;
}

function inline(values: readonly string[]): string {
  if (values.length === 1) return JSON.stringify(values[0]);
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}
