import { describe, expect, it } from "vitest";
import {
  clearlyNotColor,
  exitCode,
  explainPair,
  formatMarkdown,
  formatText,
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

describe("check output from real-world runs", () => {
  const brands = (zwolle: Record<string, unknown>) => ({
    "acme.json": JSON.stringify({
      text: color("#111111"),
      link: color("#0000ee"),
      bg: color("#ffffff"),
    }),
    "zwolle.json": JSON.stringify(zwolle),
  });
  const brandConfig = {
    modes: { brand: { acme: ["acme.json"], zwolle: ["zwolle.json"] } },
    pairs: [{ fg: ["text", "link"], bg: "bg" }],
  };

  it("skips a token missing in some modes with one warning", () => {
    const report = checkFiles(
      brands({ text: color("#111111"), bg: color("#ffffff") }),
      brandConfig,
    );
    expect(report.results.map((r) => `${r.mode} ${r.fg}`).sort()).toEqual([
      "acme link",
      "acme text",
      "zwolle text",
    ]);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        mode: "zwolle",
        message:
          '"link" (fg) does not exist in mode "zwolle", so pairs with it are skipped in this mode',
      }),
    ]);
    expect(exitCode(report)).toBe(0);
  });

  it("lists the modes in one warning when a token is missing in several", () => {
    const files = {
      ...brands({ text: color("#111111"), bg: color("#ffffff") }),
      "zen.json": JSON.stringify({ text: color("#111111"), bg: color("#ffffff") }),
    };
    const report = checkFiles(files, {
      ...brandConfig,
      modes: { brand: { acme: ["acme.json"], zwolle: ["zwolle.json"], zen: ["zen.json"] } },
    });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatchObject({
      mode: "2 modes",
      modes: ["zwolle", "zen"],
      message:
        '"link" (fg) does not exist in 2 of 3 modes (zwolle, zen), so pairs with it are skipped there',
    });
  });

  it("is still an error when a token is missing in every mode", () => {
    const files = brands({ text: color("#111111"), bg: color("#ffffff") });
    expect(() =>
      checkFiles(files, { ...brandConfig, pairs: [{ fg: "headline", bg: "bg" }] }),
    ).toThrow('"headline" (fg) does not exist in any of the 2 modes');
    expect(() => check({ bg: color("#fff") }, { pairs: [{ fg: "link", bg: "bg" }] })).toThrow(
      '"link" (fg) does not exist in mode "default"',
    );
    expect(() =>
      check(
        { size: { $type: "dimension", $value: "4px" }, bg: color("#fff") },
        { pairs: [{ fg: "size", bg: "bg" }] },
      ),
    ).toThrow('"size" (fg) is not a color in mode "default"');
  });

  it("skips wildcard matches that are clearly not colors", () => {
    const report = check(
      {
        text: {
          body: { value: "#111111" },
          size: { value: "16px" },
          family: { value: "Inter, system-ui, sans-serif" },
          weight: { value: 700 },
          font: { value: "var(--weight) var(--size) / var(--line-height)" },
          broken: { value: "#12345" },
        },
        bg: { value: "#ffffff" },
      },
      { format: "style-dictionary", pairs: [{ fg: "text.*", bg: "bg" }] },
    );
    expect(report.results.map((r) => [r.fg, r.status])).toEqual([
      ["text.body", "pass"],
      ["text.broken", "error"],
    ]);
  });

  it("still reports an exact id that is not a color", () => {
    const report = check(
      { text: { size: { value: "16px" } }, bg: { value: "#ffffff" } },
      { format: "style-dictionary", pairs: [{ fg: "text.size", bg: "bg" }] },
    );
    expect(report.results[0]?.status).toBe("error");
  });

  it("tells clear non-colors from values that may be broken colors", () => {
    for (const value of ["16px", "0.125rem", 1.5, "Inter, sans-serif", "bold", "0 1px 2px"]) {
      expect(clearlyNotColor(value)).toBe(true);
    }
    for (const value of ["#12345", "rgb(1 2)", "blu", "0 1px 2px #000", { colorSpace: "srgb" }]) {
      expect(clearlyNotColor(value)).toBe(false);
    }
  });

  it("gives a failing token one suggestion that passes on all its backgrounds", () => {
    const report = check(
      {
        gray: {
          "100": color("#eeeeee"),
          "400": color("#999999"),
          "500": color("#777777"),
          "700": color("#555555"),
          "900": color("#222222"),
        },
        text: color("{gray.500}"),
        page: color("#ffffff"),
        panel: color("#e0e0e0"),
      },
      { pairs: [{ fg: "text", bg: ["page", "panel"] }] },
    );
    const results = byPair(report.results);
    expect(results["text|page"]?.suggestion).toMatchObject({
      value: "{gray.700}",
      backgrounds: 2,
    });
    expect(results["text|panel"]?.suggestion).toMatchObject({
      value: "{gray.700}",
      backgrounds: 2,
    });
  });

  it("says so when no single shade passes on every background", () => {
    const report = check(
      {
        text: color("#777777"),
        light: color("#ffffff"),
        dark: color("#000000"),
        mid: color("#777777"),
      },
      { pairs: [{ fg: "text", bg: ["light", "dark", "mid"] }] },
    );
    const failing = report.results.filter((r) => r.status === "fail");
    expect(failing.length).toBeGreaterThan(0);
    for (const result of failing) {
      expect(result.suggestion).toBeUndefined();
      expect(result.note).toBe(
        "No single shade of text passes on all 3 backgrounds it is checked on in this mode",
      );
    }
  });

  it("prints the unrounded blend when a pair is within 0.02 of the minimum", () => {
    const report = check(
      { fg: color("#767676"), bg: color("rgb(255 255 255 / 99.5%)"), canvas: color("#000000") },
      { base: "{canvas}", pairs: [{ fg: "fg", bg: "bg" }] },
    );
    const [result] = report.results;
    expect(result?.ratio).toBeCloseTo(4.493, 3);
    expect(result?.bgExact).toBe("rgb(253.72 253.72 253.72)");
    expect(formatText(report, { color: false, verbose: false })).toContain(
      "Before rounding: background rgb(253.72 253.72 253.72)",
    );
    const far = check(
      { fg: color("#000000"), bg: color("rgb(255 255 255 / 50%)") },
      { pairs: [{ fg: "fg", bg: "bg" }] },
    );
    expect(far.results[0]?.bgExact).toBeUndefined();
  });

  it("warns when a dark mode blends translucent backgrounds over white", () => {
    const files = {
      "dark.json": JSON.stringify({
        text: color("#ffffff"),
        scrim: color("rgb(0 0 0 / 50%)"),
        canvas: color("#000000"),
      }),
    };
    const pairs = [{ fg: "text", bg: "scrim" }];
    const warned = checkFiles(files, { modes: { dark: ["dark.json"] }, pairs });
    expect(warned.warnings.map((w) => w.message)).toEqual([
      'Translucent backgrounds in this dark mode are blended over white. Set its base to your page background, like "base": { "dark": "{color.bg.canvas}" }',
    ]);
    const based = checkFiles(files, { modes: { dark: ["dark.json"] }, base: "{canvas}", pairs });
    expect(based.warnings).toEqual([]);
    const light = checkFiles(files, { modes: { light: ["dark.json"] }, pairs });
    expect(light.warnings).toEqual([]);
  });

  it("reports an unreadable token once in the text report, with the pairs it affects", () => {
    const report = check(
      {
        text: color("{missing}"),
        a: color("#ffffff"),
        b: color("#eeeeee"),
        c: color("#dddddd"),
      },
      { pairs: [{ fg: "text", bg: ["a", "b", "c"] }] },
    );
    expect(report.results.every((r) => r.errorToken === "text")).toBe(true);
    const text = formatText(report, { color: false, verbose: false });
    expect(text).toContain("✗ text could not be read (affects 3 pairs)");
    expect(text.match(/Cannot check/g)).toHaveLength(1);
    expect(formatMarkdown(report)).toContain("`text` (affects 3 pairs)");
  });
});
