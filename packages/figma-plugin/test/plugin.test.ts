import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson } from "@pairlint/tokens-core";
import { Ajv } from "ajv";
import { afterAll, describe, expect, it } from "vitest";
import { formatJson } from "../../cli/src/report-json.js";
import { runCli } from "../../cli/test/helpers.js";
import { checkExport } from "../src/check.js";
import { exportSnapshot, TOKENS_FILE } from "../src/export.js";
import { readSnapshot } from "../src/snapshot.js";
import { escapeHtml, renderReport, VIEW_ROW_LIMIT } from "../src/view.js";
import { alias, COLLECTIONS, fakeApi, rgb, VARIABLES, variable } from "./fixture.js";

const scratch = mkdtempSync(join(tmpdir(), "pairlint-figma-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const schema = JSON.parse(readFileSync(new URL("../../cli/schema.json", import.meta.url), "utf8"));
const validate = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true }).compile(
  schema,
);

describe("readSnapshot", () => {
  it("reads color variables and skips other types", async () => {
    const snapshot = await readSnapshot(fakeApi());
    expect(snapshot.fileName).toBe("Design system");
    expect(snapshot.colorSpace).toBe("srgb");
    expect(snapshot.collections.map((c) => [c.name, c.modes.map((m) => m.name)])).toEqual([
      ["Primitives", ["Value"]],
      ["Semantic", ["Light", "Dark"]],
    ]);
    expect(snapshot.variables).toHaveLength(12);
    expect(snapshot.variables.find((v) => v.id === "v:text")?.valuesByMode).toEqual({
      "m:light": { kind: "alias", id: "v:g900" },
      "m:dark": { kind: "alias", id: "v:g50" },
    });
  });

  it("uses Display P3 when the document does", async () => {
    expect((await readSnapshot(fakeApi({ profile: "DISPLAY_P3" }))).colorSpace).toBe("display-p3");
    expect((await readSnapshot(fakeApi({ profile: "LEGACY" }))).colorSpace).toBe("srgb");
  });

  it("resolves library variables through their aliases in the default mode", async () => {
    const library = {
      "lib:a": variable("lib:a", "brand/primary", "c:lib", { "m:lib": alias("lib:b") }),
      "lib:b": variable("lib:b", "palette/blue", "c:lib", { "m:lib": rgb("#0057ff") }),
    };
    const variables = [
      variable("v:link", "text/link", "c:prim", { "m:value": alias("lib:a") }),
      variable("v:gone", "text/gone", "c:prim", { "m:value": alias("lib:missing") }),
    ];
    const snapshot = await readSnapshot(fakeApi({ variables, library }));
    expect(snapshot.external["lib:a"]).toEqual({
      name: "brand/primary",
      value: rgb("#0057ff"),
    });
    expect(snapshot.external["lib:missing"]).toEqual({ name: "lib:missing", value: undefined });
  });

  it("stops at alias loops in libraries", async () => {
    const library = {
      "lib:a": variable("lib:a", "a", "c:lib", { "m:lib": alias("lib:b") }),
      "lib:b": variable("lib:b", "b", "c:lib", { "m:lib": alias("lib:a") }),
    };
    const variables = [variable("v:x", "x", "c:prim", { "m:value": alias("lib:a") })];
    const snapshot = await readSnapshot(fakeApi({ variables, library }));
    expect(snapshot.external["lib:a"]?.value).toBeUndefined();
  });
});

