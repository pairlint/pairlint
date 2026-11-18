import { ColorParseError, parseColor } from "@pairlint/contrast";
import {
  aliasTarget,
  compileTokenPattern,
  isCssPath,
  listCssContexts,
  parseTokenFile,
  type SourceFile,
  type Token,
  TokenFileError,
} from "@pairlint/tokens-core";

// Pure inference used by `pairlint init` and the Figma plugin. No file system access here.

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

const THEME_WORDS = ["light", "dark", "dim", "high-contrast", "contrast", "hc"];

/** Works out modes and pairs from token files. Files without color tokens are left out. */
export function inferConfig(files: readonly SourceFile[]): InferredConfig {
  const sources: FoundSource[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    for (const source of readSources(file, skipped)) sources.push(source);
  }

  const themes = [...new Set(sources.map((s) => s.theme).filter((t) => t !== undefined))];
  const shared = sources.filter((s) => s.theme === undefined).map((s) => s.entry);
  const modes =
    themes.length === 0
      ? [{ name: "default", sources: shared }]
      : orderThemes(themes).map((name) => ({
          name,
          sources: [...shared, ...sources.filter((s) => s.theme === name).map((s) => s.entry)],
        }));
  // A theme found only as an override (dark.json) still needs a mode for the shared files.
  if (themes.length > 0 && !themes.includes("light") && shared.length > 0) {
    modes.unshift({ name: "light", sources: shared });
  }

  const colors = [...new Set(sources.flatMap((s) => s.colors))].sort();
  const { pairs, guessed } = inferPairs(colors);
  return {
    modes: modes.filter((mode) => mode.sources.length > 0),
    pairs,
    guessed,
    colorCount: colors.length,
    fileCount: new Set(sources.map((s) => s.entry.split("#")[0])).size,
    skipped,
  };
}

function readSources(file: SourceFile, skipped: string[]): FoundSource[] {
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
      const colors = colorIds(() => parseTokenFile(file, { set }).tokens);
      return colors.length > 0
        ? [{ entry: `${file.path}#${set}`, theme: themeOf(set), colors }]
        : [];
    });
  }
  const colors = colorIds(() => parsed.tokens);
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

function colorIds(read: () => Token[]): string[] {
  let tokens: Token[];
  try {
    tokens = read();
  } catch (error) {
    if (error instanceof TokenFileError) return [];
    throw error;
  }
  return tokens.filter(isColorToken).map((token) => token.id);
}

function isColorToken(token: Token): boolean {
  if (token.type !== undefined) return token.type === "color";
  // Untyped tokens (Style Dictionary, CSS): aliases count, since most point at palette colors.
  if (aliasTarget(token.value) !== undefined) return true;
  try {
    parseColor(token.value);
    return true;
  } catch (error) {
    if (error instanceof ColorParseError) return false;
    throw error;
  }
}

/** "dark" from "dark.json", "[data-theme=dark]" or "@media (prefers-color-scheme: dark)". */
export function themeOf(label: string): string | undefined {
  const words = label.toLowerCase().split(/[^a-z0-9]+/);
  if (label.toLowerCase().includes("high-contrast") || words.includes("hc")) return "high-contrast";
  return THEME_WORDS.find((word) => words.includes(word));
}

function orderThemes(themes: string[]): string[] {
  return [...themes].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}

function rank(theme: string): number {
  const index = THEME_WORDS.indexOf(theme);
  return index === -1 ? THEME_WORDS.length : index;
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

/** What a token is for, from the words in its name. The word nearest the end wins. */
export function roleOf(id: string): Role | undefined {
  const words = id.toLowerCase().split(/[.\-_]/);
  if (words.includes("disabled")) return "disabled";
  if (words.includes("on")) return "on";
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i] ?? "";
    for (const role of ["fg", "bg", "ui"] as const) {
      if (ROLE_WORDS[role].includes(word)) return role;
    }
  }
  return undefined;
}

/** Guesses pairs from color token ids. Used by init and the Figma plugin. */
export function inferPairs(colors: readonly string[]): { pairs: InferredPair[]; guessed: boolean } {
  const roles = new Map(colors.map((id) => [id, roleOf(id)]));
  const ids = (wanted: Role[]) => colors.filter((id) => wanted.includes(roles.get(id) as Role));

  // Fills that on- colors sit on, like brand.fill for text.on-brand, are not general surfaces.
  const fills = new Map(ids(["on"]).map((id) => [id, fillsFor(id, colors, roles)]));
  const fillIds = new Set([...fills.values()].flat());

  const fg = compress(ids(["fg", "on", "disabled"]), colors, roles, ["fg", "on", "disabled"]);
  const bg = compress(
    ids(["bg"]).filter((id) => !fillIds.has(id)),
    colors,
    roles,
    ["bg"],
    fillIds,
  );
  const ui = compress(ids(["ui"]), colors, roles, ["ui"]);
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
function compress(
  ids: string[],
  colors: readonly string[],
  roles: Map<string, Role | undefined>,
  allowed: Role[],
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
        matches.every((m) => allowed.includes(roles.get(m) as Role) && !exclude.has(m))
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
function fillsFor(
  id: string,
  colors: readonly string[],
  roles: Map<string, Role | undefined>,
): string[] {
  const words = id.toLowerCase().split(/[.\-_]/);
  const name = words.slice(words.indexOf("on") + 1).join("-");
  if (name === "") return [];
  return colors
    .filter((other) => {
      if (other === id || roles.get(other) === "on" || roles.get(other) === "fg") return false;
      const otherWords = other.toLowerCase().split(/[.\-_]/);
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
