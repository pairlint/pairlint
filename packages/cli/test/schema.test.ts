import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJson } from "@pairlint/tokens-core";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, InputError, PAIR_KEYS, parseConfig } from "../src/index.js";
import { fixture } from "./helpers.js";

const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8"));
const validate = new Ajv({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
}).compile(schema);

function parserAccepts(config: unknown): boolean {
  try {
    parseConfig(JSON.stringify(config), "pairlint.config.json");
    return true;
  } catch (error) {
    if (error instanceof InputError) return false;
    throw error;
  }
}

const pairs = [{ fg: "text.*", bg: "bg.*" }];

describe("schema.json", () => {
  it("lists the same settings as the config parser", () => {
    expect(Object.keys(schema.properties).sort()).toEqual([...CONFIG_KEYS].sort());
    expect(Object.keys(schema.definitions.pair.properties).sort()).toEqual([...PAIR_KEYS].sort());
  });

  it("accepts every sample project's config", () => {
    const root = fixture("");
    const configs = readdirSync(root).filter((name) =>
      readdirSync(join(root, name)).includes("pairlint.config.json"),
    );
    expect(configs.length).toBeGreaterThan(3);
    for (const name of configs) {
      const text = readFileSync(join(root, name, "pairlint.config.json"), "utf8");
      const valid = validate(parseJson(text, { jsonc: true }).value);
      expect({ name, errors: validate.errors ?? null }).toEqual({ name, errors: null });
      expect(valid).toBe(true);
    }
  });

  it.each([
    ["one mode", { tokens: "t.json", pairs }],
    ["shared files and modes", { tokens: ["core.json"], modes: { light: "l.json" }, pairs }],
    ["groups", { modes: { brand: { acme: "a.json" }, theme: { dark: ["d.css#.dark"] } }, pairs }],
    [
      "every pair option",
      {
        modes: { light: "l.json", dark: "d.json" },
        level: "AAA",
        format: "style-dictionary",
        base: { dark: "{gray.900}" },
        baseline: "accepted.json",
        pairs: [
          { fg: ["a", "b.*"], bg: "c", use: "large", min: 5, modes: ["dark"], reason: "Hero text" },
          { fg: "x", bg: "y", use: "exempt", reason: "Decorative" },
        ],
      },
    ],
  ])("agrees with the parser on a valid config: %s", (_name, config) => {
    expect(validate(config)).toBe(true);
    expect(parserAccepts(config)).toBe(true);
  });

  it.each([
    ["no pairs", { tokens: "t.json" }],
    ["no tokens or modes", { pairs }],
    ["empty pairs", { tokens: "t.json", pairs: [] }],
    ["unknown setting", { tokens: "t.json", pairs, levle: "AA" }],
    ["unknown pair setting", { tokens: "t.json", pairs: [{ fg: "a", bg: "b", colour: "x" }] }],
    ["lowercase level", { tokens: "t.json", pairs, level: "aa" }],
    ["css format", { tokens: "t.css", pairs, format: "css" }],
    ["exempt without a reason", { tokens: "t.json", pairs: [{ fg: "a", bg: "b", use: "exempt" }] }],
    ["ratio above 21", { tokens: "t.json", pairs: [{ fg: "a", bg: "b", min: 30 }] }],
    ["missing bg", { tokens: "t.json", pairs: [{ fg: "a" }] }],
    ["empty file list", { tokens: [], pairs }],
    ["set marker with no name", { tokens: "t.json#", pairs }],
    ["empty group", { modes: { brand: {} }, pairs }],
    ["slash in a group value", { modes: { brand: { "a/b": "a.json" } }, pairs }],
    ["lists mixed with groups", { modes: { light: "l.json", brand: { acme: "a.json" } }, pairs }],
    ["pattern with spaces", { tokens: "t.json", pairs: [{ fg: " a", bg: "b" }] }],
  ])("agrees with the parser on an invalid config: %s", (_name, config) => {
    expect(validate(config)).toBe(false);
    expect(parserAccepts(config)).toBe(false);
  });
});
