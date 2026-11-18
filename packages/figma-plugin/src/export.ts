import { inferPairs } from "../../cli/src/infer.js";
import type { Snapshot, SnapshotColor, SnapshotVariable } from "./snapshot.js";

/** The file name the plugin suggests. The config refers to it. */
export const TOKENS_FILE = "figma-variables.json";

export interface FigmaExport {
  /** DTCG JSON with one top-level set per collection and mode. */
  tokens: string;
  /** A pairlint.config.json that reads those sets as modes. */
  config: string;
  colorCount: number;
  warnings: string[];
}

/**
 * Turns color variables into DTCG. Each collection and mode becomes one top-level set, like
 * "Semantic/Dark", so a pairlint config can load the right sets per mode with "file#set".
 */
export function exportSnapshot(snapshot: Snapshot): FigmaExport {
  const warnings: string[] = [];
  const paths = tokenPaths(snapshot.variables, warnings);
  const byId = new Map(snapshot.variables.map((variable) => [variable.id, variable]));
  const document: Record<string, unknown> = {
    $description: `Color variables exported from the Figma file "${snapshot.fileName}" by the pairlint plugin.`,
  };
  const sets = new Map<string, string>();

  for (const collection of snapshot.collections) {
    const variables = snapshot.variables.filter((v) => v.collectionId === collection.id);
    if (variables.length === 0) continue;
    for (const mode of collection.modes) {
      const set = setName(collection.name, mode.name, collection.modes.length);
      sets.set(`${collection.id}\u0000${mode.id}`, set);
      const tree: Record<string, unknown> = {};
      for (const variable of variables) {
        const path = paths.get(variable.id);
        if (!path) continue;
        const token = toToken(variable, mode.id, snapshot, paths, byId, warnings);
        if (token) place(tree, path, token);
      }
      document[set] = tree;
    }
  }

  return {
    tokens: `${JSON.stringify(document, null, 2)}\n`,
    config: renderConfig(
      snapshot,
      sets,
      [...paths.values()].map((p) => p.join(".")),
    ),
    colorCount: paths.size,
    warnings,
  };
}

function setName(collection: string, mode: string, modeCount: number): string {
  const clean = (text: string) => text.trim().replace(/^\$+/, "").replace(/#/g, "-") || "Unnamed";
  return modeCount === 1 ? clean(collection) : `${clean(collection)}/${clean(mode)}`;
}

/**
 * Figma names like "color/text/primary" become DTCG paths. Characters DTCG reserves are replaced,
 * and a name that is also a group ("blue" next to "blue/500") moves to "blue/default".
 */
function tokenPaths(variables: SnapshotVariable[], warnings: string[]): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  for (const variable of variables) {
    const path = variable.name
      .split("/")
      .map((segment) => segment.trim().replace(/[.{}]/g, "-").replace(/^\$+/, ""))
      .filter((segment) => segment !== "");
    if (path.length === 0) {
      warnings.push(`A variable with an empty name (${variable.id}) was skipped.`);
      continue;
    }
    paths.set(variable.id, path);
  }
  const joined = new Set([...paths.values()].map((path) => path.join("/")));
  for (const [id, path] of paths) {
    const name = path.join("/");
    if ([...joined].some((other) => other.startsWith(`${name}/`))) {
      paths.set(id, [...path, "default"]);
      warnings.push(`"${name}" is also a group, so it was exported as "${name}/default".`);
    }
  }
  return paths;
}

function toToken(
  variable: SnapshotVariable,
  modeId: string,
  snapshot: Snapshot,
  paths: Map<string, string[]>,
  byId: Map<string, SnapshotVariable>,
  warnings: string[],
): Record<string, unknown> | undefined {
  const value = variable.valuesByMode[modeId];
  const token: Record<string, unknown> = { $type: "color" };
  if (value?.kind === "color") {
    token.$value = colorValue(value, snapshot.colorSpace);
  } else if (value?.kind === "alias" && byId.has(value.id) && paths.has(value.id)) {
    token.$value = `{${paths.get(value.id)?.join(".")}}`;
  } else if (value?.kind === "alias" && snapshot.external[value.id]?.value) {
    const external = snapshot.external[value.id];
    token.$value = colorValue(external?.value as SnapshotColor, snapshot.colorSpace);
    token.$extensions = { "com.pairlint": { inlinedFrom: external?.name } };
  } else {
    warnings.push(`"${variable.name}" has no color in one of its modes and was left out there.`);
    return undefined;
  }
  if (variable.description.trim() !== "") token.$description = variable.description.trim();
  token.$extensions = {
    ...(token.$extensions as Record<string, unknown> | undefined),
    "com.figma": { variableId: variable.id, scopes: variable.scopes },
  };
  return token;
}

function colorValue(color: SnapshotColor, colorSpace: Snapshot["colorSpace"]) {
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const value: Record<string, unknown> = {
    colorSpace,
    components: [round(color.r), round(color.g), round(color.b)],
  };
  if (color.a < 1) value.alpha = round(color.a);
  if (colorSpace === "srgb") value.hex = hex(color);
  return value;
}

function hex(color: SnapshotColor): string {
  const byte = (n: number) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

function place(tree: Record<string, unknown>, path: string[], token: Record<string, unknown>) {
  let node = tree;
  for (const segment of path.slice(0, -1)) {
    node[segment] ??= {};
    node = node[segment] as Record<string, unknown>;
  }
  node[path.at(-1) as string] = token;
}

/**
 * Collections with one mode load in every mode. One collection with several modes gives those
 * modes; several such collections become groups, so brand × theme files check every pairing.
 */
function renderConfig(snapshot: Snapshot, sets: Map<string, string>, colorIds: string[]): string {
  const entry = (collectionId: string, modeId: string) =>
    `${TOKENS_FILE}#${sets.get(`${collectionId}\u0000${modeId}`)}`;
  const used = snapshot.collections.filter((c) =>
    snapshot.variables.some((v) => v.collectionId === c.id),
  );
  const shared = used
    .filter((c) => c.modes.length === 1)
    .map((c) => entry(c.id, c.modes[0]?.id ?? ""));
  const themed = used.filter((c) => c.modes.length > 1);

  const config: Record<string, unknown> = { $schema: "./node_modules/pairlint/schema.json" };
  if (themed.length === 0) {
    config.tokens = shared;
  } else {
    if (shared.length > 0) config.tokens = shared;
    const taken = new Set<string>();
    const modeName = (collection: string, mode: string) => {
      let name = mode.trim().replace(/\//g, "-") || "Unnamed";
      if (taken.has(name)) name = `${collection.trim().replace(/\//g, "-")}-${name}`;
      taken.add(name);
      return name;
    };
    const modesOf = (c: (typeof themed)[number]) =>
      Object.fromEntries(c.modes.map((m) => [modeName(c.name, m.name), [entry(c.id, m.id)]]));
    config.modes =
      themed.length === 1 && themed[0]
        ? modesOf(themed[0])
        : Object.fromEntries(themed.map((c) => [c.name, modesOf(c)]));
  }
  const { pairs, guessed } = inferPairs(colorIds);
  config.pairs = pairs;

  const note = guessed
    ? "// pairlint could not tell text variables from backgrounds by their names. Edit these pairs.\n"
    : "// Pairs inferred from variable names. Check that each one is a real combination in your UI.\n";
  return `${note}${JSON.stringify(config, null, 2)}\n`;
}
