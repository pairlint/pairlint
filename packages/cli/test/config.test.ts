import { describe, expect, it } from "vitest";
import { InputError, parseConfig } from "../src/index.js";

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
    [{ tokens: ["t.json"], modes: { a: ["t.json"] }, pairs }, 'Use either "tokens"', '"modes"'],
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

  it("explains invalid JSON with a position", () => {
    expect(() => parseConfig('{"tokens": }', "c.json")).toThrow(/c\.json is not valid JSON/);
  });
});