describe("exportSnapshot", () => {
  it("writes one DTCG set per collection and mode, with aliases", async () => {
    const result = exportSnapshot(await readSnapshot(fakeApi()));
    const tokens = JSON.parse(result.tokens);
    expect(Object.keys(tokens)).toEqual([
      "$description",
      "Primitives",
      "Semantic/Light",
      "Semantic/Dark",
    ]);
    expect(tokens.Primitives.color.gray["900"]).toEqual({
      $type: "color",
      $value: { colorSpace: "srgb", components: [0.058824, 0.090196, 0.164706], hex: "#0f172a" },
      $extensions: { "com.figma": { variableId: "v:g900", scopes: ["ALL_SCOPES"] } },
    });
    expect(tokens["Semantic/Dark"].text.primary).toMatchObject({
      $value: "{color.gray.50}",
      $description: "Body text",
    });
    expect(result.colorCount).toBe(12);
    expect(result.warnings).toEqual([]);
  });

  it("keeps alpha, and leaves out hex for Display P3", async () => {
    const variables = [variable("v:a", "overlay", "c:prim", { "m:value": rgb("#000000", 0.5) })];
    const srgb = JSON.parse(exportSnapshot(await readSnapshot(fakeApi({ variables }))).tokens);
    expect(srgb.Primitives.overlay.$value).toEqual({
      colorSpace: "srgb",
      components: [0, 0, 0],
      alpha: 0.5,
      hex: "#000000",
    });
    const p3 = JSON.parse(
      exportSnapshot(await readSnapshot(fakeApi({ variables, profile: "DISPLAY_P3" }))).tokens,
    );
    expect(p3.Primitives.overlay.$value).toEqual({
      colorSpace: "display-p3",
      components: [0, 0, 0],
      alpha: 0.5,
    });
  });

  it("cleans names DTCG cannot use and moves tokens that are also groups", async () => {
    const variables = [
      variable("v:a", "brand/blue", "c:prim", { "m:value": rgb("#0000ff") }),
      variable("v:b", "brand/blue/500", "c:prim", { "m:value": rgb("#0000cc") }),
      variable("v:c", " text / v1.2 {x} ", "c:prim", { "m:value": rgb("#111111") }),
      variable("v:d", "/", "c:prim", { "m:value": rgb("#222222") }),
    ];
    const result = exportSnapshot(await readSnapshot(fakeApi({ variables })));
    const tokens = JSON.parse(result.tokens);
    expect(tokens.Primitives.brand.blue.default.$value.hex).toBe("#0000ff");
    expect(tokens.Primitives.brand.blue["500"].$value.hex).toBe("#0000cc");
    expect(tokens.Primitives.text["v1-2 -x-"].$value.hex).toBe("#111111");
    expect(result.warnings).toEqual([
      "A variable with an empty name (v:d) was skipped.",
      '"brand/blue" is also a group, so it was exported as "brand/blue/default".',
    ]);
  });

  it("inlines library colors and warns about modes with no color", async () => {
    const library = {
      "lib:a": variable("lib:a", "brand/primary", "c:lib", { "m:lib": rgb("#0057ff") }),
    };
    const variables = [
      variable("v:link", "text/link", "c:prim", { "m:value": alias("lib:a") }),
      variable("v:gone", "text/gone", "c:prim", { "m:value": alias("lib:missing") }),
    ];
    const result = exportSnapshot(await readSnapshot(fakeApi({ variables, library })));
    const tokens = JSON.parse(result.tokens);
    expect(tokens.Primitives.text.link.$value.hex).toBe("#0057ff");
    expect(tokens.Primitives.text.link.$extensions["com.pairlint"]).toEqual({
      inlinedFrom: "brand/primary",
    });
    expect(tokens.Primitives.text.gone).toBeUndefined();
    expect(result.warnings).toEqual([
      '"text/gone" has no color in one of its modes and was left out there.',
    ]);
  });

  it("writes a config with shared sets and one mode per theme", async () => {
    const result = exportSnapshot(await readSnapshot(fakeApi()));
    expect(result.config.split("\n")[0]).toContain("Pairs inferred from variable names");
    const config = parseJson(result.config, { jsonc: true }).value as Record<string, unknown>;
    expect(config.tokens).toEqual([`${TOKENS_FILE}#Primitives`]);
    expect(config.modes).toEqual({
      Light: [`${TOKENS_FILE}#Semantic/Light`],
      Dark: [`${TOKENS_FILE}#Semantic/Dark`],
    });
    expect(config.pairs).toEqual([
      { fg: ["text.*"], bg: ["surface.*"] },
      {
        fg: ["text.on-brand"],
        bg: ["surface.*"],
        use: "exempt",
        reason: "On- colors sit on their own fill, which is checked separately",
      },
      { fg: ["text.on-brand"], bg: ["brand.fill"] },
    ]);
    expect(validate(config)).toBe(true);
  });

  it("turns several themed collections into brand × theme groups", async () => {
    const collections = [
      ...COLLECTIONS,
      {
        id: "c:brand",
        name: "Brand",
        modes: [
          { modeId: "m:acme", name: "Acme" },
          { modeId: "m:light2", name: "Light" },
        ],
      },
    ];
    const variables = [
      ...VARIABLES,
      variable("v:accent", "brand/accent", "c:brand", {
        "m:acme": rgb("#ff0000"),
        "m:light2": rgb("#00ff00"),
      }),
    ];
    const result = exportSnapshot(await readSnapshot(fakeApi({ variables, collections })));
    const config = parseJson(result.config, { jsonc: true }).value as Record<string, unknown>;
    expect(config.modes).toEqual({
      Semantic: {
        Light: [`${TOKENS_FILE}#Semantic/Light`],
        Dark: [`${TOKENS_FILE}#Semantic/Dark`],
      },
      Brand: {
        Acme: [`${TOKENS_FILE}#Brand/Acme`],
        "Brand-Light": [`${TOKENS_FILE}#Brand/Light`],
      },
    });
    expect(validate(config)).toBe(true);
  });

  it("uses tokens alone when no collection has modes", async () => {
    const variables = [
      variable("v:t", "text/body", "c:prim", { "m:value": rgb("#111111") }),
      variable("v:s", "surface/page", "c:prim", { "m:value": rgb("#ffffff") }),
    ];
    const result = exportSnapshot(await readSnapshot(fakeApi({ variables })));
    const config = parseJson(result.config, { jsonc: true }).value as Record<string, unknown>;
    expect(config.tokens).toEqual([`${TOKENS_FILE}#Primitives`]);
    expect(config.modes).toBeUndefined();
  });

  it("says so when names do not show text and backgrounds", async () => {
    const variables = [variable("v:x", "palette/red", "c:prim", { "m:value": rgb("#ff0000") })];
    const result = exportSnapshot(await readSnapshot(fakeApi({ variables })));
    expect(result.config).toContain("could not tell text variables from backgrounds");
  });
});

