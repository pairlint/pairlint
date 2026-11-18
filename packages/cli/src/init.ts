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
import {
  expandModes,
  type FoundSource,
  isDarkName,
  type ModePlan,
  planFromStudioThemes,
  planModes,
  themeOf,
} from "./init-modes.js";

export { type FoundSource, themeOf } from "./init-modes.js";

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
  /** Shared files and the axes modes combine from, for writing groups. */
  plan: ModePlan;
  /** Whether the modes came from a Tokens Studio $themes.json. */
  fromThemesFile: boolean;
  /** The page background translucent colors sit on in dark modes, like "color.bg.canvas". */
  canvas: string | undefined;
}

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

  const studio = planFromStudioThemes(files, sources);
  const plan = studio ?? planModes(sources);
  const modes = expandModes(plan);

  const colors = [...new Set(sources.flatMap((s) => s.colors))].sort();
  // Untyped tokens that are not colors, like "text.body.size": 16px. The check matches them too,
  // so a pattern must not cover them.
  const others = new Set<string>();
  for (const token of lookup.values()) {
    if (kindOf(token, lookup) === "untyped") others.add(token.id);
  }
  const { pairs, guessed, unpaired, pairCount, canvas } = inferPairs(colors, others);
  return {
    modes,
    plan,
    fromThemesFile: studio !== undefined,
    canvas: modes.some((mode) => isDarkName(mode.name)) ? canvas : undefined,
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
 * token that is not a color, like a Style Dictionary font size, or a value the check cannot read.
 * Aliases are followed, so "button.font-family": "{typography.font-family}" is not a color.
 */
function kindOf(token: Token, lookup: ReadonlyMap<string, Token>): "color" | "typed" | "untyped" {
  let current = token;
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
    const target = aliasTarget(current.value);
    // "rgba({color.black}, {opacity.12})" mixes references with other text, which the check
    // cannot resolve yet. It counts as untyped so no pattern covers it.
    if (
      target === undefined &&
      typeof current.value === "string" &&
      /\{[^{}]+\}/.test(current.value)
    ) {
      return "untyped";
    }
    if (current.type !== undefined) return current.type === "color" ? "color" : "typed";
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

type Role = "fg" | "bg" | "ui" | "on" | "disabled";

type RoleWords = Record<"fg" | "bg" | "ui", readonly string[]>;

const ROLE_WORDS: RoleWords = {
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
 * When a system also has "text" tokens, its "foreground" tokens are raised layers, the way Calcite
 * uses color.foreground.1 for a panel on color.background. They are backgrounds then.
 */
const LAYER_ROLE_WORDS: RoleWords = {
  fg: ROLE_WORDS.fg.filter((word) => word !== "foreground"),
  bg: [...ROLE_WORDS.bg, "foreground"],
  ui: ROLE_WORDS.ui,
};
/** Borders that only decorate, which WCAG 1.4.11 does not ask to reach 3:1. */
const DECORATIVE_WORDS = ["divider", "separator", "subtle"];
/** Words that say nothing about which fill an on- color belongs on. */
const PLAIN_WORDS = new Set([
  "on",
  "color",
  "colour",
  "primary",
  "secondary",
  "tertiary",
  "default",
  "base",
  "subtle",
  "muted",
  "strong",
  "weak",
]);

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
/** Words that describe a variant, never a component, when they follow the role word. */
const VARIANT_WORDS = [
  "primary",
  "secondary",
  "tertiary",
  "default",
  "base",
  "subtle",
  "muted",
  "strong",
  "weak",
  "light",
  "dark",
  "color",
  "colour",
  "neutral",
  "black",
  "white",
  "gray",
  "grey",
  "transparent",
];
/** States a strong fill has: its resting color and the darker ones it turns while used. */
const FILL_STATES = ["rest", "hover", "hovered", "active", "pressed"];
/** Variant words that mark a light background, never a strong fill. */
const LIGHT_WORDS = [
  "subtle",
  "muted",
  "weak",
  "secondary",
  "tertiary",
  "default",
  "base",
  "light",
];
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
  /** The words after the role word: "badge" and "accent" for "color.text.badge.accent". */
  after: string[];
}

function classify(id: string, roleWords: RoleWords = ROLE_WORDS): Classified {
  const words = wordsOf(id);
  let base: "fg" | "bg" | "ui" | undefined;
  for (let i = words.length - 1; i >= 0 && base === undefined; i--) {
    const word = words[i] ?? "";
    base = (["fg", "bg", "ui"] as const).find((role) => roleWords[role].includes(word));
  }
  let [scopeEnd, roleEnd] = base === undefined ? [-1, -1] : roleRunOf(words, base, roleWords);
  // Named after the CSS property, like "button.color" next to "button.background-color". A
  // shadow's or gradient's color is not text, though.
  if (
    base === undefined &&
    id.split(".").pop()?.toLowerCase() === "color" &&
    !words.some((word) => NOT_TEXT_WORDS.includes(word))
  ) {
    base = "fg";
    scopeEnd = words.length - 1;
    roleEnd = words.length - 1;
  }
  const scope = words.slice(0, Math.max(scopeEnd, 0)).join(".");
  const after = roleEnd < 0 ? [] : words.slice(roleEnd + 1);
  // A disabled background is not text. It is left out instead of checked as a foreground.
  if (words.includes("disabled")) {
    return { role: base === "bg" ? undefined : "disabled", scope, after };
  }
  if (words.includes("on")) return { role: "on", scope, after };
  // Inverse text belongs on inverse backgrounds, the way an on- color belongs on its fill.
  if (base === "fg" && (words.includes("inverse") || words.includes("inverted"))) {
    return { role: "on", scope, after };
  }
  return { role: base, scope, after };
}

/**
 * The first and last index of the last run of role words. The scope ends where the run starts, so
 * "label-red-fgColor" is in "label.red" and "color.bg.canvas.default" in "color". "fill" is
 * skipped, since in "Bg.Danger.Fill Muted" it describes the background rather than starting it.
 */
function roleRunOf(
  words: string[],
  base: "fg" | "bg" | "ui",
  roleWords: RoleWords = ROLE_WORDS,
): [number, number] {
  const isRole = (word: string | undefined) =>
    word !== undefined && word !== "fill" && roleWords[base].includes(word);
  let end = words.length - 1;
  while (end >= 0 && !isRole(words[end])) end--;
  if (end < 0) {
    const index = words.findIndex((word) => roleWords[base].includes(word));
    return [index, index];
  }
  let start = end;
  while (start > 0 && isRole(words[start - 1])) start--;
  // Only an intent, "neutral" or a state between two role words, like "accent" in "Bg.Accent.Canvas":
  // still one run. A color name is not enough, since "label-gray-fgColor" is the gray label's text.
  for (let i = start - 1; i >= 0; i--) {
    const word = words[i] ?? "";
    if (roleWords[base].includes(word)) start = i;
    else if (!INTENT_WORDS.includes(word) && !STATE_WORDS.includes(word) && word !== "neutral") {
      break;
    }
  }
  return [start, end];
}

/** Words that only qualify a role word: intents, states, variants and numbers. */
function isModifier(word: string): boolean {
  return (
    /^\d+$/.test(word) ||
    [INTENT_WORDS, STATE_WORDS, VARIANT_WORDS, FILL_WORDS].some((list) => list.includes(word))
  );
}

/** A word after the role word that could name a component, like "badge" in "color.bg.badge.info". */
function componentWord(classified: Classified): string | undefined {
  const word = classified.after.find((w) => w !== "color" && w !== "colour");
  return word === undefined || isModifier(word) ? undefined : word;
}

/**
 * Component words that come after the role word on both sides, like "badge" in
 * "color.text.badge.accent" and "color.bg.badge.accent". A word whose backgrounds have interaction
 * states its text lacks is not one: "color.bg.action.primary.rest" is a button fill, while
 * "color.text.action.primary" is plain action text that sits on the page.
 */
function sharedComponents(colors: string[], classified: ReadonlyMap<string, Classified>) {
  const sides = new Map<
    string,
    { bg: boolean; fg: boolean; bgStates: boolean; fgStates: boolean }
  >();
  for (const id of colors) {
    const entry = classified.get(id);
    const word = entry ? componentWord(entry) : undefined;
    if (!entry || word === undefined) continue;
    const side =
      entry.role === "bg" ? "bg" : entry.role === "fg" || entry.role === "ui" ? "fg" : "";
    if (side === "") continue;
    const sideInfo = sides.get(word) ?? { bg: false, fg: false, bgStates: false, fgStates: false };
    sideInfo[side] = true;
    if (wordsOf(id).some((w) => STATE_WORDS.includes(w))) sideInfo[`${side}States`] = true;
    sides.set(word, sideInfo);
  }
  return new Set(
    [...sides]
      .filter(([, info]) => info.bg && info.fg && !(info.bgStates && !info.fgStates))
      .map(([word]) => word),
  );
}

/** What a token is for, from the words in its name. The word nearest the end wins. */
export function roleOf(id: string): Role | undefined {
  return classify(id).role;
}

interface Facets {
  scope: string;
  /** A component named after the role word, like "badge", when both text and backgrounds use it. */
  component: string | undefined;
  /** The words after the component, without states: "accent" for "color.text.badge.accent". */
  variant: string;
  intent: string | undefined;
  state: string | undefined;
  inverse: boolean;
}

function facetsOf(id: string, classified: Classified, components: ReadonlySet<string>): Facets {
  const words = wordsOf(id);
  const word = componentWord(classified);
  const component = word !== undefined && components.has(word) ? word : undefined;
  const variant = component
    ? classified.after
        .slice(classified.after.indexOf(component) + 1)
        .filter((w) => !STATE_WORDS.includes(w))
        .join(".")
    : "";
  const scope = component
    ? [classified.scope, component].filter((part) => part !== "").join(".")
    : classified.scope;
  return {
    scope,
    component,
    variant,
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
  /** Text, borders, on- colors, fills and backgrounds that found nothing to pair with. */
  unpaired: string[];
  /** Pairs checked in each mode, not counting exempt ones. */
  pairCount: number;
  /** The page background, for the base color of dark modes. */
  canvas: string | undefined;
}

/**
 * Pairs text and borders only with backgrounds they could sit on: the backgrounds of their own
 * component when it has any (button.text on button.background), otherwise the shared surfaces.
 * Text and backgrounds with different intents (success text on a danger background) or states
 * (hover text on a pressed background) are not paired, and strong fills only get their on- colors.
 */
function inferPairs(colors: string[], others: ReadonlySet<string>): PairInference {
  const has = (word: string) => colors.some((id) => wordsOf(id).includes(word));
  const roleWords = has("text") && has("foreground") ? LAYER_ROLE_WORDS : ROLE_WORDS;
  const classified = new Map(colors.map((id) => [id, classify(id, roleWords)]));
  const roleOfId = (id: string) => classified.get(id)?.role;
  const ids = (role: Role) => colors.filter((id) => roleOfId(id) === role);
  const components = sharedComponents(colors, classified);
  const facets = new Map(
    colors.map((id) => [id, facetsOf(id, classified.get(id) as Classified, components)] as const),
  );
  const facet = (id: string) => facets.get(id) as Facets;

  const named = new Map(ids("on").map((id) => [id, fillsFor(id, colors, roleOfId)]));
  // An on- color whose fill has no name of its own, like "on-solid" when no background says
  // "solid", sits on the backgrounds marked primary and their states. Inverse text does not: it
  // only goes on inverse backgrounds.
  const fallsBack = (id: string) => wordsOf(id).includes("on");
  const unnamed = [...named].some(([id, found]) => found.length === 0 && fallsBack(id));
  const primary = unnamed ? primaryFills(ids("bg"), classified) : [];
  const onFills = new Map(
    [...named].map(([id, found]) => [
      id,
      sharedWordsFirst(id, found.length > 0 || !fallsBack(id) ? found : primary),
    ]),
  );
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
      canvas: undefined,
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
    const found = [...scopes]
      .flatMap((scope) => byScope.get(scope) ?? [])
      .filter((bg) => compatible(own, facet(bg)))
      .sort();
    // Inside a component, matching variants pair one to one: decorative.1 text on decorative.1.
    if (own.component !== undefined && own.variant !== "") {
      const same = found.filter((bg) => facet(bg).variant === own.variant);
      if (same.length > 0) return same;
    }
    return found;
  };

  const edges = (fgIds: string[], find: (id: string) => string[]) =>
    new Map(fgIds.map((id) => [id, find(id)] as const));
  const text = edges(ids("fg"), surfacesFor);
  const isDecorative = (id: string) => wordsOf(id).some((word) => DECORATIVE_WORDS.includes(word));
  const ui = edges(
    ids("ui").filter((id) => !isDecorative(id)),
    surfacesFor,
  );
  const decorative = edges(ids("ui").filter(isDecorative), surfacesFor);
  const on = edges(ids("on"), (id) => onFills.get(id) ?? []);
  const disabled = edges(ids("disabled"), (id) => {
    const found = surfacesFor(id);
    return found.length > 0 ? found : surfaces;
  });

  const blocked = blockedPatterns(others);
  const exempted = new Map([...disabled, ...decorative]);
  const pairs = [
    ...groupRules(text, colors, blocked, {}, exempted),
    ...groupRules(ui, colors, blocked, { use: "ui" }, exempted),
    ...groupRules(on, colors, blocked, {}),
    ...groupRules(decorative, colors, blocked, {
      use: "exempt",
      reason:
        "Decorative borders and dividers do not need 3:1. WCAG 1.4.11 covers borders that identify a control",
    }),
    ...groupRules(disabled, colors, blocked, {
      use: "exempt",
      reason: "WCAG 1.4.3 does not apply to disabled controls",
    }),
  ];

  const usedFills = new Set([...on.values()].flat());
  const usedSurfaces = new Set([...text.values(), ...ui.values(), ...decorative.values()].flat());
  const unpaired = [
    ...[...text, ...ui, ...on, ...decorative]
      .filter(([, bgs]) => bgs.length === 0)
      .map(([id]) => id),
    ...[...fillIds].filter((id) => !usedFills.has(id)),
    ...surfaces.filter((id) => !usedSurfaces.has(id)),
  ].sort();
  let pairCount = 0;
  for (const map of [text, ui, on]) {
    for (const bgs of map.values()) pairCount += bgs.length;
  }
  return { pairs, guessed: false, unpaired, pairCount, canvas: canvasOf(surfaces, facet) };
}

/**
 * The page background, like "color.bg.canvas.default", "Bg.Neutral.Canvas",
 * "utrecht.document.background-color" or "bgColor-default". Undefined when no name says so.
 */
function canvasOf(surfaces: string[], facet: (id: string) => Facets): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  for (const id of surfaces) {
    const own = facet(id);
    if (own.intent !== undefined || own.state !== undefined || own.inverse) continue;
    const words = wordsOf(id);
    if (words.some((word) => LIGHT_WORDS.includes(word) && word !== "default" && word !== "base")) {
      continue;
    }
    if (words.some((word) => /^\d+$/.test(word))) continue;
    // A page word names the page only at the end of the scope or after the role word:
    // "utrecht.document.background-color" and "color.bg.page", not "page-header-bgColor".
    const scope = own.scope === "" ? [] : own.scope.split(".");
    const names = (word: string) =>
      words.includes(word) && (!scope.includes(word) || scope[scope.length - 1] === word);
    let score = names("canvas") ? 3 : PAGE_WORDS.some(names) ? 2 : 0;
    if (words.includes("default") || words.includes("base")) score += 1;
    if (score === 0 && words.every((word) => ROLE_WORDS.bg.includes(word) || word === "color")) {
      score = 1;
    }
    const better =
      best === undefined ||
      score > bestScore ||
      (score === bestScore && wordsOf(best).length > words.length);
    if (score > 0 && better) {
      best = id;
      bestScore = score;
    }
  }
  return best;
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
 * For "on-brand" or "color.on.primary", the fills named "brand" or "primary". For inverse text,
 * the inverse backgrounds.
 */
function fillsFor(id: string, colors: string[], roleOfId: (id: string) => Role | undefined) {
  const words = wordsOf(id);
  const at = words.indexOf("on");
  const inverse = at === -1;
  const name = inverse ? "" : words.slice(at + 1).join("-");
  if (!inverse && name === "") return [];
  return colors.filter((other) => {
    const role = roleOfId(other);
    if (other === id || (role !== undefined && role !== "bg")) return false;
    const otherWords = wordsOf(other);
    if (inverse) return otherWords.includes("inverse") || otherWords.includes("inverted");
    return otherWords.join("-").includes(name) && otherWords.includes(name.split("-")[0] ?? "");
  });
}

/**
 * The fills that share the most of the on- color's other words, so "Text.Accent.Strong on
 * emphasis" goes on the Accent fills and "Text.Neutral.Subtle on emphasis" on the Neutral ones.
 * Every fill when none shares a word.
 */
function sharedWordsFirst(id: string, fills: string[]): string[] {
  const own = wordsOf(id).filter(
    (word) =>
      !PLAIN_WORDS.has(word) &&
      !FILL_WORDS.includes(word) &&
      !STATE_WORDS.includes(word) &&
      !Object.values(ROLE_WORDS).some((list) => list.includes(word)),
  );
  const score = (fill: string) => wordsOf(fill).filter((word) => own.includes(word)).length;
  const best = Math.max(0, ...fills.map(score));
  return best === 0 ? fills : fills.filter((fill) => score(fill) === best);
}

/**
 * Strong fills named by variant instead of by a fill word: backgrounds marked primary, like
 * "color.bg.critical.primary" and "color.bg.action.primary.rest", the states next to them, like
 * "color.bg.critical.hovered", and the resting states of an intent that also has a subtle
 * background, like "color.bg.success.rest" next to "color.bg.success.subtle". Light variants, like
 * "color.bg.subtle-primary", and the selected state are left out.
 */
function primaryFills(bgs: string[], classified: ReadonlyMap<string, Classified>): string[] {
  const after = (id: string) => classified.get(id)?.after ?? [];
  const candidates = bgs.filter((id) => !after(id).some((word) => LIGHT_WORDS.includes(word)));
  // The group a background belongs to: "critical" for both critical.primary and critical.hovered.
  const groupOf = (words: string[]) =>
    words.filter((word) => word !== "primary" && !STATE_WORDS.includes(word)).join(".");
  const primaryGroups = new Set(
    candidates.filter((id) => after(id).includes("primary")).map((id) => groupOf(after(id))),
  );
  const subtleGroups = new Set(
    bgs
      .filter((id) => after(id).includes("subtle"))
      .map((id) => groupOf(after(id).filter((word) => word !== "subtle"))),
  );
  return candidates
    .filter((id) => {
      const words = after(id);
      if (words.includes("primary")) return true;
      const states = words.filter((word) => STATE_WORDS.includes(word));
      if (states.length === 0 || !states.every((word) => FILL_STATES.includes(word))) return false;
      const group = groupOf(words);
      return primaryGroups.has(group) || subtleGroups.has(group);
    })
    .sort();
}

/** Writes the config as commented JSON. */
export function renderConfig(config: InferredConfig, schemaPath: string): string {
  const lines = ["{", `  "$schema": ${JSON.stringify(schemaPath)},`];
  const modeWord = config.modes.length === 1 ? "mode" : "modes";
  lines.push(
    `  // Found ${config.colorCount} color tokens in ${config.fileCount} ${config.fileCount === 1 ? "file" : "files"}.`,
  );
  const { axes, shared } = config.plan;
  const grouped =
    axes.length > 1 && axes.every((axis) => axis.values.every((value) => value.sources.length > 0));
  let darkKeys = config.modes.map((mode) => mode.name).filter(isDarkName);
  if (config.modes.length === 1 && config.modes[0]?.name === "default") {
    lines.push(`  "tokens": ${inline(config.modes[0].sources)},`);
  } else if (grouped) {
    lines.push(
      `  // ${config.modes.length} ${modeWord}: ${axes.map((axis) => `${axis.values.length} ${axis.name}`).join(" × ")}.`,
    );
    if (axes.some((axis) => axis.kind === "brand")) {
      lines.push("  // Each brand is a folder that defines the same tokens as its siblings.");
    }
    if (shared.length > 0) lines.push(`  "tokens": ${inline(shared)},`);
    lines.push('  "modes": {');
    axes.forEach((axis, axisIndex) => {
      lines.push(`    ${JSON.stringify(axis.name)}: {`);
      axis.values.forEach((value, index) => {
        const comma = index < axis.values.length - 1 ? "," : "";
        lines.push(`      ${JSON.stringify(value.name)}: ${inline(value.sources)}${comma}`);
      });
      lines.push(`    }${axisIndex < axes.length - 1 ? "," : ""}`);
    });
    lines.push("  },");
    darkKeys = [
      ...new Set(axes.flatMap((axis) => axis.values.map((value) => value.name).filter(isDarkName))),
    ];
  } else {
    lines.push(
      config.fromThemesFile
        ? `  // ${config.modes.length} ${modeWord}, from the themes in $themes.json.`
        : `  // ${config.modes.length} ${modeWord}, named after the themes in your file names and selectors.`,
    );
    lines.push('  "modes": {');
    config.modes.forEach((mode, index) => {
      const comma = index < config.modes.length - 1 ? "," : "";
      lines.push(`    ${JSON.stringify(mode.name)}: ${inline(mode.sources)}${comma}`);
    });
    lines.push("  },");
  }
  if (config.canvas !== undefined && darkKeys.length > 0) {
    const alias = JSON.stringify(`{${config.canvas}}`);
    lines.push(
      "  // Translucent backgrounds in dark modes sit on the page background, not on white.",
    );
    lines.push(
      `  "base": { ${darkKeys.map((key) => `${JSON.stringify(key)}: ${alias}`).join(", ")} },`,
    );
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
