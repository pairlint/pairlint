import { describe, expect, it } from "vitest";
import {
  exitCode,
  explainPair,
  InputError,
  type PairResult,
  parseConfig,
  runCheck,
} from "../src/index.js";

function check(tokens: Record<string, unknown>, config: Record<string, unknown>) {
  const files: Record<string, string> = { "tokens.json": JSON.stringify(tokens) };
  const readFile = (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error(`unexpected read of ${path}`);
    return { path, text };
  };
  const parsed = parseConfig(
    JSON.stringify({ tokens: ["tokens.json"], ...config }),
    "pairlint.config.json",
  );
  return runCheck(parsed, readFile);
}

/** Runs a check over in-memory files, with a config that names them. */
function checkFiles(files: Record<string, string>, config: Record<string, unknown>) {
  const readFile = (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error(`unexpected read of ${path}`);
    return { path, text };
  };
  return runCheck(parseConfig(JSON.stringify(config), "pairlint.config.json"), readFile);
}

const color = (value: unknown) => ({ $type: "color", $value: value });
const byPair = (results: PairResult[]) =>
  Object.fromEntries(results.map((r) => [`${r.fg}|${r.bg}`, r]));

describe("runCheck", () => {
  it("composites translucent text over its background", () => {
    const report = check(
      { fg: color("rgb(0 0 0 / 50%)"), bg: color("#ffffff") },
      { pairs: [{ fg: "fg", bg: "bg" }] },
    );
    const [result] = report.results;
    expect(result?.fgColor).toBe("#808080");
    expect(result?.ratio).toBeCloseTo(3.98, 2);
    expect(result?.status).toBe("fail");
  });

  it("puts translucent backgrounds on the mode's base color", () => {
    const report = check(
      { fg: color("#ffffff"), scrim: color("rgb(0 0 0 / 50%)"), canvas: color("#000000") },
      { base: "{canvas}", pairs: [{ fg: "fg", bg: "scrim" }] },
    );
    expect(report.results[0]?.bgColor).toBe("#000000");
    expect(report.results[0]?.ratio).toBe(21);
  });

  it("uses a custom minimum when one is given", () => {
    const report = check(
      { fg: color("#767676"), bg: color("#ffffff") },
      { pairs: [{ fg: "fg", bg: "bg", min: 5 }] },
    );
    expect(report.results[0]).toMatchObject({ status: "fail", required: 5 });
    expect(report.results[0]?.criterion).toBeUndefined();
  });

  it("lets an exempt rule override other rules for the same pair", () => {
    const report = check(
      { text: { a: color("#eeeeee"), b: color("#000000") }, bg: color("#ffffff") },
      {
        pairs: [
          { fg: "text.*", bg: "bg" },
          { fg: "text.a", bg: "bg", use: "exempt", reason: "Disabled" },
        ],
      },
    );
    const results = byPair(report.results);
    expect(report.results).toHaveLength(2);
    expect(results["text.a|bg"]).toMatchObject({ status: "exempt", reason: "Disabled" });
    expect(results["text.b|bg"]?.status).toBe("pass");
    expect(exitCode(report)).toBe(0);
  });

  it("skips tokens of other types and never pairs a token with itself", () => {
    const report = check(
      { c: { a: color("#000"), b: color("#fff"), gap: { $type: "dimension", $value: "4px" } } },
      { pairs: [{ fg: "c.*", bg: "c.*" }] },
    );
    expect(report.results.map((r) => `${r.fg}|${r.bg}`).sort()).toEqual(["c.a|c.b", "c.b|c.a"]);
  });

  it("fails loudly when a pattern matches nothing", () => {
    expect(() => check({ bg: color("#fff") }, { pairs: [{ fg: "txt.*", bg: "bg" }] })).toThrow(
      '"txt.*" (fg) matched no color tokens in mode "default"',
    );
  });

  it("reports unresolvable tokens as errors with exit code 2", () => {
    const report = check(
      { fg: color("{missing}"), bg: color("#fff") },
      { pairs: [{ fg: "fg", bg: "bg" }] },
    );
    expect(report.results[0]).toMatchObject({
      status: "error",
      message: '"fg" refers to "{missing}", which does not exist',
    });
    expect(exitCode(report)).toBe(2);
  });

  it("reports a bad base color on every affected pair", () => {
    const report = check(
      { fg: color("#000"), bg: color("#fff") },
      { base: "nope", pairs: [{ fg: "fg", bg: "bg" }] },
    );
    expect(report.results[0]?.status).toBe("error");
    expect(report.results[0]?.message).toContain('Base color for mode "default"');
  });

  it("warns once per out-of-gamut token", () => {
    const report = check(
      { fg: color("color(display-p3 0 1 0)"), bg: color("#000"), bg2: color("#111") },
      { pairs: [{ fg: "fg", bg: ["bg", "bg2"] }] },
    );
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]?.message).toContain("outside the sRGB gamut");
  });

  it("turns token file problems into input errors", () => {
    expect(() =>
      runCheck(
        parseConfig('{"tokens": ["t.json"], "pairs": [{"fg": "a", "bg": "b"}]}', "c.json"),
        () => ({
          path: "t.json",
          text: "{",
        }),
      ),
    ).toThrow(InputError);
  });
});

