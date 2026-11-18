import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contrastRatio, parseColor } from "@pairlint/contrast";
import { afterAll, describe, expect, it } from "vitest";
import {
  type CheckReport,
  escapeData,
  escapeProperty,
  formatGithub,
  formatHtml,
  formatMarkdown,
  formatSarif,
  HTML_PALETTE,
  MARKDOWN_ROW_LIMIT,
  type PairResult,
  SARIF_RULES,
} from "../src/index.js";
import { fixture, runCli } from "./helpers.js";

const cwd = fixture("dtcg-modes");
const scratch = mkdtempSync(join(tmpdir(), "pairlint-reports-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function failing(overrides: Partial<PairResult> = {}): PairResult {
  return {
    mode: "light",
    fg: "text.muted",
    bg: "surface.base",
    use: "body",
    status: "fail",
    ratio: 3.2,
    required: 4.5,
    criterion: "1.4.3",
    criterionLevel: "AA",
    fgColor: "#888888",
    bgColor: "#ffffff",
    fgLocation: { file: "tokens/light.json", line: 4, column: 5 },
    ...overrides,
  };
}

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations: Array<{ physicalLocation: { region: { startLine: number } } }>;
  relatedLocations?: Array<{ message: { text: string } }>;
}

const report = (results: PairResult[]): CheckReport => ({
  level: "AA",
  modes: ["light"],
  results,
  warnings: [],
});

describe("SARIF report", () => {
  it("matches the golden file", async () => {
    const result = runCli(["--format", "sarif"], { cwd });
    expect(result.code).toBe(1);
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/dtcg-modes/expected.sarif");
  });

  it("has one result per failure and warning, with rules and locations", () => {
    const sarif = JSON.parse(runCli(["-f", "sarif"], { cwd }).stdout);
    expect(sarif.version).toBe("2.1.0");
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe("pairlint");
    expect(run.tool.driver.version).toBe("0.0.0-test");
    const results = run.results as SarifResult[];
    expect(results.filter((r) => r.level === "error")).toHaveLength(4);
    expect(results.filter((r) => r.level === "warning")).toHaveLength(1);
    for (const result of results) {
      expect(SARIF_RULES[result.ruleIndex]?.id).toBe(result.ruleId);
      expect(result.locations[0]?.physicalLocation.region.startLine).toBeGreaterThan(0);
    }
    const ui = results.find((r) => r.ruleId === "ui-contrast");
    expect(ui?.message.text).toContain("Try: point color.border.default at {color.gray.500}");
    expect(ui?.relatedLocations?.[0]?.message.text).toBe("Background color.surface.overlay");
  });

  it("writes locations relative to where pairlint runs", () => {
    const sarif = JSON.parse(
      runCli(["-f", "sarif", "-c", "dtcg-modes/pairlint.config.json"], { cwd: fixture("") }).stdout,
    );
    const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe("dtcg-modes/tokens/dark.json");
  });

  it("picks the rule from the pair's use", () => {
    const sarif = JSON.parse(
      formatSarif(
        report([
          failing({ use: "large", required: 3 }),
          failing({ fg: "a", criterion: undefined, required: 5 }),
          failing({ fg: "b", status: "error", message: "broken" }),
        ]),
        { version: "1", toUri: (file) => file },
      ),
    );
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId).sort()).toEqual([
      "custom-contrast",
      "large-text-contrast",
      "token-error",
    ]);
  });
});

describe("Markdown report", () => {
  it("matches the golden file", async () => {
    const result = runCli(["--format", "markdown"], { cwd });
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/dtcg-modes/expected.md");
  });

  it("celebrates a clean run in one line", () => {
    const markdown = formatMarkdown(report([failing({ status: "pass", ratio: 7 })]));
    expect(markdown.split("\n")[0]).toBe("### pairlint: all 1 pair passes");
    expect(markdown).not.toContain("|");
  });

  it("escapes table characters in token names", () => {
    const markdown = formatMarkdown(report([failing({ fg: "a|b", mode: "x|y" })]));
    expect(markdown).toContain("`a\\|b`");
    expect(markdown).toContain("| x\\|y |");
  });

  it("caps long tables", () => {
    const many = Array.from({ length: MARKDOWN_ROW_LIMIT + 7 }, (_, i) => failing({ fg: `t${i}` }));
    const markdown = formatMarkdown(report(many));
    expect(markdown.match(/^\| light /gm)).toHaveLength(MARKDOWN_ROW_LIMIT);
    expect(markdown).toContain("And 7 more.");
  });

  it("accepts md as a short name", () => {
    expect(runCli(["-f", "md"], { cwd }).stdout).toContain("### pairlint:");
  });
});

