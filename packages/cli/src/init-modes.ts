import type { SourceFile } from "@pairlint/tokens-core";
import { MAX_MODES } from "./config.js";

/** A token file or one part of it (a Tokens Studio set or a CSS selection) that has colors. */
export interface FoundSource {
  /** Config entry, like "tokens/dark.json" or "theme.css#[data-theme=\"dark\"]". */
  entry: string;
  /** The theme this part belongs to, like "dark", or undefined when every mode shares it. */
  theme: string | undefined;
  /** Color token ids. */
  colors: string[];
}

/** One way modes differ, like brand or theme, with the files each value adds. */
export interface ModeAxis {
  name: string;
  kind: "brand" | "theme" | "variant";
  values: { name: string; sources: string[] }[];
}

/** Files every mode loads first, then the axes that combine into modes. */
export interface ModePlan {
  shared: string[];
  axes: ModeAxis[];
}

const THEME_ORDER = [
  "light",
  "dark",
  "dim",
  "high-contrast",
  "light-high-contrast",
  "dark-high-contrast",
];
export const HIGH_CONTRAST = "-high-contrast";
/** Two files in one theme that share this much of the larger one's ids are alternatives. */
const ALTERNATIVE_OVERLAP = 0.8;
/** Two sibling folders that share this much of the smaller one's ids are brands. */
const BRAND_OVERLAP = 0.6;
/** Files or folders with fewer colors than this are never alternatives or brands. */
const MIN_IDS = 3;

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

export function orderThemes(themes: string[]): string[] {
  return [...themes].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}

function rank(theme: string): number {
  const base = THEME_ORDER.indexOf(theme);
  if (base !== -1) return base * 2;
  // An alternative sorts right after its theme: light-colorblind after light.
  const parent = themeOf(theme);
  const index = parent === undefined ? -1 : THEME_ORDER.indexOf(parent);
  return index === -1 ? THEME_ORDER.length * 2 : index * 2 + 1;
}

/** True for a mode or theme name that is dark: "dark", "dark-dimmed", "acme/dark". */
export function isDarkName(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => word === "dark" || word === "dim" || word === "dimmed" || word === "night");
}

/** "dark-dimmed" from "Dark Dimmed", "darkDimmed" or "🌚 dark_dimmed". */
export function slug(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The file name or set name an entry is known by: "dark-dimmed" for "themes/dark-dimmed.css". */
function labelOf(entry: string): string {
  const hash = entry.indexOf("#");
  const path = hash === -1 ? entry : entry.slice(0, hash);
  if (hash !== -1 && !/\.css$/i.test(path)) return entry.slice(hash + 1);
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.(json5?|css)$/i, "").replace(/\.tokens$/i, "");
}

function folderOf(entry: string): string {
  const path = pathOf(entry);
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function pathOf(entry: string): string {
  const hash = entry.indexOf("#");
  return hash === -1 ? entry : entry.slice(0, hash);
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) if (large.has(id)) shared++;
  return shared;
}

