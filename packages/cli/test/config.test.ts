import { describe, expect, it } from "vitest";
import { InputError, MAX_MODES, modeMatches, modeNames, parseConfig } from "../src/index.js";

const parse = (value: unknown) =>
  parseConfig(JSON.stringify(value, null, 2), "pairlint.config.json");
const pairs = [{ fg: "text.*", bg: "bg.*" }];

/** The line the needle first appears on in the formatted config, or 1 for the whole file. */
function lineOf(value: unknown, needle: string | null): number {
  if (needle === null) return 1;
  const lines = JSON.stringify(value, null, 2).split("\n");
  const pairsLine = lines.findIndex((line) => line.includes('"pairs"'));
  const start = needle === "{" ? pairsLine + 1 : 0;
  return lines.findIndex((line, i) => i >= start && line.includes(needle)) + 1;
}

function errorOf(value: unknown): InputError {
  try {
    parse(value);
  } catch (error) {
    if (error instanceof InputError) return error;
    throw error;
  }
  throw new Error("expected an InputError");
}

describe("parseConfig", () => {
  it("fills in defaults for a single-mode config", () => {
    const config = parse({ tokens: "tokens.json", pairs });
    expect(config).toMatchObject({
      level: "AA",
      format: "auto",
      modes: [{ name: "default", sources: [{ path: "tokens.json" }], base: "#ffffff" }],
      pairs: [{ fg: ["text.*"], bg: ["bg.*"], use: "body" }],
    });
  });

  it("reads modes, sets, bases and pair options", () => {
    const config = parse({
      level: "AAA",
      format: "tokens-studio",
      modes: { light: ["t.json#core", "t.json#light"], dark: "t.json#dark" },
      base: { dark: "{bg.base}" },
      pairs: [
        { fg: ["a", "b.*"], bg: "c", use: "large", min: 5, modes: ["dark"] },
        { fg: "x", bg: "y", use: "exempt", reason: "Decorative" },
      ],
    });
    expect(config.level).toBe("AAA");
    expect(config.modes).toEqual([
      {
        name: "light",
        sources: [
          { path: "t.json", set: "core" },
          { path: "t.json", set: "light" },
        ],
        base: "#ffffff",
      },
      { name: "dark", sources: [{ path: "t.json", set: "dark" }], base: "{bg.base}" },
    ]);
    expect(config.pairs[0]).toMatchObject({
      fg: ["a", "b.*"],
      use: "large",
      min: 5,
      modes: ["dark"],
    });
    expect(config.pairs[1]).toMatchObject({ use: "exempt", reason: "Decorative" });
  });

  it("loads shared tokens first in every mode", () => {
    const config = parse({
      tokens: "core.json",
      modes: { light: "l.json", dark: "d.json" },
      pairs,
    });
    expect(config.modes.map((mode) => [mode.name, mode.sources.map((s) => s.path)])).toEqual([
      ["light", ["core.json", "l.json"]],
      ["dark", ["core.json", "d.json"]],
    ]);
  });

  it("accepts the style-dictionary format", () => {
    expect(parse({ tokens: "t.json", format: "style-dictionary", pairs }).format).toBe(
      "style-dictionary",
    );
  });

  it("combines groups of modes into every brand and theme pair", () => {
    const config = parse({
      tokens: ["core.json"],
      modes: {
        brand: { acme: ["acme.json"], zen: ["zen.css"] },
        theme: { light: ["light.json"], dark: ["theme.css#[data-theme=dark]"] },
      },
      pairs,
    });
    expect(config.modes.map((mode) => mode.name)).toEqual([
      "acme/light",
      "acme/dark",
      "zen/light",
      "zen/dark",
    ]);
    expect(config.modes[3]).toEqual({
      name: "zen/dark",
      axes: { brand: "zen", theme: "dark" },
      sources: [
        { path: "core.json" },
        { path: "zen.css" },
        { path: "theme.css", set: "[data-theme=dark]" },
      ],
      base: "#ffffff",
    });
    expect(modeNames(config.modes)).toEqual([
      "acme/light",
      "acme",
      "light",
      "acme/dark",
      "dark",
      "zen/light",
      "zen",
      "zen/dark",
    ]);
  });

  it("matches modes by full name or by group value", () => {
    const config = parse({
      modes: { brand: { acme: ["a.json"] }, theme: { light: ["l.json"], dark: ["d.json"] } },
      pairs,
    });
    const [light, dark] = config.modes;
    if (!light || !dark) throw new Error("expected two modes");
    expect(modeMatches(dark, "acme/dark")).toBe(true);
    expect(modeMatches(dark, "dark")).toBe(true);
    expect(modeMatches(dark, "acme")).toBe(true);
    expect(modeMatches(dark, "light")).toBe(false);
    expect(modeMatches(light, "acme/dark")).toBe(false);
  });

  it("sets base colors by group value, then by full name", () => {
    const config = parse({
      modes: {
        brand: { acme: ["a.json"], zen: ["z.json"] },
        theme: { light: ["l.json"], dark: ["d.json"] },
      },
      base: { zen: "#fafafa", dark: "#000000", "acme/dark": "{bg.acme}" },
      pairs: [{ fg: "a", bg: "b", modes: ["dark"] }],
    });
    expect(config.modes.map((mode) => [mode.name, mode.base])).toEqual([
      ["acme/light", "#ffffff"],
      ["acme/dark", "{bg.acme}"],
      ["zen/light", "#fafafa"],
      ["zen/dark", "#000000"],
    ]);
    expect(config.pairs[0]?.modes).toEqual(["dark"]);
  });

  it("refuses combinations past the mode limit", () => {
    const group = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`m${i}`, [`m${i}.json`]]),
    );
    const other = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`n${i}`, [`n${i}.json`]]),
    );
    expect(() => parse({ modes: { a: group, b: other }, pairs })).toThrow(
      `combine into 289 modes. pairlint allows up to ${MAX_MODES}`,
    );
  });

  it("accepts comments", () => {
    const config = parseConfig(
      '{\n  // tokens\n  "tokens": ["t.json"],\n  "pairs": [{"fg": "a", "bg": "b"},],\n}',
      "c.json",
    );
    expect(config.pairs).toHaveLength(1);
  });

  it.each([
    [
      { tokens: ["t.json"], pairs, levle: "AA" },
      'Unknown setting "levle". Did you mean "level"?',
      '"levle"',
    ],
    [
      { modes: { light: ["l.json"], brand: { acme: ["a.json"] } }, pairs },
      '"light" is a list of files, but "brand" is a group of modes',
      '"light"',
    ],
    [{ modes: { brand: {} }, pairs }, '"brand" needs at least one mode', '"brand"'],
    [{ modes: { brand: { "a/b": ["a.json"] } }, pairs }, 'cannot be empty or contain "/"', '"a/b"'],
    [{ modes: { brand: { acme: [] } }, pairs }, "List at least one token file", '"acme"'],
    [
      { tokens: ["t.json"], format: "css", pairs },
      "Files ending in .css are always read as CSS",
      '"format"',
    ],
    [
      { modes: { theme: { light: ["l.json"] } }, pairs: [{ fg: "a", bg: "b", modes: ["drak"] }] },
      'Unknown mode "drak"',
      '"drak"',
    ],
    [{ pairs }, "Say where your tokens are", null],
    [{ tokens: [], pairs }, "List at least one token file", '"tokens"'],
    [{ tokens: ["t.json#"], pairs }, 'has "#" but no set name', '"t.json#"'],
    [{ tokens: ["t.json"] }, 'Add a "pairs" list', null],
    [{ tokens: ["t.json"], pairs: [] }, "at least one pair", '"pairs"'],
    [{ tokens: ["t.json"], pairs: [{ fg: "a" }] }, 'This pair needs "bg"', "{"],
    [{ tokens: ["t.json"], pairs: [{ fg: "a..b", bg: "c" }] }, "empty segment", '"fg"'],
    [
      { tokens: ["t.json"], pairs: [{ fg: "a", bg: "b", use: "exempt" }] },
      'Exempt pairs need a "reason"',
      "{",
    ],
    [{ tokens: ["t.json"], pairs: [{ fg: "a", bg: "b", min: 30 }] }, "between 1 and 21", '"min"'],
    [
      { tokens: ["t.json"], pairs: [{ fg: "a", bg: "b", use: "Body" }] },
      'Did you mean "body"?',
      '"use"',
    ],
    [
      { tokens: ["t.json"], pairs: [{ fg: "a", bg: "b", colour: "x" }] },
      'Unknown setting "colour"',
      '"colour"',
    ],
    [
      { tokens: ["t.json"], pairs: [{ fg: "a", bg: "b", modes: ["dark"] }] },
      'Unknown mode "dark"',
      '"dark"',
    ],
    [
      { modes: { light: ["t.json"] }, base: { lihgt: "#fff" }, pairs },
      'Unknown mode "lihgt". Did you mean "light"?',
      '"lihgt"',
    ],
    [{ tokens: ["t.json"], level: "aa", pairs }, 'Did you mean "AA"?', '"level"'],
  ])("explains problems in %j", (value, message, needle) => {
    const error = errorOf(value);
    expect(error.message).toContain(message);
    expect(error.location?.file).toBe("pairlint.config.json");
    expect(error.location?.line).toBe(lineOf(value, needle));
  });

  it("refuses a mode name used in two groups and points at the second", () => {
    const value = { modes: { brand: { dark: ["a.json"] }, theme: { dark: ["d.json"] } }, pairs };
    const error = errorOf(value);
    expect(error.message).toContain('"dark" is in both "brand" and "theme"');
    expect(error.location?.line).toBe(lineOf(value, '"d.json"') - 1);
  });

  it("explains invalid JSON with a position", () => {
    expect(() => parseConfig('{"tokens": }', "c.json")).toThrow(/c\.json is not valid JSON/);
  });
});