describe("checkExport", () => {
  it("finds the same failures as the command line on the exported files", async () => {
    const exported = exportSnapshot(await readSnapshot(fakeApi()));
    const outcome = checkExport(exported.tokens, exported.config);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const dir = mkdtempSync(join(scratch, "cli-"));
    writeFileSync(join(dir, TOKENS_FILE), exported.tokens);
    writeFileSync(join(dir, "pairlint.config.json"), exported.config);
    const cli = runCli(["--format", "json"], { cwd: dir });
    expect(cli.stderr).toBe("");
    expect(cli.stdout).toBe(formatJson(outcome.report));

    // Gray 600 text on the dark surfaces, and dark text on the blue fill, fail in Dark only.
    const failed = outcome.report.results.filter((r) => r.status === "fail");
    expect(failed.map((r) => `${r.mode}: ${r.fg} on ${r.bg}`)).toEqual([
      "Dark: text.muted on surface.base",
      "Dark: text.muted on surface.raised",
      "Dark: text.on-brand on brand.fill",
    ]);
  });

  it("reports config mistakes with their line", () => {
    const outcome = checkExport("{}", '{\n  "tokens": "x.json",\n  "pears": []\n}');
    expect(outcome).toMatchObject({ ok: false, line: 3 });
    if (!outcome.ok) expect(outcome.error).toContain('Unknown setting "pears"');
  });

  it("refuses to read any file but the export", () => {
    const outcome = checkExport(
      "{}",
      '{ "tokens": "../secrets.json", "pairs": [{ "fg": "a", "bg": "b" }] }',
    );
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.error).toContain(`can only read ${TOKENS_FILE}`);
  });
});

describe("renderReport", () => {
  const report = (results: object[]) =>
    ({ level: "AA", modes: ["Dark"], results, warnings: [] }) as Parameters<typeof renderReport>[0];
  const fail = {
    mode: "Dark",
    fg: "text.muted",
    bg: "surface.base",
    use: "body",
    status: "fail",
    ratio: 3.75,
    required: 4.5,
    criterion: "1.4.3",
    criterionLevel: "AA",
    fgColor: "#64748b",
    bgColor: "#0f172a",
  };

  it("shows each failure with a sample, the ratio and the fix", () => {
    const html = renderReport(
      report([
        {
          ...fail,
          suggestion: {
            kind: "token",
            side: "fg",
            token: "text.muted",
            value: "{color.gray.400}",
            color: "#94a3b8",
            ratio: 6.96,
          },
        },
      ]),
    );
    expect(html).toContain('<p class="headline bad">1 problem</p>');
    expect(html).toContain('style="background:#0f172a;color:#64748b"');
    expect(html).toContain("3.75:1 (#64748b on #0f172a), needs 4.5:1 for body text");
    expect(html).toContain("Try: point text.muted at {color.gray.400} (6.96:1)");
  });

  it("celebrates a clean run", () => {
    expect(renderReport(report([{ ...fail, status: "pass", ratio: 9 }]))).toContain(
      '<p class="headline ok">All 1 pair passes</p>',
    );
  });

  it("escapes names from the file and never puts other values in styles", () => {
    const html = renderReport(
      report([
        {
          ...fail,
          fg: '<img src=x onerror="alert(1)">',
          mode: "Dark",
          fgColor: "red;background:url(x)",
        },
      ]),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("color:transparent");
    expect(escapeHtml(`'&`)).toBe("&#39;&amp;");
  });

  it("caps long lists", () => {
    const many = Array.from({ length: VIEW_ROW_LIMIT + 3 }, (_, i) => ({ ...fail, fg: `t${i}` }));
    expect(renderReport(report(many))).toContain("And 3 more in this mode.");
  });
});

describe("plugin build", () => {
  const root = new URL("..", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));

  it("blocks all network access and asks for no permissions", () => {
    expect(manifest.networkAccess).toEqual({ allowedDomains: ["none"] });
    expect(manifest.permissions).toEqual([]);
    expect(manifest.documentAccess).toBe("dynamic-page");
  });

  it("bundles a main thread file and a self-contained panel", () => {
    const result = spawnSync(process.execPath, ["build.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const code = readFileSync(new URL(manifest.main, root), "utf8");
    const ui = readFileSync(new URL(manifest.ui, root), "utf8");
    expect(code).toContain("figma.showUI");
    expect(ui).toContain("default-src 'none'");
    expect(ui).not.toContain("<!-- script -->");
    expect(ui.match(/<script>/g)).toHaveLength(1);
    expect(ui.match(/<\/script>/g)).toHaveLength(1);
    expect(ui).not.toMatch(/(?:src|href)=["']https?:/);
  });
});
