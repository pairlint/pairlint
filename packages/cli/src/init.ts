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
  /** Text, borders, on- colors and fills that found nothing to pair with. */
  unpaired: string[];
  /** Pairs checked in each mode, not counting exempt ones. */
  pairCount: number;
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
const MAX_LISTED = 12;
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
  const { pairs, guessed, unpaired, pairCount } = inferPairs(colors, others);
  return {
    modes: modes.filter((mode) => mode.sources.length > 0),
    pairs,
    guessed,
    unpaired,
    pairCount,
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

/** Backgrounds with these words are strong fills. Only their on- colors are checked on them. */
const FILL_WORDS = ["emphasis", "solid", "strong", "bold", "inverse", "inverted"];
/** What a color means. Text and a background with different meanings are never paired. */
const INTENT_WORDS = [
  "success",
  "positive",
  "danger",
  "critical",
  "error",
  "negative",
  "warning",
  "caution",
  "attention",
  "info",
  "information",
  "informative",
  "accent",
  "brand",
  "highlight",
  "discovery",
  "done",
  "closed",
  "open",
  "draft",
  "severe",
  "sponsors",
  "upsell",
];
/** Interaction states. Hover text is checked on hover backgrounds, not on pressed ones. */
const STATE_WORDS = ["rest", "hover", "hovered", "active", "pressed", "selected", "checked"];
/** Scope words for the page itself, the surface that component text falls back to. */
const PAGE_WORDS = ["document", "page", "body", "canvas", "app", "site", "root"];

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

interface Classified {
  role: Role | undefined;
  /**
   * The words before the role word, which name the component a token belongs to: "button" for
   * "button.text" and "button.background", "" for "text-muted".
   */
  scope: string;
}

function classify(id: string): Classified {
  const words = wordsOf(id);
  let base: "fg" | "bg" | "ui" | undefined;
  for (let i = words.length - 1; i >= 0 && base === undefined; i--) {
    const word = words[i] ?? "";
    base = (["fg", "bg", "ui"] as const).find((role) => ROLE_WORDS[role].includes(word));
  }
  let scopeEnd = base === undefined ? -1 : scopeEndOf(words, base);
  // Named after the CSS property, like "button.color" next to "button.background-color". A
  // shadow's or gradient's color is not text, though.
  if (
    base === undefined &&
    id.split(".").pop()?.toLowerCase() === "color" &&
    !words.some((word) => NOT_TEXT_WORDS.includes(word))
  ) {
    base = "fg";
    scopeEnd = words.length - 1;
  }
  const scope = words.slice(0, Math.max(scopeEnd, 0)).join(".");
  // A disabled background is not text. It is left out instead of checked as a foreground.
  if (words.includes("disabled")) return { role: base === "bg" ? undefined : "disabled", scope };
  if (words.includes("on")) return { role: "on", scope };
  return { role: base, scope };
}

/**
 * Where the scope ends: at the start of the last run of role words, so "label-red-fgColor" is in
 * "label.red" and "color.bg.canvas.default" in "color". "fill" is skipped, since in
 * "Bg.Danger.Fill Muted" it describes the background rather than starting it.
 */
function scopeEndOf(words: string[], base: "fg" | "bg" | "ui"): number {
  const isRole = (word: string | undefined) =>
    word !== undefined && word !== "fill" && ROLE_WORDS[base].includes(word);
  let end = words.length - 1;
  while (end >= 0 && !isRole(words[end])) end--;
  if (end < 0) return words.findIndex((word) => ROLE_WORDS[base].includes(word));
  while (end > 0 && isRole(words[end - 1])) end--;
  return end;
}

/** What a token is for, from the words in its name. The word nearest the end wins. */
export function roleOf(id: string): Role | undefined {
  return classify(id).role;
}

interface Facets {
  scope: string;
  intent: string | undefined;
  state: string | undefined;
  inverse: boolean;
}

function facetsOf(id: string, scope: string): Facets {
  const words = wordsOf(id);
  return {
    scope,
    intent: words.find((word) => INTENT_WORDS.includes(word)),
    state: words.find((word) => STATE_WORDS.includes(word)),
    inverse: words.includes("inverse") || words.includes("inverted"),
  };
}

/** True when text with these facets could sit on a background with those. */
function compatible(fg: Facets, bg: Facets): boolean {
  return (
    (fg.intent === undefined || bg.intent === undefined || fg.intent === bg.intent) &&
    (fg.state === undefined || bg.state === undefined || fg.state === bg.state) &&
    fg.inverse === bg.inverse
  );
}

interface PairInference {
  pairs: InferredPair[];
  guessed: boolean;
  /** Text, borders, on- colors and fills that found nothing to pair with. */
  unpaired: string[];
  /** Pairs checked in each mode, not counting exempt ones. */
  pairCount: number;
}

/**
 * Pairs text and borders only with backgrounds they could sit on: the backgrounds of their own
 * component when it has any (button.text on button.background), otherwise the shared surfaces.
 * Text and backgrounds with different intents (success text on a danger background) or states
 * (hover text on a pressed background) are not paired, and strong fills only get their on- colors.
 */
function inferPairs(colors: string[], others: ReadonlySet<string>): PairInference {
  const classified = new Map(colors.map((id) => [id, classify(id)]));
  const roleOfId = (id: string) => classified.get(id)?.role;
  const ids = (role: Role) => colors.filter((id) => roleOfId(id) === role);
  const facets = new Map(
    colors.map((id) => [id, facetsOf(id, classified.get(id)?.scope ?? "")] as const),
  );
  const facet = (id: string) => facets.get(id) as Facets;

  const onFills = new Map(ids("on").map((id) => [id, fillsFor(id, colors, roleOfId, facet)]));
  const fillIds = new Set([
    ...[...onFills.values()].flat(),
    ...ids("bg").filter((id) => wordsOf(id).some((word) => FILL_WORDS.includes(word))),
  ]);
  const surfaces = ids("bg").filter((id) => !fillIds.has(id));
  const foregrounds = [...ids("fg"), ...ids("on"), ...ids("disabled")];
  if (foregrounds.length === 0 || surfaces.length === 0) {
    return {
      pairs: [{ fg: ["color.text.*"], bg: ["color.surface.*"] }],
      guessed: true,
      unpaired: [],
      pairCount: 0,
    };
  }

  const byScope = new Map<string, string[]>();
  for (const id of surfaces) {
    const scope = facet(id).scope;
    byScope.set(scope, [...(byScope.get(scope) ?? []), id]);
  }
  const sizes = new Map<string, number>();
  for (const id of colors) {
    const scope = facet(id).scope;
    sizes.set(scope, (sizes.get(scope) ?? 0) + 1);
  }
  const shared = sharedScopes([...byScope.keys()], (scope) => sizes.get(scope) ?? 0);
  const surfacesFor = (id: string): string[] => {
    const own = facet(id);
    const words = own.scope === "" ? [] : own.scope.split(".");
    let scopes = shared;
    // The nearest scope with backgrounds: button.focus.border falls back to button's backgrounds.
    for (let n = words.length; n >= 0; n--) {
      const key = words.slice(0, n).join(".");
      if (byScope.has(key)) {
        scopes = shared.has(key) ? shared : new Set([key]);
        break;
      }
    }
    return [...scopes]
      .flatMap((scope) => byScope.get(scope) ?? [])
      .filter((bg) => compatible(own, facet(bg)))
      .sort();
  };

  const edges = (fgIds: string[], find: (id: string) => string[]) =>
    new Map(fgIds.map((id) => [id, find(id)] as const));
  const text = edges(ids("fg"), surfacesFor);
  const ui = edges(ids("ui"), surfacesFor);
  const on = edges(ids("on"), (id) => onFills.get(id) ?? []);
  const disabled = edges(ids("disabled"), (id) => {
    const found = surfacesFor(id);
    return found.length > 0 ? found : surfaces;
  });

  const blocked = blockedPatterns(others);
  const pairs = [
    ...groupRules(text, colors, blocked, {}, disabled),
    ...groupRules(ui, colors, blocked, { use: "ui" }, disabled),
    ...groupRules(on, colors, blocked, {}),
    ...groupRules(disabled, colors, blocked, {
      use: "exempt",
      reason: "WCAG 1.4.3 does not apply to disabled controls",
    }),
  ];

  const usedFills = new Set([...on.values()].flat());
  const unpaired = [
    ...[...text, ...ui, ...on].filter(([, bgs]) => bgs.length === 0).map(([id]) => id),
    ...[...fillIds].filter((id) => !usedFills.has(id)),
  ].sort();
  let pairCount = 0;
  for (const map of [text, ui, on]) {
    for (const bgs of map.values()) pairCount += bgs.length;
  }
  return { pairs, guessed: false, unpaired, pairCount };
}

/**
 * The scopes whose backgrounds every component can fall back to: the page's own, like
 * utrecht.document.background-color, or else the one scope that holds the most color tokens, like
 * "color" in "color.surface.base", or else all of them when names show no structure.
 */
function sharedScopes(scopes: string[], size: (scope: string) => number): Set<string> {
  const pages = scopes.filter((scope) => PAGE_WORDS.includes(scope.split(".").pop() ?? ""));
  if (pages.length > 0) return new Set(pages);
  const depth = (scope: string) => (scope === "" ? 0 : scope.split(".").length);
  const ranked = [...scopes].sort((a, b) => size(b) - size(a) || depth(a) - depth(b));
  const [first, second] = ranked;
  if (
    first !== undefined &&
    (second === undefined || size(first) > size(second) || depth(first) < depth(second))
  ) {
    return new Set([first]);
  }
  return new Set(scopes);
}

/**
 * Turns foreground-to-backgrounds edges into rules, one per distinct set of backgrounds. A
 * foreground pattern may also cover tokens that `exempted` exempts on every one of those
 * backgrounds, since an exempt pair overrides other rules, so "color.text.*" can stay one pattern
 * next to an exempt "color.text.disabled".
 */
function groupRules(
  edges: ReadonlyMap<string, string[]>,
  colors: string[],
  blocked: (pattern: string) => boolean,
  extra: Pick<InferredPair, "use" | "reason">,
  exempted: ReadonlyMap<string, string[]> = new Map(),
): InferredPair[] {
  const groups = new Map<string, { fg: string[]; bg: string[] }>();
  for (const [fg, bgs] of edges) {
    if (bgs.length === 0) continue;
    const key = bgs.join("\n");
    const group = groups.get(key);
    if (group) group.fg.push(fg);
    else groups.set(key, { fg: [fg], bg: bgs });
  }
  return [...groups.values()].map((group) => ({
    fg: compress(group.fg, colors, blocked, (id) => {
      const exempt = exempted.get(id);
      return exempt !== undefined && group.bg.every((bg) => exempt.includes(bg));
    }),
    bg: compress(group.bg, colors, blocked),
    ...extra,
  }));
}

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

/**
 * Turns ids into as few patterns as possible. "color.text.*" replaces its children only when every
 * color it matches is in `ids` and it matches no untyped token that is not a color, so a pattern
 * never pulls in other tokens.
 */
function compress(
  ids: string[],
  colors: string[],
  blocked: (pattern: string) => boolean,
  tolerated: (id: string) => boolean = () => false,
): string[] {
  const wanted = new Set(ids);
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
        matches.every((m) => wanted.has(m) || tolerated(m)) &&
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

/**
 * For "on-brand" or "color.on.primary", the fills named "brand" or "primary". When the on- color
 * has an intent, like "Text.Accent.Strong on emphasis", fills with the same intent win.
 */
function fillsFor(
  id: string,
  colors: string[],
  roleOfId: (id: string) => Role | undefined,
  facet: (id: string) => Facets,
): string[] {
  const words = wordsOf(id);
  const name = words.slice(words.indexOf("on") + 1).join("-");
  if (name === "") return [];
  const matches = colors.filter((other) => {
    const role = roleOfId(other);
    if (other === id || (role !== undefined && role !== "bg")) return false;
    const otherWords = wordsOf(other);
    return otherWords.join("-").includes(name) && otherWords.includes(name.split("-")[0] ?? "");
  });
  const intent = facet(id).intent;
  const same = intent === undefined ? [] : matches.filter((m) => facet(m).intent === intent);
  return same.length > 0 ? same : matches;
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
    lines.push(
      "  // Text and borders are paired with their own component's backgrounds, or else the shared",
    );
    lines.push(
      `  // surfaces. Different intents and states are kept apart. About ${config.pairCount} pairs per mode.`,
    );
    if (config.unpaired.length > 0) {
      const shown = config.unpaired.slice(0, MAX_LISTED);
      const more = config.unpaired.length - shown.length;
      lines.push(
        `  // Not paired, so not checked: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Add pairs for any your UI uses.`,
      );
    }
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