describe("fix suggestions", () => {
  const gray = {
    100: color("#f1f3f4"),
    400: color("#9aa0a6"),
    500: color("#80868b"),
    600: color("#6c7177"),
    800: color("#3c4043"),
  };

  it("points an alias at the nearest passing shade in the same scale", () => {
    const report = check(
      { gray, text: color("{gray.500}"), bg: color("#ffffff") },
      { pairs: [{ fg: "text", bg: "bg" }] },
    );
    expect(report.results[0]?.suggestion).toMatchObject({
      kind: "token",
      side: "fg",
      token: "text",
      value: "{gray.600}",
    });
    expect(report.results[0]?.suggestion?.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("tries a nearby background shade when no foreground shade passes", () => {
    const report = check(
      { gray, text: color("#202124"), surface: color("{gray.800}") },
      { pairs: [{ fg: "text", bg: "surface", use: "large" }] },
    );
    expect(report.results[0]?.suggestion).toMatchObject({
      kind: "token",
      side: "bg",
      token: "surface",
      value: "{gray.600}",
    });
  });

  it("does not swing a background to the far end of its scale", () => {
    // gray.100 would pass, but it is a much lighter surface. Changing the text is the smaller fix.
    const report = check(
      { gray, text: color("#808080"), surface: color("{gray.400}") },
      { pairs: [{ fg: "text", bg: "surface", use: "large" }] },
    );
    expect(report.results[0]?.suggestion).toMatchObject({
      kind: "color",
      side: "fg",
      token: "text",
    });
  });

  it("offers a distant background shade when the text cannot change enough", () => {
    // On a mid gray, neither black nor white text reaches 7:1, so only the surface can move.
    const report = check(
      {
        g: { 100: color("#f1f3f4"), 500: color("#808080") },
        text: color("#000000"),
        surface: color("{g.500}"),
      },
      { pairs: [{ fg: "text", bg: "surface", min: 7 }] },
    );
    expect(report.results[0]?.suggestion).toMatchObject({
      kind: "token",
      side: "bg",
      value: "{g.100}",
    });
  });

  it("does not treat hue names as a scale", () => {
    const report = check(
      {
        base: { red: color("#ff0000"), green: color("#006600") },
        text: color("{base.red}"),
        bg: color("#ffffff"),
      },
      { pairs: [{ fg: "text", bg: "bg" }] },
    );
    expect(report.results[0]?.suggestion).toMatchObject({ kind: "color", side: "fg" });
  });

  it("finds shades named by words, like light and dark", () => {
    const report = check(
      {
        gray: { light: color("#cccccc"), medium: color("#767676"), dark: color("#111111") },
        text: color("{gray.light}"),
        bg: color("#ffffff"),
      },
      { pairs: [{ fg: "text", bg: "bg" }] },
    );
    expect(report.results[0]?.suggestion).toMatchObject({ value: "{gray.medium}" });
  });

  it("finds CSS shades by name and writes them as var()", () => {
    const report = checkFiles(
      {
        "t.css": `:root {
          --gray-400: #9aa0a6; --gray-700: #5f6368; --gray-muted: #000000;
          --text: var(--gray-400); --bg: #ffffff;
        }`,
      },
      { tokens: "t.css", pairs: [{ fg: "text", bg: "bg" }] },
    );
    expect(report.results[0]?.suggestion).toMatchObject({
      kind: "token",
      side: "fg",
      token: "text",
      value: "var(--gray-700)",
    });
  });

  it("adjusts lightness when the token is not an alias", () => {
    const report = check(
      { text: color("#9aa0a6"), bg: color("#ffffff") },
      { pairs: [{ fg: "text", bg: "bg" }] },
    );
    const suggestion = report.results[0]?.suggestion;
    expect(suggestion).toMatchObject({ kind: "color", side: "fg", token: "text" });
    expect(suggestion?.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(suggestion?.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("only suggests for failing pairs", () => {
    const report = check(
      { text: color("#000000"), bg: color("#ffffff") },
      { pairs: [{ fg: "text", bg: "bg" }] },
    );
    expect(report.results[0]?.suggestion).toBeUndefined();
  });
});

describe("explainPair", () => {
  const tokens = {
    gray: { 50: color("#f8f9fa"), 500: color("#80868b"), 900: color("#202124") },
    text: color("{gray.500}"),
    bg: color("{gray.900}"),
    scrim: color("rgb(255 255 255 / 10%)"),
  };
  const explain = (fg: string, bg: string, config: Record<string, unknown> = {}) => {
    const parsed = parseConfig(
      JSON.stringify({ tokens: ["tokens.json"], pairs: [{ fg: "text", bg: "bg" }], ...config }),
      "pairlint.config.json",
    );
    return explainPair(
      parsed,
      () => ({ path: "tokens.json", text: JSON.stringify(tokens) }),
      fg,
      bg,
    );
  };

  it("shows alias chains, colors, the base and the blended result", () => {
    const [explanation] = explain("text", "scrim", { base: "{gray.900}" });
    expect(explanation).toMatchObject({
      mode: "default",
      inPairs: false,
      fg: { token: "text", chain: ["text", "gray.500"], color: "#80868b" },
      bg: { token: "scrim", chain: ["scrim"], color: "#ffffff1a" },
      base: "#202124",
      result: { status: "fail", bgColor: "#36373a" },
    });
  });

  it("uses the config rule when one covers the pair", () => {
    const [explanation] = explain("text", "bg", {
      pairs: [{ fg: "text", bg: "bg", use: "large" }],
    });
    expect(explanation?.inPairs).toBe(true);
    expect(explanation?.result).toMatchObject({ use: "large", status: "pass", required: 3 });
  });

  it("reports tokens that do not exist", () => {
    const [explanation] = explain("nope", "bg");
    expect(explanation?.result.status).toBe("error");
    expect(explanation?.fg.error).toBe('Token "nope" does not exist');
  });
});

describe("modes built from groups", () => {
  const files = {
    "core.json": JSON.stringify({ text: color("#111111"), muted: color("#767676") }),
    "acme.json": JSON.stringify({ surface: color("#ffffff") }),
    "zen.json": JSON.stringify({ surface: color("#f4f4f4") }),
    "dark.json": JSON.stringify({ text: color("#eeeeee"), surface: color("#111111") }),
  };
  const config = {
    tokens: "core.json",
    modes: {
      brand: { acme: "acme.json", zen: "zen.json" },
      theme: { light: [], dark: "dark.json" },
    },
    pairs: [
      { fg: "text", bg: "surface" },
      { fg: "muted", bg: "surface", modes: ["light"] },
    ],
  };

  it("needs at least one file per mode", () => {
    expect(() => checkFiles(files, config)).toThrow(InputError);
  });

  it("checks each combination with later groups overriding earlier ones", () => {
    const report = checkFiles(files, {
      ...config,
      modes: {
        brand: { acme: "acme.json", zen: "zen.json" },
        theme: { light: "core.json", dark: "dark.json" },
      },
    });
    expect(report.modes).toEqual(["acme/light", "acme/dark", "zen/light", "zen/dark"]);
    const rows = report.results.map((r) => [r.mode, r.fg, r.fgColor, r.bgColor]);
    expect(rows).toEqual([
      ["acme/light", "text", "#111111", "#ffffff"],
      ["acme/light", "muted", "#767676", "#ffffff"],
      ["acme/dark", "text", "#eeeeee", "#111111"],
      ["zen/light", "text", "#111111", "#f4f4f4"],
      ["zen/light", "muted", "#767676", "#f4f4f4"],
      ["zen/dark", "text", "#eeeeee", "#111111"],
    ]);
  });

  it("limits a run to modes matching a group value", () => {
    const report = runCheck(
      parseConfig(
        JSON.stringify({
          ...config,
          modes: {
            brand: { acme: "acme.json", zen: "zen.json" },
            theme: { light: "core.json", dark: "dark.json" },
          },
        }),
        "pairlint.config.json",
      ),
      (path) => ({ path, text: files[path as keyof typeof files] }),
      { modes: ["zen"] },
    );
    expect(report.modes).toEqual(["zen/light", "zen/dark"]);
  });
});
