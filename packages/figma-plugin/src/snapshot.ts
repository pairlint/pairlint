/**
 * Plain data read from a Figma file's color variables. The plugin's main thread builds it with the
 * Figma API; everything after that is pure code that tests can run without Figma.
 */
export interface Snapshot {
  fileName: string;
  /** The document color profile. Variable colors are stored in this space. */
  colorSpace: "srgb" | "display-p3";
  collections: SnapshotCollection[];
  variables: SnapshotVariable[];
  /**
   * Alias targets outside the local collections, such as library variables, resolved to their
   * color in their collection's default mode. Keyed by variable id.
   */
  external: Record<string, { name: string; value: SnapshotColor | undefined }>;
}

export interface SnapshotCollection {
  id: string;
  name: string;
  modes: { id: string; name: string }[];
}

export interface SnapshotVariable {
  id: string;
  name: string;
  description: string;
  collectionId: string;
  scopes: string[];
  valuesByMode: Record<string, SnapshotValue>;
}

export interface SnapshotColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type SnapshotValue =
  | ({ kind: "color" } & SnapshotColor)
  | { kind: "alias"; id: string }
  | { kind: "other" };

/** The parts of the Figma plugin API the snapshot needs, so tests can pass a fake. */
export interface VariablesApi {
  rootName: string;
  documentColorProfile: "LEGACY" | "SRGB" | "DISPLAY_P3";
  getLocalVariableCollectionsAsync(): Promise<
    { id: string; name: string; modes: readonly { modeId: string; name: string }[] }[]
  >;
  getLocalVariablesAsync(type: "COLOR"): Promise<FigmaVariable[]>;
  getVariableByIdAsync(id: string): Promise<FigmaVariable | null>;
  getVariableCollectionByIdAsync(id: string): Promise<{ defaultModeId: string } | null>;
}

export interface FigmaVariable {
  id: string;
  name: string;
  description: string;
  resolvedType: string;
  variableCollectionId: string;
  scopes: readonly string[];
  valuesByMode: Record<string, unknown>;
}

const MAX_ALIAS_DEPTH = 32;

export async function readSnapshot(api: VariablesApi): Promise<Snapshot> {
  const collections = await api.getLocalVariableCollectionsAsync();
  const variables = (await api.getLocalVariablesAsync("COLOR")).filter(
    (variable) => variable.resolvedType === "COLOR",
  );
  const local = new Set(variables.map((variable) => variable.id));
  const snapshot: Snapshot = {
    fileName: api.rootName,
    colorSpace: api.documentColorProfile === "DISPLAY_P3" ? "display-p3" : "srgb",
    collections: collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      modes: collection.modes.map((mode) => ({ id: mode.modeId, name: mode.name })),
    })),
    variables: variables.map((variable) => ({
      id: variable.id,
      name: variable.name,
      description: variable.description,
      collectionId: variable.variableCollectionId,
      scopes: [...variable.scopes],
      valuesByMode: Object.fromEntries(
        Object.entries(variable.valuesByMode).map(([mode, value]) => [mode, toValue(value)]),
      ),
    })),
    external: {},
  };

  for (const variable of snapshot.variables) {
    for (const value of Object.values(variable.valuesByMode)) {
      if (value.kind === "alias" && !local.has(value.id) && !(value.id in snapshot.external)) {
        snapshot.external[value.id] = await resolveExternal(api, value.id);
      }
    }
  }
  return snapshot;
}

/** Follows a library variable's aliases in each collection's default mode until a color. */
async function resolveExternal(
  api: VariablesApi,
  id: string,
): Promise<{ name: string; value: SnapshotColor | undefined }> {
  let current = id;
  let name = id;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
    const variable = await api.getVariableByIdAsync(current);
    if (!variable) return { name, value: undefined };
    if (depth === 0) name = variable.name;
    const collection = await api.getVariableCollectionByIdAsync(variable.variableCollectionId);
    const modeValue =
      variable.valuesByMode[collection?.defaultModeId ?? ""] ??
      Object.values(variable.valuesByMode)[0];
    const value = toValue(modeValue);
    if (value.kind === "color")
      return { name, value: { r: value.r, g: value.g, b: value.b, a: value.a } };
    if (value.kind !== "alias") return { name, value: undefined };
    current = value.id;
  }
  return { name, value: undefined };
}

function toValue(value: unknown): SnapshotValue {
  if (typeof value !== "object" || value === null) return { kind: "other" };
  const record = value as Record<string, unknown>;
  if (record.type === "VARIABLE_ALIAS" && typeof record.id === "string") {
    return { kind: "alias", id: record.id };
  }
  const { r, g, b, a } = record;
  if (typeof r === "number" && typeof g === "number" && typeof b === "number") {
    return { kind: "color", r, g, b, a: typeof a === "number" ? a : 1 };
  }
  return { kind: "other" };
}
