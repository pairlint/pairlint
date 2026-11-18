import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson } from "@pairlint/tokens-core";
import { Ajv } from "ajv";
import { afterAll, describe, expect, it } from "vitest";
import {
  findTokenFiles,
  inferConfig,
  parseConfig,
  renderConfig,
  roleOf,
  themeOf,
} from "../src/index.js";
import { fixture, runCli } from "./helpers.js";

const scratch = mkdtempSync(join(tmpdir(), "pairlint-init-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const tempDir = () => {
  const dir = join(scratch, String(counter++));
  mkdirSync(dir, { recursive: true });
  return dir;
};

const json = (path: string, value: unknown) => ({ path, text: JSON.stringify(value, null, 2) });
const color = (value: string) => ({ $type: "color", $value: value });

const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8"));
const validate = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true }).compile(
  schema,
);

describe("themeOf", () => {
  it.each([
    ["dark", "dark"],
    ["tokens.dark", "dark"],
    ['[data-theme="dark"]', "dark"],
    ["@media (prefers-color-scheme: dark)", "dark"],
    ["Light", "light"],
    ["theme-high-contrast", "high-contrast"],
    ["hc", "high-contrast"],
    ["core", undefined],
    ["darkness", undefined],
    [".acme", undefined],
  ])("%s is %s", (label, theme) => {
    expect(themeOf(label)).toBe(theme);
  });
});

describe("roleOf", () => {
  it.each([
    ["color.text.primary", "fg"],
    ["color.font.base", "fg"],
    ["text-muted", "fg"],
    ["color.surface.raised", "bg"],
    ["color.background.base", "bg"],
    ["bg-subtle", "bg"],
    ["color.border.default", "ui"],
    ["focus-ring", "ui"],
    ["color.text.on-brand", "on"],
    ["on-primary", "on"],
    ["color.text.disabled", "disabled"],
    ["color.gray.500", undefined],
    ["button.text.background", "bg"],
  ])("%s is %s", (id, role) => {
    expect(roleOf(id)).toBe(role);
  });
});

