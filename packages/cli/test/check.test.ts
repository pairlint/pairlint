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

  it("tries the background scale when no foreground shade passes", () => {
    const report = check(
      { gray, text: color("#808080"), surface: color("{gray.400}") },
      { pairs: [{ fg: "text", bg: "surface", use: "large" }] },
    );
    expect(report.results[0]?.suggestion).toMatchObject({
      kind: "token",
      side: "bg",
      token: "surface",
      value: "{gray.100}",
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
