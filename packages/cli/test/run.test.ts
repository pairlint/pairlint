import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { fixture, runCli } from "./helpers.js";

describe("pairlint on sample projects", () => {
  it("reports failures across light and dark modes", async () => {
    const result = runCli([], { cwd: fixture("dtcg-modes") });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/dtcg-modes/expected.txt");
  });

  it("lists every pair with --verbose", async () => {
    const result = runCli(["--verbose"], { cwd: fixture("dtcg-modes") });
    expect(result.code).toBe(1);
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/dtcg-modes/expected-verbose.txt");
  });

  it("writes a stable JSON report", async () => {
    const result = runCli(["check", "--format", "json"], { cwd: fixture("dtcg-modes") });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.schemaVersion).toBe(1);
    expect(report.summary.checked).toBe(report.results.length);
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/dtcg-modes/expected.json");
  });

  it("checks only the requested modes", () => {
    const result = runCli(["--mode", "light", "--format", "json"], { cwd: fixture("dtcg-modes") });
    const report = JSON.parse(result.stdout);
    expect(report.modes).toEqual(["light"]);
    expect(new Set(report.results.map((r: { mode: string }) => r.mode))).toEqual(
      new Set(["light"]),
    );
  });

  it("gets stricter at AAA", () => {
    const aa = JSON.parse(runCli(["-f", "json"], { cwd: fixture("dtcg-modes") }).stdout);
    const aaa = JSON.parse(
      runCli(["-f", "json", "-l", "aaa"], { cwd: fixture("dtcg-modes") }).stdout,
    );
    expect(aaa.level).toBe("AAA");
    expect(aaa.summary.failed).toBeGreaterThan(aa.summary.failed);
  });

  it("passes a Tokens Studio project with sets", async () => {
    const result = runCli([], { cwd: fixture("tokens-studio") });
    expect(result.code).toBe(0);
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/tokens-studio/expected.txt");
  });

  it("exits 2 when tokens cannot be resolved or parsed", async () => {
    const result = runCli([], { cwd: fixture("broken") });
    expect(result.code).toBe(2);
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/broken/expected.txt");
  });

  it("accepts --config from another folder", () => {
    const result = runCli(["--config", "tokens-studio/pairlint.config.json"], { cwd: fixture("") });
    expect(result.code).toBe(0);
  });
});

describe("pairlint options", () => {
  const cwd = fixture("dtcg-modes");

  it("prints help and version", () => {
    expect(runCli(["--help"], { cwd }).stdout).toContain("pairlint explain <fg> <bg>");
    expect(runCli(["-v"], { cwd })).toEqual({ code: 0, stdout: "0.0.0-test\n", stderr: "" });
  });

  it.each([
    [["--nope"], "Unknown option '--nope'"],
    [["lint"], 'Unknown command "lint"'],
    [["--format", "xml"], 'Unknown format "xml"'],
    [["--level", "A"], 'Unknown level "A"'],
    [["--mode", "sepia"], 'Unknown mode "sepia". The config defines: light, dark'],
    [["--config", "missing.json"], "Cannot find the config file missing.json"],
  ])("rejects %j with exit code 2", (argv, message) => {
    const result = runCli(argv, { cwd });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  it("explains how to start when there is no config", () => {
    const result = runCli([], { cwd: fixture("") });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No pairlint.config.json");
  });

  it("uses color only when it should", () => {
    const ansi = "\u001b[";
    expect(runCli([], { cwd, isTTY: true }).stdout).toContain(ansi);
    expect(runCli([], { cwd, isTTY: false }).stdout).not.toContain(ansi);
    expect(runCli([], { cwd, isTTY: true, env: { NO_COLOR: "1" } }).stdout).not.toContain(ansi);
    expect(runCli([], { cwd, isTTY: false, env: { FORCE_COLOR: "1" } }).stdout).toContain(ansi);
    expect(runCli(["--color"], { cwd }).stdout).toContain(ansi);
    expect(runCli(["--no-color"], { cwd, isTTY: true }).stdout).not.toContain(ansi);
    expect(runCli([], { cwd, isTTY: true, env: { TERM: "dumb" } }).stdout).not.toContain(ansi);
  });

  it("exits 3 with a bug report hint on unexpected errors", () => {
    let stderr = "";
    const code = run({
      argv: [],
      cwd,
      env: {},
      stdout: () => {
        throw new Error("stdout closed");
      },
      stderr: (text) => {
        stderr += text;
      },
      isTTY: false,
      version: "0",
    });
    expect(code).toBe(3);
    expect(stderr).toContain("Please report it at https://github.com/pairlint/pairlint/issues");
    expect(stderr).toContain("stdout closed");
  });
});

describe("pairlint explain", () => {
  const cwd = fixture("dtcg-modes");

  it("walks through one pair in every mode", async () => {
    const result = runCli(["explain", "color.text.secondary", "color.surface.raised"], { cwd });
    expect(result.code).toBe(1);
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/dtcg-modes/expected-explain.txt");
  });

  it("explains in JSON for one mode", () => {
    const result = runCli(
      ["explain", "color.text.secondary", "color.surface.raised", "-m", "light", "-f", "json"],
      { cwd },
    );
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.explanations).toHaveLength(1);
    expect(output.explanations[0].fg.chain).toEqual(["color.text.secondary", "color.gray.700"]);
  });

  it("needs exactly two tokens", () => {
    const result = runCli(["explain", "color.text.secondary"], { cwd });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("explain needs a foreground and a background token");
  });
});