/** Groups items whose id sets are similar enough, using `similar` on every pair. */
function clusters<T>(items: T[], similar: (a: T, b: T) => boolean): T[][] {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    return root;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (similar(items[i] as T, items[j] as T)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  return [...groups.values()];
}

/** Picks a name that is not taken yet, adding a number when it must. */
function unique(name: string, taken: Set<string>): string {
  let result = name === "" ? "mode" : name;
  for (let n = 2; taken.has(result); n++) result = `${name}-${n}`;
  taken.add(result);
  return result;
}

/**
 * Works out modes from what the files look like:
 * - sibling folders that define the same token ids are brands (proprietary/zwolle,
 *   proprietary/haarlem);
 * - files in one theme that define mostly the same ids are alternatives, each its own mode
 *   (light, light-colorblind, light-tritanopia), while files with different ids are layers;
 * - alternatives that belong to no theme become their own group (appearance: accent, danger).
 */
export function planModes(sources: FoundSource[]): ModePlan {
  const brands = detectBrands(sources);
  const inBrand = new Set(brands.flatMap((brand) => brand.sources));
  const rest = sources.filter((source) => !inBrand.has(source.entry));

  const byTheme = new Map<string | undefined, FoundSource[]>();
  for (const source of rest) {
    byTheme.set(source.theme, [...(byTheme.get(source.theme) ?? []), source]);
  }
  const alternatives = (list: FoundSource[]) => {
    const sets = new Map(list.map((source) => [source, new Set(source.colors)]));
    return clusters(list, (a, b) => {
      const setA = sets.get(a) as Set<string>;
      const setB = sets.get(b) as Set<string>;
      // Alternatives sit side by side under different names, like light.css and
      // light-colorblind.css. Same-named files in different folders are not alternatives.
      return (
        folderOf(a.entry) === folderOf(b.entry) &&
        labelOf(a.entry) !== labelOf(b.entry) &&
        Math.min(setA.size, setB.size) >= MIN_IDS &&
        overlap(setA, setB) >= ALTERNATIVE_OVERLAP * Math.max(setA.size, setB.size)
      );
    });
  };

  const themeEntries = new Map<string, string[]>();
  const shared: string[] = [];
  const variantAxes: ModeAxis[] = [];
  const takenThemes = new Set([...byTheme.keys()].filter((key) => key !== undefined));
  const takenAxes = new Set(["brand", "theme"]);
  for (const [theme, list] of byTheme) {
    const groups = alternatives(list);
    const layers = groups.filter((group) => group.length === 1).flat();
    const sets = groups.filter((group) => group.length > 1);
    if (theme === undefined) {
      shared.push(...layers.map((source) => source.entry));
      for (const set of sets) variantAxes.push(variantAxis(set, takenAxes));
      continue;
    }
    const own = layers.map((source) => source.entry);
    themeEntries.set(theme, [...own]);
    for (const set of sets) {
      const named = set.map((source) => ({ source, name: slug(labelOf(source.entry)) }));
      const words = (name: string) => name.split("-").length;
      const primary =
        named.find((item) => item.name === theme) ??
        [...named].sort((a, b) => words(a.name) - words(b.name))[0];
      for (const item of named) {
        if (item === primary) {
          themeEntries.get(theme)?.push(item.source.entry);
          continue;
        }
        const name = unique(item.name === "" ? theme : item.name, takenThemes);
        // A file that only overrides some of the main file's tokens, like Primer's
        // dark.dimmed.json5 on dark.json5, loads the main file first.
        const main = new Set(primary?.source.colors);
        const overrides =
          item.source.colors.length < main.size && item.source.colors.every((id) => main.has(id));
        const base = overrides && primary ? [primary.source.entry] : [];
        themeEntries.set(name, [...own, ...base, item.source.entry]);
      }
    }
  }

  const axes: ModeAxis[] = [];
  if (brands.length > 0) {
    axes.push({
      name: "brand",
      kind: "brand",
      values: brands.map((brand) => ({ name: brand.name, sources: brand.sources })),
    });
  }
  const themes = orderThemes([...themeEntries.keys()]);
  if (themes.length > 0) {
    const values = themes.map((name) => {
      // A high contrast variant usually overrides only some tokens of its base theme, so it
      // loads that theme's files first.
      const base = name.endsWith(HIGH_CONTRAST) ? name.slice(0, -HIGH_CONTRAST.length) : "";
      const inherited = themeEntries.get(base) ?? [];
      return { name, sources: [...inherited, ...(themeEntries.get(name) ?? [])] };
    });
    // A theme found only as an override (dark.json) still needs a mode for the shared files.
    if (!themes.includes("light") && shared.length > 0 && brands.length === 0) {
      values.unshift({ name: "light", sources: [] });
    }
    axes.push({ name: "theme", kind: "theme", values });
  }
  // Groups found by overlap alone are dropped first when the modes would be too many to check.
  const count = (list: ModeAxis[]) => list.reduce((total, axis) => total * axis.values.length, 1);
  if (count([...axes, ...variantAxes]) > MAX_MODES) {
    for (const axis of variantAxes) {
      for (const value of axis.values) shared.push(...value.sources);
    }
  } else {
    axes.push(...variantAxes);
  }
  return { shared, axes };
}

/** One group from files that are alternatives of each other: "appearance" with accent, danger. */
function variantAxis(set: FoundSource[], taken: Set<string>): ModeAxis {
  const labels = set.map((source) => slug(labelOf(source.entry)).split("-"));
  const first = labels[0] ?? [];
  let common = 0;
  while (
    common < first.length - 1 &&
    labels.every((words) => words.length > common + 1 && words[common] === first[common])
  ) {
    common++;
  }
  const name = unique(first.slice(0, common).join("-") || "variant", taken);
  const names = new Set<string>();
  return {
    name,
    kind: "variant",
    values: set.map((source, index) => ({
      name: unique((labels[index] ?? []).slice(common).join("-"), names),
      sources: [source.entry],
    })),
  };
}

interface Brand {
  name: string;
  sources: string[];
}

/**
 * Sibling folders that define the same token ids, like proprietary/zwolle-design-tokens and
 * proprietary/haarlem-design-tokens. Folders named after themes (light/, dark/) are not brands.
 * The parent with the most such folders wins, then the next one outside it, and so on. Files
 * outside every brand folder are loaded in every mode.
 */
function detectBrands(sources: FoundSource[]): Brand[] {
  const files = new Map<string, Set<string>>();
  const entriesByPath = new Map<string, string[]>();
  for (const source of sources) {
    const path = pathOf(source.entry);
    const ids = files.get(path) ?? new Set<string>();
    for (const id of source.colors) ids.add(id);
    files.set(path, ids);
    entriesByPath.set(path, [...(entriesByPath.get(path) ?? []), source.entry]);
  }
  // For each folder, its child folders and the ids and files below each.
  const children = new Map<string, Map<string, { ids: Set<string>; paths: string[] }>>();
  for (const [path, ids] of files) {
    const parts = path.split("/").slice(0, -1);
    for (let depth = 0; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join("/");
      const child = parts[depth] as string;
      const map = children.get(parent) ?? new Map();
      const entry = map.get(child) ?? { ids: new Set<string>(), paths: [] };
      for (const id of ids) entry.ids.add(id);
      entry.paths.push(path);
      map.set(child, entry);
      children.set(parent, map);
    }
  }

  const candidates: {
    parent: string;
    members: [string, { paths: string[] }][];
    score: number;
  }[] = [];
  for (const [parent, map] of children) {
    const eligible = [...map].filter(([, info]) => info.ids.size >= MIN_IDS);
    if (eligible.length < 2) continue;
    const groups = clusters(eligible, ([, a], [, b]) => {
      return (
        Math.min(a.ids.size, b.ids.size) >= MIN_IDS &&
        overlap(a.ids, b.ids) >= BRAND_OVERLAP * Math.min(a.ids.size, b.ids.size)
      );
    });
    const best = groups.sort((a, b) => b.length - a.length)[0] ?? [];
    // Most siblings must match, and none may be named after a theme (light/, dark/). Then every
    // sibling is a brand, including one whose files differ more.
    if (best.length < 2 || best.length * 2 < eligible.length) continue;
    if (eligible.some(([name]) => themeOf(name) !== undefined)) continue;
    candidates.push({ parent, members: eligible, score: best.length });
  }
  candidates.sort((a, b) => b.score - a.score || a.parent.length - b.parent.length);

  const chosen: typeof candidates = [];
  const related = (a: string, b: string) =>
    a === b || a === "" || b === "" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  for (const candidate of candidates) {
    if (chosen.some((other) => related(other.parent, candidate.parent))) continue;
    chosen.push(candidate);
  }

  const taken = new Set<string>();
  return chosen.flatMap(({ members }) => {
    const names = members.map(([name]) => name);
    const trimmed = trimCommon(names);
    return members
      .map(([, info], index) => ({
        name: unique(slug(trimmed[index] ?? ""), taken),
        sources: info.paths.flatMap((path) => entriesByPath.get(path) ?? []),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  });
}

/** Drops a prefix or suffix every name shares, at a "-" or "_": "zwolle" for "zwolle-design-tokens". */
function trimCommon(names: string[]): string[] {
  if (names.length < 2) return names;
  const split = names.map((name) => name.split(/(?=[-_])/));
  const first = split[0] ?? [];
  let start = 0;
  while (start < first.length - 1 && split.every((parts) => parts[start] === first[start])) start++;
  let end = 0;
  while (
    end < first.length - start - 1 &&
    split.every(
      (parts) =>
        parts.length - start - end > 1 &&
        parts[parts.length - 1 - end] === first[first.length - 1 - end],
    )
  ) {
    end++;
  }
  return split.map((parts) =>
    parts
      .slice(start, parts.length - end)
      .join("")
      .replace(/^[-_]/, ""),
  );
}

interface StudioTheme {
  name: string;
  group: string;
  sets: { name: string; status: "enabled" | "source" }[];
}

/**
 * Modes from a Tokens Studio $themes.json, which already says which sets make each theme. A group
 * with one theme that has colors is loaded in every mode. A group with several is one way modes
 * differ. Returns undefined when there is no such file or it names none of the found files.
 */
export function planFromStudioThemes(
  files: readonly SourceFile[],
  sources: FoundSource[],
): ModePlan | undefined {
  const colorEntries = new Set(sources.map((source) => source.entry));
  for (const file of studioThemeFiles(files)) {
    const plan = planFromThemes(file, files, colorEntries);
    if (plan) return plan;
  }
  return undefined;
}

function studioThemeFiles(files: readonly SourceFile[]): SourceFile[] {
  const depth = (file: SourceFile) => file.path.split("/").length;
  return files
    .filter((file) => {
      if ((file.path.split("/").pop() ?? "") === "$themes.json") return true;
      return file.text.includes('"$themes"') && !/\.css$/i.test(file.path);
    })
    .sort((a, b) => depth(a) - depth(b));
}

function planFromThemes(
  file: SourceFile,
  files: readonly SourceFile[],
  colorEntries: ReadonlySet<string>,
): ModePlan | undefined {
  let document: unknown;
  try {
    document = JSON.parse(file.text);
  } catch {
    return undefined;
  }
  const isThemesFile = (file.path.split("/").pop() ?? "") === "$themes.json";
  const list = isThemesFile ? document : (document as Record<string, unknown> | null)?.$themes;
  const themes = readStudioThemes(list);
  if (themes.length === 0) return undefined;

  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  let order: unknown;
  if (isThemesFile) {
    const metadata = files.find((other) => other.path === `${dir}$metadata.json`);
    try {
      order = metadata ? (JSON.parse(metadata.text) as Record<string, unknown>).tokenSetOrder : [];
    } catch {
      order = [];
    }
  } else {
    order = ((document as Record<string, unknown>).$metadata as Record<string, unknown> | undefined)
      ?.tokenSetOrder;
  }
  const setOrder = Array.isArray(order) ? order.filter((set) => typeof set === "string") : [];
  const position = (set: string) => {
    const index = setOrder.indexOf(set);
    return index === -1 ? setOrder.length : index;
  };
  const entryOf = (set: string) => (isThemesFile ? `${dir}${set}.json` : `${file.path}#${set}`);

  const resolved = themes.map((theme) => {
    const sorted = [...theme.sets].sort(
      (a, b) =>
        (a.status === b.status ? 0 : a.status === "source" ? -1 : 1) ||
        position(a.name) - position(b.name),
    );
    const entries = [
      ...new Set(sorted.map((set) => entryOf(set.name)).filter((e) => colorEntries.has(e))),
    ];
    const colored = theme.sets.some(
      (set) => set.status === "enabled" && colorEntries.has(entryOf(set.name)),
    );
    return { theme, entries, colored };
  });

  const groups = new Map<string, typeof resolved>();
  for (const item of resolved) {
    if (!item.colored) continue;
    groups.set(item.theme.group, [...(groups.get(item.theme.group) ?? []), item]);
  }
  const shared: string[] = [];
  const axes: ModeAxis[] = [];
  const takenAxes = new Set<string>();
  for (const [group, items] of groups) {
    if (items.length === 1) {
      for (const entry of items[0]?.entries ?? []) if (!shared.includes(entry)) shared.push(entry);
      continue;
    }
    const themeNames = items.map((item) => themeOf(item.theme.name));
    const byTheme =
      themeNames.every((name) => name !== undefined) && new Set(themeNames).size === items.length;
    const names = new Set<string>();
    const values = items.map((item, index) => ({
      name: unique(byTheme ? (themeNames[index] as string) : slug(item.theme.name), names),
      sources: item.entries,
    }));
    if (byTheme) values.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : 1));
    axes.push({
      name: unique(byTheme ? "theme" : slug(group) || "variant", takenAxes),
      kind: byTheme ? "theme" : "variant",
      values,
    });
  }
  for (const axis of axes) {
    for (const value of axis.values) {
      value.sources = value.sources.filter((entry) => !shared.includes(entry));
    }
  }
  if (axes.length === 0 && shared.length === 0) return undefined;
  return { shared, axes };
}

function readStudioThemes(list: unknown): StudioTheme[] {
  if (!Array.isArray(list)) return [];
  const themes: StudioTheme[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { name, group, selectedTokenSets } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof selectedTokenSets !== "object" || !selectedTokenSets) {
      continue;
    }
    const sets = Object.entries(selectedTokenSets as Record<string, unknown>)
      .filter(([, status]) => status === "enabled" || status === "source")
      .map(([set, status]) => ({ name: set, status: status as "enabled" | "source" }));
    themes.push({ name, group: typeof group === "string" ? group : "", sets });
  }
  return themes;
}

/** Every combination of axis values, named like "acme/dark", with all the files it loads. */
export function expandModes(plan: ModePlan): { name: string; sources: string[] }[] {
  let modes: { names: string[]; sources: string[] }[] = [{ names: [], sources: plan.shared }];
  for (const axis of plan.axes) {
    modes = modes.flatMap((mode) =>
      axis.values.map((value) => ({
        names: [...mode.names, value.name],
        sources: [...mode.sources, ...value.sources],
      })),
    );
  }
  return modes
    .map((mode) => ({ name: mode.names.join("/") || "default", sources: mode.sources }))
    .filter((mode) => mode.sources.length > 0);
}
