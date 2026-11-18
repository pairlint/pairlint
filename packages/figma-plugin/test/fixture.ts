import type { FigmaVariable, Snapshot, VariablesApi } from "../src/snapshot.js";

const rgb = (hex: string, a = 1) => ({
  r: Number.parseInt(hex.slice(1, 3), 16) / 255,
  g: Number.parseInt(hex.slice(3, 5), 16) / 255,
  b: Number.parseInt(hex.slice(5, 7), 16) / 255,
  a,
});
const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });

/** A small but realistic file: a primitive palette and semantic colors in Light and Dark. */
export const COLLECTIONS = [
  { id: "c:prim", name: "Primitives", modes: [{ modeId: "m:value", name: "Value" }] },
  {
    id: "c:sem",
    name: "Semantic",
    modes: [
      { modeId: "m:light", name: "Light" },
      { modeId: "m:dark", name: "Dark" },
    ],
  },
];

const variable = (
  id: string,
  name: string,
  collection: string,
  valuesByMode: Record<string, unknown>,
  description = "",
): FigmaVariable => ({
  id,
  name,
  description,
  resolvedType: Object.values(valuesByMode).some((value) => typeof value === "number")
    ? "FLOAT"
    : "COLOR",
  variableCollectionId: collection,
  scopes: ["ALL_SCOPES"],
  valuesByMode,
});

export const VARIABLES: FigmaVariable[] = [
  variable("v:white", "color/white", "c:prim", { "m:value": rgb("#ffffff") }),
  variable("v:g50", "color/gray/50", "c:prim", { "m:value": rgb("#f8fafc") }),
  variable("v:g600", "color/gray/600", "c:prim", { "m:value": rgb("#475569") }),
  variable("v:g800", "color/gray/800", "c:prim", { "m:value": rgb("#1e293b") }),
  variable("v:g900", "color/gray/900", "c:prim", { "m:value": rgb("#0f172a") }),
  variable("v:blue", "color/blue/600", "c:prim", { "m:value": rgb("#2563eb") }),
  variable(
    "v:text",
    "text/primary",
    "c:sem",
    { "m:light": alias("v:g900"), "m:dark": alias("v:g50") },
    "Body text",
  ),
  variable("v:muted", "text/muted", "c:sem", {
    "m:light": alias("v:g600"),
    "m:dark": alias("v:g600"),
  }),
  variable("v:onbrand", "text/on-brand", "c:sem", {
    "m:light": alias("v:white"),
    "m:dark": alias("v:g900"),
  }),
  variable("v:surface", "surface/base", "c:sem", {
    "m:light": alias("v:white"),
    "m:dark": alias("v:g900"),
  }),
  variable("v:raised", "surface/raised", "c:sem", {
    "m:light": alias("v:g50"),
    "m:dark": alias("v:g800"),
  }),
  variable("v:brand", "brand/fill", "c:sem", {
    "m:light": alias("v:blue"),
    "m:dark": alias("v:blue"),
  }),
  variable("v:spacing", "space/4", "c:prim", { "m:value": 4 }),
];

/** A fake of the Figma variables API, with an optional library variable reachable by id. */
export function fakeApi(
  options: {
    variables?: FigmaVariable[];
    collections?: typeof COLLECTIONS;
    library?: Record<string, FigmaVariable>;
    profile?: VariablesApi["documentColorProfile"];
  } = {},
): VariablesApi {
  const variables = options.variables ?? VARIABLES;
  const collections = options.collections ?? COLLECTIONS;
  const all = new Map(
    [...variables, ...Object.values(options.library ?? {})].map((v) => [v.id, v]),
  );
  return {
    rootName: "Design system",
    documentColorProfile: options.profile ?? "SRGB",
    getLocalVariableCollectionsAsync: async () => collections,
    getLocalVariablesAsync: async () => variables,
    getVariableByIdAsync: async (id) => all.get(id) ?? null,
    getVariableCollectionByIdAsync: async (id) =>
      id === "c:lib" ? { defaultModeId: "m:lib" } : { defaultModeId: "m:value" },
  };
}

export type { Snapshot };
export { alias, rgb, variable };