describe("GitHub annotations", () => {
  const toPath = (file: string) => `design/${file}`;

  it("matches the golden file", async () => {
    const result = runCli(["--format", "github"], { cwd, env: { GITHUB_WORKSPACE: fixture("") } });
    expect(result.code).toBe(1);
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/dtcg-modes/expected-github.txt");
  });

  it("annotates the foreground token with the ratio and the fix", () => {
    const output = formatGithub(
      report([
        failing({
          suggestion: {
            kind: "token",
            side: "fg",
            token: "text.muted",
            value: "{gray.700}",
            color: "#555555",
            ratio: 7.46,
          },
        }),
      ]),
      { toPath },
    );
    expect(output.split("\n")[0]).toBe(
      "::error title=Contrast%3A text.muted on surface.base (light),file=design/tokens/light.json,line=4,col=5::" +
        "3.20:1 (#888888 on #ffffff), needs 4.5:1 for body text (WCAG 1.4.3 AA).%0ATry: point text.muted at {gray.700} (7.46:1)",
    );
  });

  it("annotates token problems and warnings, and skips passing pairs", () => {
    const output = formatGithub(
      {
        ...report([
          failing({ status: "pass", ratio: 9 }),
          failing({ status: "error", message: 'Token "x" does not exist', fgLocation: undefined }),
        ]),
        warnings: [
          {
            mode: "light",
            message: "out of gamut",
            location: { file: "a.json", line: 2, column: 3 },
          },
        ],
      },
      { toPath },
    );
    expect(output).toBe(
      [
        '::error title=Cannot check text.muted on surface.base (light)::Token "x" does not exist',
        "::warning title=pairlint (light),file=design/a.json,line=2,col=3::out of gamut",
        "pairlint: 0 failed, 1 passed, 1 could not be checked across 1 mode (WCAG AA)",
        "",
      ].join("\n"),
    );
  });

  it("mentions an expired baseline entry", () => {
    const output = formatGithub(
      report([
        failing({
          baseline: { reason: "Old brand", owner: "@design", expires: "2026-01-01" },
          baselineExpired: true,
        }),
      ]),
      { toPath },
    );
    expect(output).toContain("expired on 2026-01-01");
  });

  it("escapes values so a token name cannot start another command", () => {
    expect(escapeData("50%\r\n::error::x")).toBe("50%25%0D%0A::error::x");
    expect(escapeProperty("a:b,c\nd")).toBe("a%3Ab%2Cc%0Ad");
    const output = formatGithub(report([failing({ fg: "evil\n::error::pwned", mode: "a,b" })]), {
      toPath,
    });
    expect(output.split("\n").filter((line) => line.startsWith("::"))).toHaveLength(1);
  });
});

describe("HTML report", () => {
  it("matches the golden file", async () => {
    const result = runCli(["--format", "html"], { cwd });
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/dtcg-modes/expected.html");
  });

  it("is a self-contained page with no scripts or external resources", () => {
    const html = runCli(["-f", "html"], { cwd }).stdout;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//i);
  });

  it("escapes everything that comes from token files", () => {
    const html = formatHtml(
      report([failing({ fg: '<img src=x onerror="alert(1)">', reason: "x", fgColor: "red;}" })]),
      { version: "1" },
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
    expect(html).not.toMatch(/style="[^"]*red/);
  });

  it("meets WCAG AA in its own colors, in light and dark", () => {
    for (const palette of [HTML_PALETTE.light, HTML_PALETTE.dark]) {
      const ratio = (fg: string, bg: string) =>
        contrastRatio(parseColor(fg).rgba, parseColor(bg).rgba);
      expect(ratio(palette.text, palette.page)).toBeGreaterThanOrEqual(7);
      expect(ratio(palette.muted, palette.page)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(palette.failText, palette.failBg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(palette.passText, palette.passBg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(palette.exemptText, palette.exemptBg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(palette.border, palette.page)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("--output", () => {
  it("writes the report to a file and nothing to the terminal", () => {
    const path = join(scratch, "report.html");
    const result = runCli(["-f", "html", "-o", path], { cwd, isTTY: true });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(readFileSync(path, "utf8")).toContain("<title>Contrast report</title>");
  });

  it("never writes color codes into a text file", () => {
    const path = join(scratch, "report.txt");
    runCli(["-o", path, "--color"], { cwd });
    expect(readFileSync(path, "utf8")).not.toContain("\u001b[");
  });

  it("explains when the file cannot be written", () => {
    const result = runCli(["-o", join(scratch, "missing-folder", "r.txt")], { cwd });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Cannot write");
  });

  it("limits explain to text and json", () => {
    const result = runCli(["explain", "color.text.secondary", "color.surface.base", "-f", "html"], {
      cwd,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('explain supports "text" and "json"');
  });
});