describe("inferConfig", () => {
  it("uses one mode when no file names a theme", () => {
    const config = inferConfig([
      json("tokens.json", {
        color: {
          gray: { 900: color("#111111"), 50: color("#fafafa") },
          text: { primary: color("{color.gray.900}"), secondary: color("#555555") },
          surface: { base: color("#ffffff"), raised: color("{color.gray.50}") },
        },
      }),
    ]);
    expect(config.modes).toEqual([{ name: "default", sources: ["tokens.json"] }]);
    expect(config.pairs).toEqual([{ fg: ["color.text.*"], bg: ["color.surface.*"] }]);
    expect(config).toMatchObject({ guessed: false, colorCount: 6, fileCount: 1 });
  });

  it("makes light and dark modes from file names, with shared files first", () => {
    const config = inferConfig([
      json("tokens/core.json", { gray: { 900: color("#111111") } }),
      json("tokens/dark.json", { text: color("#eeeeee"), bg: color("#111111") }),
      json("tokens/light.json", { text: color("#111111"), bg: color("#ffffff") }),
    ]);
    expect(config.modes).toEqual([
      { name: "light", sources: ["tokens/core.json", "tokens/light.json"] },
      { name: "dark", sources: ["tokens/core.json", "tokens/dark.json"] },
    ]);
  });

  it("adds a light mode for the shared files when only a dark file exists", () => {
    const config = inferConfig([
      json("base.json", { text: color("#111111"), bg: color("#ffffff") }),
      json("dark.json", { text: color("#eeeeee"), bg: color("#111111") }),
    ]);
    expect(config.modes.map((mode) => [mode.name, mode.sources])).toEqual([
      ["light", ["base.json"]],
      ["dark", ["base.json", "dark.json"]],
    ]);
  });

  it("reads Tokens Studio sets in tokenSetOrder", () => {
    const studio = {
      core: { gray: { value: "#111111", type: "color" } },
      light: { text: { value: "{gray}", type: "color" }, bg: { value: "#fff", type: "color" } },
      dark: { text: { value: "#eee", type: "color" }, bg: { value: "#111", type: "color" } },
      sizes: { space: { value: "4px", type: "spacing" } },
      $themes: [],
      $metadata: { tokenSetOrder: ["core", "light", "dark", "sizes"] },
    };
    expect(inferConfig([json("tokens.json", studio)]).modes).toEqual([
      { name: "light", sources: ["tokens.json#core", "tokens.json#light"] },
      { name: "dark", sources: ["tokens.json#core", "tokens.json#dark"] },
    ]);
  });

  it("reads CSS themes and lists selections that are not themes", () => {
    const css = `:root { --text: #111; --surface: #fff; }
      [data-theme="dark"] { --text: #eee; --surface: #111; }
      @media (prefers-color-scheme: dark) { :root { --text: #eee; --surface: #111; } }
      .compact { --surface: #fafafa; }`;
    const config = inferConfig([{ path: "theme.css", text: css }]);
    expect(config.modes).toEqual([
      { name: "light", sources: ["theme.css"] },
      { name: "dark", sources: ["theme.css", 'theme.css#[data-theme="dark"]'] },
    ]);
    expect(config.skipped).toEqual([
      "theme.css#@media (prefers-color-scheme: dark)",
      "theme.css#.compact",
    ]);
    expect(config.pairs[0]).toEqual({ fg: ["text"], bg: ["surface"] });
  });

  it("checks borders as UI and exempts disabled text", () => {
    const config = inferConfig([
      json("t.json", {
        text: { primary: color("#111"), disabled: color("#bbb") },
        border: { default: color("#999") },
        surface: { base: color("#fff") },
      }),
    ]);
    expect(config.pairs).toEqual([
      { fg: ["text.*"], bg: ["surface.base"] },
      { fg: ["border.default"], bg: ["surface.base"], use: "ui" },
      {
        fg: ["text.disabled"],
        bg: ["surface.base"],
        use: "exempt",
        reason: "WCAG 1.4.3 does not apply to disabled controls",
      },
    ]);
  });

  it("pairs on- colors with their own fill instead of every surface", () => {
    const config = inferConfig([
      json("t.json", {
        text: { primary: color("#111"), "on-brand": color("#fff") },
        surface: { base: color("#fff") },
        brand: { fill: color("#0057ff") },
      }),
    ]);
    expect(config.pairs).toContainEqual({
      fg: ["text.on-brand"],
      bg: ["surface.base"],
      use: "exempt",
      reason: "On- colors sit on their own fill, which is checked separately",
    });
    expect(config.pairs).toContainEqual({ fg: ["text.on-brand"], bg: ["brand.fill"] });
  });

  it("never widens a pattern over tokens with another role", () => {
    const config = inferConfig([
      json("t.json", {
        ui: { text: color("#111"), surface: color("#fff"), border: color("#999") },
      }),
    ]);
    expect(config.pairs[0]).toEqual({ fg: ["ui.text"], bg: ["ui.surface"] });
  });

  it("falls back to example patterns when names give no roles", () => {
    const config = inferConfig([
      json("t.json", { gray: { 100: color("#eee"), 900: color("#111") } }),
    ]);
    expect(config.guessed).toBe(true);
    expect(renderConfig(config, "./node_modules/pairlint/schema.json")).toContain(
      "could not tell text tokens from backgrounds",
    );
  });

  it("ignores files that are not token files or have no colors", () => {
    const config = inferConfig([
      { path: "broken.json", text: "{ not json" },
      json("sizes.json", { space: { $type: "dimension", $value: "4px" } }),
      { path: "app.css", text: "body { color: red }" },
      json("t.json", { text: color("#111"), bg: color("#fff") }),
    ]);
    expect(config.fileCount).toBe(1);
  });
});

