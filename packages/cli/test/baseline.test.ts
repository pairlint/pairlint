import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyBaseline,
  type CheckReport,
  InputError,
  isValidDate,
  type PairResult,
  parseBaseline,
  serializeBaseline,
  updateBaseline,
} from "../src/index.js";
import { fixture, runCli } from "./helpers.js";

const scratch = mkdtempSync(join(tmpdir(), "pairlint-baseline-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let copies = 0;
function copyFixture(name: string): string {
  const target = join(scratch, `${name}-${copies++}`);
  cpSync(fixture(name), target, { recursive: true });
  return target;
}

const entry = {
  mode: "light",
  fg: "text",
  bg: "bg",
  use: "body",
  reason: "Planned redesign",
  owner: "@team",
};
const baselineText = (entries: unknown[]) => JSON.stringify({ version: 1, entries }, null, 2);

function result(overrides: Partial<PairResult> = {}): PairResult {
  return {
    mode: "light",
    fg: "text",
    bg: "bg",
    use: "body",
    status: "fail",
    ratio: 3,
    required: 4.5,
    ...overrides,
  };
}
const report = (results: PairResult[], modes = ["light"]): CheckReport => ({
  level: "AA",
  modes,
  results,
  warnings: [],
});

describe("parseBaseline", () => {
  it("reads entries with their locations", () => {
    const baseline = parseBaseline(baselineText([{ ...entry, expires: "2027-01-31" }]), "b.json");
    expect(baseline.entries).toEqual([
      { ...entry, expires: "2027-01-31", location: { file: "b.json", line: 4, column: 5 } },
    ]);
  });

  it.each([
    [{ version: 2, entries: [] }, '"version" must be 1'],
    [{ version: 1 }, '"entries" must be a list'],
    [{ version: 1, entries: [], extra: 1 }, 'Unknown setting "extra"'],
    [{ version: 1, entries: [{ ...entry, reason: "" }] }, 'Baseline entries need a "reason"'],
    [{ version: 1, entries: [{ ...entry, owner: undefined }] }, 'need an "owner"'],
    [{ version: 1, entries: [{ ...entry, use: "exempt" }] }, '"use" must be'],
    [{ version: 1, entries: [{ ...entry, expires: "2027-02-30" }] }, '"expires" must be a date'],
    [{ version: 1, entries: [{ ...entry, ownr: "x" }] }, 'Did you mean "owner"?'],
    [{ version: 1, entries: [entry, entry] }, "is listed twice"],
  ])("rejects %j", (value, message) => {
    expect(() => parseBaseline(JSON.stringify(value, null, 2), "b.json")).toThrow(InputError);
    expect(() => parseBaseline(JSON.stringify(value, null, 2), "b.json")).toThrow(message);
  });

  it("validates real calendar dates", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2027-02-29")).toBe(false);
    expect(isValidDate("2027-1-01")).toBe(false);
  });
});

describe("applyBaseline", () => {
  const baseline = (entries: unknown[]) => parseBaseline(baselineText(entries), "b.json");

  it("accepts a covered failure until the entry expires", () => {
    const current = report([result()]);
    applyBaseline(current, baseline([{ ...entry, expires: "2026-06-01" }]), "2026-06-01");
    expect(current.results[0]).toMatchObject({ status: "baselined", baseline: { owner: "@team" } });

    const later = report([result()]);
    applyBaseline(later, baseline([{ ...entry, expires: "2026-06-01" }]), "2026-06-02");
    expect(later.results[0]).toMatchObject({ status: "fail", baselineExpired: true });
  });

  it("only matches the same mode, pair and use", () => {
    const current = report([result({ use: "large" }), result({ mode: "dark" })], ["light", "dark"]);
    applyBaseline(current, baseline([entry]), "2026-06-01");
    expect(current.results.map((r) => r.status)).toEqual(["fail", "fail"]);
  });

  it("warns about entries that pass now or are no longer checked", () => {
    const current = report([result({ status: "pass" })]);
    applyBaseline(current, baseline([entry, { ...entry, fg: "gone" }]), "2026-06-01");
    expect(current.warnings.map((w) => w.message)).toEqual([
      'Baseline entry text on bg (body) passes now. Run "pairlint baseline" to remove it.',
      'Baseline entry gone on bg (body) is no longer checked. Run "pairlint baseline" to remove it.',
    ]);
  });

  it("ignores entries for modes that were not checked", () => {
    const current = report([]);
    applyBaseline(current, baseline([{ ...entry, mode: "dark" }]), "2026-06-01");
    expect(current.warnings).toEqual([]);
  });
});

describe("updateBaseline", () => {
  const previous = parseBaseline(
    baselineText([
      { ...entry, fg: "kept", reason: "Original reason", expires: "2026-01-01" },
      { ...entry, fg: "fixed" },
      { ...entry, mode: "dark", fg: "other-mode" },
    ]),
    "b.json",
  );

  it("keeps old reasons, adds new failures and drops fixed pairs", () => {
    const update = updateBaseline(
      report([
        result({ fg: "kept", status: "fail", baselineExpired: true }),
        result({ fg: "fixed", status: "pass" }),
        result({ fg: "new" }),
        result({ fg: "skip", use: "exempt", status: "exempt" }),
      ]),
      previous,
      { reason: "New reason", owner: "@new", expires: "2027-01-01" },
      "2026-06-01",
    );
    expect(update).toMatchObject({ added: 1, kept: 2, removed: 1, expired: 1 });
    expect(update.entries.map((e) => [e.mode, e.fg, e.reason])).toEqual([
      ["dark", "other-mode", "Planned redesign"],
      ["light", "kept", "Original reason"],
      ["light", "new", "New reason"],
    ]);
  });

  it("writes stable, sorted JSON without locations", () => {
    const text = serializeBaseline(
      updateBaseline(report([result()]), previous, entry, "2026-06-01").entries,
    );
    expect(text).not.toContain("location");
    expect(JSON.parse(text).version).toBe(1);
    expect(text.endsWith("}\n")).toBe(true);
  });
});

describe("pairlint with a baseline file", () => {
  it("passes baselined failures, fails expired ones and warns about stale entries", async () => {
    const result = runCli([], { cwd: fixture("baselined") });
    expect(result.code).toBe(1);
    await expect(result.stdout).toMatchFileSnapshot("./fixtures/baselined/expected.txt");
  });

  it("lists baselined pairs with --verbose", () => {
    const result = runCli(["--verbose", "-m", "dark"], { cwd: fixture("baselined") });
    expect(result.stdout).toContain(
      "baselined until 2026-12-31, owner @design-systems: Border scale is being redrawn",
    );
  });

  it("reports everything as failing with --ignore-baseline", () => {
    const json = JSON.parse(
      runCli(["--ignore-baseline", "-f", "json"], { cwd: fixture("baselined") }).stdout,
    );
    expect(json.summary).toMatchObject({ failed: 4, baselined: 0 });
  });

  it("counts baselined pairs in JSON", () => {
    const json = JSON.parse(runCli(["-f", "json"], { cwd: fixture("baselined") }).stdout);
    expect(json.summary).toMatchObject({ failed: 2, baselined: 2 });
  });

  it("explains a broken baseline file with its line", () => {
    const dir = copyFixture("baselined");
    writeFileSync(join(dir, "pairlint.baseline.json"), baselineText([{ ...entry, owner: "" }]));
    const result = runCli([], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('need an "owner"');
    expect(result.stderr).toContain("pairlint.baseline.json:");
  });
});

describe("pairlint baseline", () => {
  it("needs a reason and an owner", () => {
    const result = runCli(["baseline", "--reason", "x"], { cwd: copyFixture("dtcg-modes") });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("needs --reason and --owner");
  });

  it("rejects a bad expiry date", () => {
    const result = runCli(["baseline", "--reason", "x", "--owner", "y", "--expires", "soon"], {
      cwd: copyFixture("dtcg-modes"),
    });
    expect(result.stderr).toContain("--expires must be a date");
  });

  it("only takes baseline options with the baseline command", () => {
    expect(runCli(["--reason", "x"], { cwd: fixture("dtcg-modes") }).stderr).toContain(
      'only work with "pairlint baseline"',
    );
  });

  it("writes current failures, then the check passes", () => {
    const dir = copyFixture("dtcg-modes");
    const write = runCli(
      ["baseline", "--reason", "Planned redesign", "--owner", "@team", "--expires", "2027-03-31"],
      { cwd: dir },
    );
    expect(write).toMatchObject({
      code: 0,
      stdout: "Wrote pairlint.baseline.json: 4 added, 0 kept, 0 removed.\n",
    });
    const saved = JSON.parse(readFileSync(join(dir, "pairlint.baseline.json"), "utf8"));
    expect(saved.entries).toHaveLength(4);
    expect(saved.entries[0]).toMatchObject({ reason: "Planned redesign", expires: "2027-03-31" });

    const check = runCli([], { cwd: dir });
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("4 baselined");
  });

  it("keeps old entries, removes stale ones and reports expired ones", () => {
    const dir = copyFixture("baselined");
    const result = runCli(["baseline", "--reason", "New", "--owner", "@new"], { cwd: dir });
    expect(result.stdout).toBe(
      "Wrote pairlint.baseline.json: 1 added, 3 kept, 2 removed.\n" +
        "1 kept entry has expired and will fail. Fix that pair or give it a new date.\n",
    );
    const saved = JSON.parse(readFileSync(join(dir, "pairlint.baseline.json"), "utf8"));
    expect(saved.entries.map((e: { fg: string; reason: string }) => e.reason)).toEqual([
      "Border scale is being redrawn",
      "Border scale is being redrawn",
      "New",
      "Waiting on the new gray ramp",
    ]);
  });

  it("does not create a file when everything passes", () => {
    const dir = copyFixture("tokens-studio");
    const result = runCli(["baseline", "--reason", "x", "--owner", "y"], { cwd: dir });
    expect(result.stdout).toBe("Nothing to baseline: every pair passes.\n");
    expect(existsSync(join(dir, "pairlint.baseline.json"))).toBe(false);
  });

  it("refuses to baseline pairs that cannot be checked", () => {
    const result = runCli(["baseline", "--reason", "x", "--owner", "y"], {
      cwd: copyFixture("broken"),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("2 pairs could not be checked");
  });

  it("refuses a baseline path outside the project", () => {
    const dir = copyFixture("tokens-studio");
    const config = JSON.parse(readFileSync(join(dir, "pairlint.config.json"), "utf8"));
    writeFileSync(
      join(dir, "pairlint.config.json"),
      JSON.stringify({
        ...config,
        baseline: "../outside.json",
        pairs: [{ fg: "text.*", bg: "bg.*", min: 21 }],
      }),
    );
    const result = runCli(["baseline", "--reason", "x", "--owner", "y"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("must be inside the project folder");
  });
});

describe("baselined pairs in other reports", () => {
  const cwd = fixture("baselined");

  it("leaves baselined pairs out of SARIF and notes expired entries", () => {
    const sarif = JSON.parse(runCli(["-f", "sarif"], { cwd }).stdout);
    const errors = sarif.runs[0].results.filter((r: { level: string }) => r.level === "error");
    expect(errors).toHaveLength(2);
    expect(JSON.stringify(errors)).toContain("Its baseline entry expired on 2026-05-01.");
  });

  it("counts them in Markdown and marks expired rows", () => {
    const markdown = runCli(["-f", "markdown"], { cwd }).stdout;
    expect(markdown).toContain("2 failed, 20 passed, 6 exempt, 2 baselined");
    expect(markdown).toContain("(baseline expired 2026-05-01)");
  });

  it("lists them in their own section of the HTML report", () => {
    const html = runCli(["-f", "html"], { cwd }).stdout;
    expect(html).toContain("<summary>2 baselined pairs</summary>");
    expect(html).toContain('<span class="badge baselined">Baselined</span>');
    expect(html).toContain("Baseline expired on 2026-05-01");
    expect(html).toContain("Baselined until 2026-12-31");
  });
});
