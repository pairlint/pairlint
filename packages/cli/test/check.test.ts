import { describe, expect, it } from "vitest";
import { exitCode, InputError, type PairResult, parseConfig, runCheck } from "../src/index.js";

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