describe("renderConfig", () => {
  it("writes commented JSON that the config parser and the schema accept", () => {
    const config = inferConfig([
      json("core.json", { text: { a: color("#111") }, surface: { b: color("#fff") } }),
      json("dark.json", { text: { a: color("#eee") }, surface: { b: color("#111") } }),
    ]);
    const text = renderConfig(config, "./node_modules/pairlint/schema.json");
    expect(text).toContain("// Pairs inferred from token names");
    expect(() => parseConfig(text, "pairlint.config.json")).not.toThrow();
    expect(validate(parseJson(text, { jsonc: true }).value)).toBe(true);
  });
});

describe("findTokenFiles", () => {
  it("skips dependencies, hidden folders, build output and tool configs", () => {
    const dir = tempDir();
    const write = (path: string, text = "{}") => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    write("tokens/light.json");
    write("styles/theme.css", ":root{}");
    write("node_modules/x/tokens.json");
    write(".git/tokens.json");
    write("dist/tokens.json");
    write("package.json");
    write("tsconfig.base.json");
    write("vendor.min.css");
    write("notes.md");
    expect(findTokenFiles(dir).map((file) => file.path)).toEqual([
      "styles/theme.css",
      "tokens/light.json",
    ]);
  });

  it("does not follow symlinks out of the project", () => {
    const outside = tempDir();
    writeFileSync(join(outside, "secret.json"), "{}");
    const dir = tempDir();
    try {
      symlinkSync(outside, join(dir, "linked"), "junction");
    } catch {
      return; // No permission to create links on this machine.
    }
    expect(findTokenFiles(dir)).toEqual([]);
  });
});

describe("pairlint init", () => {
  const copyFixture = (name: string) => {
    const dir = tempDir();
    cpSync(fixture(name), dir, {
      recursive: true,
      filter: (source) => !/pairlint\.(config|baseline)\.json$|expected/.test(source),
    });
    return dir;
  };

  it.each(["dtcg-modes", "css-brand-theme", "style-dictionary", "tokens-studio"])(
    "writes a working config for %s",
    async (name) => {
      const cwd = copyFixture(name);
      const result = runCli(["init"], { cwd });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Wrote pairlint.config.json");
      const config = readFileSync(join(cwd, "pairlint.config.json"), "utf8");
      await expect(config).toMatchFileSnapshot(`./fixtures/init/${name}.jsonc`);
      // The written config must run without config or token errors.
      expect(runCli([], { cwd }).code).toBeLessThan(2);
    },
  );

  it("refuses to replace a config without --force", () => {
    const cwd = copyFixture("dtcg-modes");
    writeFileSync(join(cwd, "pairlint.config.json"), "keep me");
    const refused = runCli(["init"], { cwd });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('Run "pairlint init --force"');
    expect(readFileSync(join(cwd, "pairlint.config.json"), "utf8")).toBe("keep me");
    expect(runCli(["init", "--force"], { cwd }).code).toBe(0);
    expect(readFileSync(join(cwd, "pairlint.config.json"), "utf8")).toContain('"modes"');
  });

  it("writes to --config and scans that folder", () => {
    const cwd = tempDir();
    cpSync(fixture("tokens-studio/tokens.json"), join(cwd, "design", "tokens.json"), {
      recursive: true,
    });
    const result = runCli(["init", "-c", "design/pairlint.config.json"], { cwd });
    expect(result.code).toBe(0);
    const text = readFileSync(join(cwd, "design", "pairlint.config.json"), "utf8");
    expect(text).toContain('"../node_modules/pairlint/schema.json"');
    expect(text).toContain('"tokens.json#core"');
  });

  it("explains when there are no tokens", () => {
    const result = runCli(["init"], { cwd: tempDir() });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No color tokens found");
  });

  it("only accepts --force with init", () => {
    const result = runCli(["--force"], { cwd: fixture("dtcg-modes") });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--force only works with "pairlint init"');
  });
});
