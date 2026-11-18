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
import { compileTokenPattern, parseJson } from "@pairlint/tokens-core";
import { Ajv } from "ajv";
import { afterAll, describe, expect, it } from "vitest";
import {
  findTokenFiles,
  type InferredPair,
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

/** Every "fg on bg" pair the checked (not exempt) rules produce for these token ids. */
const checkedPairs = (pairs: InferredPair[], ids: string[]) => {
  const expand = (patterns: string[]) =>
    ids.filter((id) => patterns.some((pattern) => compileTokenPattern(pattern)(id)));
  return pairs
    .filter((pair) => pair.use !== "exempt")
    .flatMap((pair) =>
      expand(pair.fg).flatMap((fg) => expand(pair.bg).map((bg) => `${fg} on ${bg}`)),
    )
    .sort();
};
/** A flat DTCG file where every id is a color. */
const colors = (ids: string[]) => {
  const root: Record<string, unknown> = {};
  for (const id of ids) {
    const path = id.split(".");
    let node = root;
    for (const part of path.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Record<string, unknown>;
    }
    node[path[path.length - 1] as string] = color("#777777");
  }
  return json("t.json", root);
};

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
    ['[data-color-mode="auto"][data-light-theme="dark"]', "dark"],
    ['[data-color-mode="dark"][data-dark-theme="light"]', "light"],
    ["[data-light-theme]", undefined],
    ["theme-light-hc", "light-high-contrast"],
    ["theme-semantics-dark-hc", "dark-high-contrast"],
    ['[data-light-theme="light_high_contrast"]', "light-high-contrast"],
    ["Color Dark.Mode 1", "dark"],
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
    ["fgColor-default", "fg"],
    ["bgColor-muted", "bg"],
    ["borderColor-default", "ui"],
    ["button-outline-bgColor-rest", "bg"],
    ["fgColor-onEmphasis", "on"],
    ["Bg.Accent.Fill Muted.Default", "bg"],
    ["Text.Neutral.Subtle on emphasis", "on"],
    ["utrecht.button.color", "fg"],
    ["Shadow.High.Ambient.color", undefined],
    ["label-red-fgColor", "fg"],
    ["utrecht.button.background-color", "bg"],
    ["utrecht.textbox.border-color", "ui"],
    ["zwolle.color.blue.40", undefined],
    ["color.bg.action.primary.disabled", undefined],
    ["bgColor-disabled", undefined],
    ["Border.Disabled", "disabled"],
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

  it("keeps light and dark high contrast apart and loads each after its base theme", () => {
    const config = inferConfig([
      json("theme-light.json", { text: color("#333333"), bg: color("#ffffff") }),
      json("theme-dark.json", { text: color("#cccccc"), bg: color("#111111") }),
      json("theme-light-hc.json", { text: color("#000000") }),
      json("theme-dark-hc.json", { text: color("#ffffff") }),
    ]);
    expect(config.modes).toEqual([
      { name: "light", sources: ["theme-light.json"] },
      { name: "dark", sources: ["theme-dark.json"] },
      { name: "light-high-contrast", sources: ["theme-light.json", "theme-light-hc.json"] },
      { name: "dark-high-contrast", sources: ["theme-dark.json", "theme-dark-hc.json"] },
    ]);
  });

  it("names CSS themes from attribute values, not attribute names", () => {
    const block = (selector: string, fg: string, bg: string) =>
      `${selector} { --fgColor-default: ${fg}; --bgColor-default: ${bg}; }`;
    const config = inferConfig([
      {
        path: "light.css",
        text: block('[data-color-mode="light"][data-light-theme="light"]', "#111", "#fff"),
      },
      {
        path: "dark.css",
        text: block('[data-color-mode="dark"][data-dark-theme="dark"]', "#eee", "#111"),
      },
      {
        path: "dark-auto.css",
        text: block('[data-color-mode="auto"][data-light-theme="dark"]', "#eee", "#111"),
      },
    ]);
    const light = config.modes.find((mode) => mode.name === "light");
    expect(light?.sources).toEqual([
      'light.css#[data-color-mode="light"][data-light-theme="light"]',
    ]);
    expect(config.pairs[0]).toEqual({ fg: ["fgColor-default"], bg: ["bgColor-default"] });
  });

  it("does not count an alias to a font or size as a color", () => {
    const config = inferConfig([
      json("brand.json", {
        brand: {
          blue: { value: "#395791" },
          white: { value: "#ffffff" },
          font: { value: "Arial, sans-serif" },
          size: { value: "16px" },
        },
      }),
      json("button.json", {
        button: {
          "background-color": { value: "{brand.blue}" },
          color: { value: "{brand.white}" },
          "font-family": { value: "{brand.font}" },
          "font-size": { value: "{brand.size}" },
        },
      }),
    ]);
    expect(config.colorCount).toBe(4);
    expect(config.pairs).toEqual([{ fg: ["button.color"], bg: ["button.background-color"] }]);
  });

  it("does not write a pattern that also matches untyped tokens that are not colors", () => {
    const css = `:root { --text-primary: #111; --text-muted: #555; --text-body-size: 16px;
      --surface-default: #fff; }`;
    const config = inferConfig([{ path: "theme.css", text: css }]);
    expect(config.pairs[0]).toEqual({
      fg: ["text-muted", "text-primary"],
      bg: ["surface-default"],
    });
  });

  it("leaves disabled backgrounds out of the foregrounds", () => {
    const config = inferConfig([
      json("t.json", {
        text: { primary: color("#111"), disabled: color("#bbb") },
        bg: { canvas: color("#fff"), disabled: color("#eee") },
      }),
    ]);
    expect(config.pairs.flatMap((pair) => pair.fg)).not.toContain("bg.disabled");
    expect(config.pairs.flatMap((pair) => pair.bg)).not.toContain("bg.disabled");
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
    expect(config.pairs).toEqual([
      { fg: ["text.primary"], bg: ["surface.base"] },
      { fg: ["text.on-brand"], bg: ["brand.fill"] },
    ]);
    expect(config.unpaired).toEqual([]);
  });

  it("pairs component text with its own component's backgrounds", () => {
    const ids = [
      "utrecht.button.color",
      "utrecht.button.background-color",
      "utrecht.button.focus.border-color",
      "utrecht.document.color",
      "utrecht.document.background-color",
      "utrecht.link.color",
    ];
    const config = inferConfig([colors(ids)]);
    expect(checkedPairs(config.pairs, ids)).toEqual([
      "utrecht.button.color on utrecht.button.background-color",
      // A scope without backgrounds uses the nearest one that has some.
      "utrecht.button.focus.border-color on utrecht.button.background-color",
      "utrecht.document.color on utrecht.document.background-color",
      // No link background, so the page's own.
      "utrecht.link.color on utrecht.document.background-color",
    ]);
    expect(config.pairCount).toBe(4);
  });

  it("falls back to the shared surfaces, not every component's", () => {
    const ids = [
      "color.text.primary",
      "color.surface.base",
      "button.primary.fgColor",
      "button.primary.bgColor",
      "badge.bgColor",
    ];
    const config = inferConfig([colors(ids)]);
    expect(checkedPairs(config.pairs, ids)).toEqual([
      "button.primary.fgColor on button.primary.bgColor",
      "color.text.primary on color.surface.base",
    ]);
  });

  it("reads the scope up to the last role word, so a component named label stays a component", () => {
    const ids = [
      "fgColor-default",
      "bgColor-default",
      "bgColor-black",
      "label-red-fgColor",
      "label-red-bgColor",
      "label-gray-fgColor",
      "label-gray-bgColor",
      "page-header-fgColor",
      "page-header-bgColor",
    ];
    expect(checkedPairs(inferConfig([colors(ids)]).pairs, ids)).toEqual([
      "fgColor-default on bgColor-black",
      "fgColor-default on bgColor-default",
      "label-gray-fgColor on label-gray-bgColor",
      "label-red-fgColor on label-red-bgColor",
      // "page" names the page only as the last word of a scope, not in page-header.
      "page-header-fgColor on page-header-bgColor",
    ]);
  });

  it("keeps one scope when only modifiers sit between role words", () => {
    const ids = [
      "Text.Strong",
      "Text.Accent.Strong",
      "Bg.Canvas",
      "Bg.Accent.Canvas",
      "Bg.Neutral.Surface",
    ];
    expect(checkedPairs(inferConfig([colors(ids)]).pairs, ids)).toEqual([
      "Text.Accent.Strong on Bg.Accent.Canvas",
      "Text.Accent.Strong on Bg.Canvas",
      "Text.Accent.Strong on Bg.Neutral.Surface",
      "Text.Strong on Bg.Accent.Canvas",
      "Text.Strong on Bg.Canvas",
      "Text.Strong on Bg.Neutral.Surface",
    ]);
  });

  it("reads a component named after the role word, pairing matching variants", () => {
    const ids = [
      "color.text.primary",
      "color.text.badge.accent",
      "color.text.decorative.1",
      "color.text.decorative.2",
      "color.bg.canvas.default",
      "color.bg.badge.accent",
      "color.bg.badge.default",
      "color.bg.decorative.1",
      "color.bg.decorative.2",
    ];
    const config = inferConfig([colors(ids)]);
    expect(checkedPairs(config.pairs, ids)).toEqual([
      "color.text.badge.accent on color.bg.badge.accent",
      "color.text.decorative.1 on color.bg.decorative.1",
      "color.text.decorative.2 on color.bg.decorative.2",
      "color.text.primary on color.bg.canvas.default",
    ]);
    // Nothing is meant for the default badge, so it is listed instead of dropped quietly.
    expect(config.unpaired).toEqual(["color.bg.badge.default"]);
  });

  it("does not treat stateful fills as a component of plain text", () => {
    const ids = [
      "color.text.action.primary",
      "color.bg.canvas.default",
      "color.bg.action.primary.rest",
      "color.bg.action.primary.hovered",
    ];
    const pairs = checkedPairs(inferConfig([colors(ids)]).pairs, ids);
    expect(pairs).toContain("color.text.action.primary on color.bg.canvas.default");
  });

  it("does not treat color names as components", () => {
    const ids = ["fgColor-default", "fgColor-white", "bgColor-default", "bgColor-black"];
    expect(checkedPairs(inferConfig([colors(ids)]).pairs, ids)).toEqual([
      "fgColor-default on bgColor-black",
      "fgColor-default on bgColor-default",
      "fgColor-white on bgColor-black",
      "fgColor-white on bgColor-default",
    ]);
  });

  it("keeps different intents apart", () => {
    const ids = [
      "color.text.primary",
      "color.text.success",
      "color.text.critical",
      "color.bg.canvas",
      "color.bg.success.subtle",
      "color.bg.critical.subtle",
    ];
    const pairs = checkedPairs(inferConfig([colors(ids)]).pairs, ids);
    expect(pairs).toContain("color.text.primary on color.bg.success.subtle");
    expect(pairs).toContain("color.text.success on color.bg.success.subtle");
    expect(pairs).toContain("color.text.success on color.bg.canvas");
    expect(pairs).not.toContain("color.text.success on color.bg.critical.subtle");
    expect(pairs).not.toContain("color.text.critical on color.bg.success.subtle");
    expect(pairs).toHaveLength(7);
  });

  it("keeps different states apart", () => {
    const ids = [
      "button.text.hover",
      "button.text.pressed",
      "button.text.default",
      "button.bg.hover",
      "button.bg.pressed",
    ];
    expect(checkedPairs(inferConfig([colors(ids)]).pairs, ids)).toEqual([
      "button.text.default on button.bg.hover",
      "button.text.default on button.bg.pressed",
      "button.text.hover on button.bg.hover",
      "button.text.pressed on button.bg.pressed",
    ]);
  });

  it("checks strong fills only against their on- colors", () => {
    const ids = [
      "fgColor-default",
      "fgColor-onEmphasis",
      "bgColor-default",
      "bgColor-accent-muted",
      "bgColor-accent-emphasis",
    ];
    expect(checkedPairs(inferConfig([colors(ids)]).pairs, ids)).toEqual([
      "fgColor-default on bgColor-accent-muted",
      "fgColor-default on bgColor-default",
      "fgColor-onEmphasis on bgColor-accent-emphasis",
    ]);
  });

  it("prefers fills with the on- color's intent", () => {
    const ids = [
      "Text.Default",
      "Text.Accent.Strong on emphasis",
      "Bg.Canvas",
      "Bg.Accent.Fill Emphasis.Default",
      "Bg.Danger.Fill Emphasis.Default",
    ];
    const pairs = checkedPairs(inferConfig([colors(ids)]).pairs, ids);
    expect(pairs).toContain("Text.Accent.Strong on emphasis on Bg.Accent.Fill Emphasis.Default");
    expect(pairs).not.toContain(
      "Text.Accent.Strong on emphasis on Bg.Danger.Fill Emphasis.Default",
    );
  });

  it("reads backgrounds marked primary as fills when no background names the on- color's fill", () => {
    const ids = [
      "color.text.primary",
      "color.text.on-solid.primary",
      "color.bg.canvas.default",
      "color.bg.subtle-primary",
      "color.bg.action.primary.rest",
      "color.bg.action.primary.hovered",
      "color.bg.critical.primary",
      "color.bg.critical.hovered",
      "color.bg.critical.subtle",
      "color.bg.critical.subtle-hovered",
      "color.bg.accent.rest",
      "color.bg.accent.selected",
      "color.bg.accent.subtle",
      "color.bg.info.rest",
    ];
    const config = inferConfig([colors(ids)]);
    expect(checkedPairs(config.pairs, ids)).toEqual([
      "color.text.on-solid.primary on color.bg.accent.rest",
      "color.text.on-solid.primary on color.bg.action.primary.hovered",
      "color.text.on-solid.primary on color.bg.action.primary.rest",
      "color.text.on-solid.primary on color.bg.critical.hovered",
      "color.text.on-solid.primary on color.bg.critical.primary",
      // Selected is a light state, and info has no subtle or primary background to show that its
      // resting color is a fill, so both stay surfaces.
      "color.text.primary on color.bg.accent.selected",
      "color.text.primary on color.bg.accent.subtle",
      "color.text.primary on color.bg.canvas.default",
      "color.text.primary on color.bg.critical.subtle",
      "color.text.primary on color.bg.critical.subtle-hovered",
      "color.text.primary on color.bg.info.rest",
      "color.text.primary on color.bg.subtle-primary",
    ]);
    expect(config.unpaired).toEqual([]);
  });

  it("keeps backgrounds marked primary as surfaces when on- colors find their fills by name", () => {
    const ids = ["fgColor-default", "fgColor-onEmphasis", "bgColor-emphasis", "bgColor-primary"];
    expect(checkedPairs(inferConfig([colors(ids)]).pairs, ids)).toEqual([
      "fgColor-default on bgColor-primary",
      "fgColor-onEmphasis on bgColor-emphasis",
    ]);
  });

  it("lists text and fills it could not pair, and writes them into the config", () => {
    const ids = [
      "color.text.primary",
      "color.text.inverse",
      "color.surface.base",
      "color.bg.solid",
    ];
    const config = inferConfig([colors(ids)]);
    expect(config.unpaired).toEqual(["color.bg.solid", "color.text.inverse"]);
    expect(renderConfig(config, "./schema.json")).toContain(
      "// Not paired, so not checked: color.bg.solid, color.text.inverse.",
    );
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

describe("inferConfig modes and pairs from real-world layouts", () => {
  /** A DTCG file at `path` where every id is a color. */
  const colorFile = (path: string, ids: string[]) => ({ ...colors(ids), path });
  const semantic = ["color.text.default", "color.bg.canvas", "color.bg.subtle"];

  it("makes alternatives in one theme their own modes instead of layering them", () => {
    const config = inferConfig([
      colorFile("themes/light.json", semantic),
      colorFile("themes/light-colorblind.json", semantic),
      colorFile("themes/dark.json", semantic),
      colorFile("themes/dark-dimmed.json", semantic),
      colorFile("themes/dark-overrides.json", ["color.text.link"]),
    ]);
    expect(config.modes.map((mode) => mode.name)).toEqual([
      "light",
      "light-colorblind",
      "dark",
      "dark-dimmed",
    ]);
    const dimmed = config.modes.find((mode) => mode.name === "dark-dimmed");
    // A file with other ids is a layer, so every dark mode loads it.
    expect(dimmed?.sources).toEqual(["themes/dark-overrides.json", "themes/dark-dimmed.json"]);
  });

  it("keeps same-named files in different folders as layers", () => {
    const config = inferConfig([
      colorFile("a/Concept.Mode 1.json", semantic),
      colorFile("a/Elevation.json", ["shade.1", "shade.2", "shade.3", "shade.4"]),
      colorFile("b/Concept.Mode 1.json", semantic),
      colorFile("b/Primitives.json", ["blue.1", "blue.2", "blue.3", "blue.4"]),
    ]);
    expect(config.modes.map((mode) => mode.name)).toEqual(["default"]);
  });

  it("writes alternatives outside any theme as their own group", () => {
    const appearance = ["Bg.Fill.Emphasis.Default", "Text.Strong on emphasis", "Text.Subtle"];
    const config = inferConfig([
      colorFile("t/Color scheme.Light.json", semantic),
      colorFile("t/Color scheme.Dark.json", semantic),
      colorFile("t/Appearance.Accent.json", appearance),
      colorFile("t/Appearance.Danger.json", appearance),
    ]);
    expect(config.modes.map((mode) => mode.name)).toEqual([
      "light/accent",
      "light/danger",
      "dark/accent",
      "dark/danger",
    ]);
    const text = renderConfig(config, "./schema.json");
    expect(text).toContain("// 4 modes: 2 theme × 2 appearance.");
    expect(text).toContain('    "appearance": {');
    expect(text).toContain('      "accent": "t/Appearance.Accent.json",');
    const parsed = parseConfig(text, "pairlint.config.json");
    expect(parsed.modes.map((mode) => mode.name)).toEqual(config.modes.map((mode) => mode.name));
  });

  it("detects brand folders that define the same tokens", () => {
    const brand = ["button.color", "button.background-color", "document.color"];
    const config = inferConfig([
      colorFile("shared/base.json", ["document.background-color"]),
      colorFile("brands/acme-tokens/src/color.json", brand),
      colorFile("brands/acme-tokens/src/extra.json", ["acme.brand.fill"]),
      colorFile("brands/zen-tokens/src/color.json", brand),
      colorFile("brands/odd-tokens/src/color.json", [...brand.slice(0, 1), "odd.a", "odd.b"]),
    ]);
    expect(config.plan.axes.map((axis) => [axis.name, axis.values.map((v) => v.name)])).toEqual([
      ["brand", ["acme", "odd", "zen"]],
    ]);
    expect(config.modes.find((mode) => mode.name === "acme")?.sources).toEqual([
      "shared/base.json",
      "brands/acme-tokens/src/color.json",
      "brands/acme-tokens/src/extra.json",
    ]);
  });

  it("does not take theme folders for brands", () => {
    const config = inferConfig([
      colorFile("tokens/light/color.json", semantic),
      colorFile("tokens/dark/color.json", semantic),
    ]);
    expect(config.plan.axes.some((axis) => axis.kind === "brand")).toBe(false);
  });

  it("prefers the themes in a Tokens Studio $themes.json", () => {
    const config = inferConfig([
      colorFile("core/color.json", ["palette.white", "palette.black"]),
      colorFile("semantic/day.json", semantic),
      colorFile("semantic/night.json", semantic),
      json("$metadata.json", { tokenSetOrder: ["core/color", "semantic/day", "semantic/night"] }),
      json("$themes.json", [
        {
          id: "1",
          name: "\u{1F31E} Brand Light",
          group: "color",
          selectedTokenSets: { "core/color": "source", "semantic/day": "enabled" },
        },
        {
          id: "2",
          name: "\u{1F31A} Brand Dark",
          group: "color",
          selectedTokenSets: { "core/color": "source", "semantic/night": "enabled" },
        },
        { id: "3", name: "Mode 1", group: "core", selectedTokenSets: { "core/color": "enabled" } },
        { id: "4", name: "Off", group: "size", selectedTokenSets: { "semantic/day": "disabled" } },
      ]),
    ]);
    expect(config.modes).toEqual([
      { name: "light", sources: ["core/color.json", "semantic/day.json"] },
      { name: "dark", sources: ["core/color.json", "semantic/night.json"] },
    ]);
    expect(renderConfig(config, "./schema.json")).toContain(
      "// 2 modes, from the themes in $themes.json.",
    );
  });

  it("falls back to names when $themes.json names none of the files", () => {
    const config = inferConfig([
      colorFile("light.json", semantic),
      colorFile("dark.json", semantic),
      json("$themes.json", [{ name: "X", selectedTokenSets: { missing: "enabled" } }]),
    ]);
    expect(config.fromThemesFile).toBe(false);
    expect(config.modes.map((mode) => mode.name)).toEqual(["light", "dark"]);
  });

  it("writes the page background as the base of dark modes", () => {
    const config = inferConfig([
      colorFile("light.json", [...semantic, "page-header-bgColor", "color.bg.critical"]),
      colorFile("dark.json", semantic),
    ]);
    expect(config.canvas).toBe("color.bg.canvas");
    expect(renderConfig(config, "./schema.json")).toContain(
      '  "base": { "dark": "{color.bg.canvas}" },',
    );
    const light = inferConfig([colorFile("tokens.json", semantic)]);
    expect(renderConfig(light, "./schema.json")).not.toContain('"base"');
  });

  it("does not take a component named page for the page background", () => {
    const ids = ["fgColor-default", "bgColor-default", "page-header-bgColor"];
    const config = inferConfig([colorFile("light.json", ids), colorFile("dark.json", ids)]);
    expect(config.canvas).toBe("bgColor-default");
  });

  it("pairs inverse text only with inverse backgrounds", () => {
    const ids = [
      "color.text.1",
      "color.text.inverse",
      "color.background.default",
      "color.inverse.1",
    ];
    expect(checkedPairs(inferConfig([colors(ids)]).pairs, ids)).toEqual([
      "color.text.1 on color.background.default",
      "color.text.inverse on color.inverse.1",
    ]);
    const lonely = ["color.text.1", "color.text.inverse", "color.background.default"];
    const config = inferConfig([colors(lonely)]);
    expect(checkedPairs(config.pairs, lonely)).toEqual([
      "color.text.1 on color.background.default",
    ]);
    expect(config.unpaired).toEqual(["color.text.inverse"]);
  });

  it("reads foreground as a raised layer when the system also has text tokens", () => {
    const ids = ["color.text.1", "color.background.default", "color.foreground.1"];
    expect(checkedPairs(inferConfig([colors(ids)]).pairs, ids)).toEqual([
      "color.text.1 on color.background.default",
      "color.text.1 on color.foreground.1",
    ]);
    const shadcn = ["foreground", "background", "card-foreground", "card"];
    expect(checkedPairs(inferConfig([colors(shadcn)]).pairs, shadcn)).toContain(
      "foreground on background",
    );
  });

  it("exempts divider, separator and subtle borders with a reason", () => {
    const ids = [
      "color.text.default",
      "color.bg.canvas",
      "color.border.default",
      "color.border.subtle",
      "color.divider",
      "color.separator.primary",
    ];
    const config = inferConfig([colors(ids)]);
    const exempt = config.pairs.filter((pair) => pair.reason?.startsWith("Decorative"));
    // An exempt rule overrides a broader checked one, as it does in the check.
    const skipped = new Set(
      checkedPairs(
        exempt.map((pair) => ({ ...pair, use: undefined })),
        ids,
      ),
    );
    expect(checkedPairs(config.pairs, ids).filter((pair) => !skipped.has(pair))).toEqual([
      "color.border.default on color.bg.canvas",
      "color.text.default on color.bg.canvas",
    ]);
    expect(exempt.flatMap((pair) => pair.fg).sort()).toEqual([
      "color.border.subtle",
      "color.divider",
      "color.separator.primary",
    ]);
    expect(exempt[0]?.use).toBe("exempt");
    expect(config.pairCount).toBe(2);
  });

  it("pairs on- colors with the fills that share their other words, with no cap", () => {
    const fills = ["Accent", "Danger", "Info", "Neutral", "Success", "Warning"].map(
      (intent) => `Bg.${intent}.Fill Emphasis.Default`,
    );
    const ids = [
      "Text.Default",
      "Bg.Canvas",
      "Text.Neutral.Subtle on emphasis",
      "Text.Strong on emphasis",
      ...fills,
    ];
    const pairs = checkedPairs(inferConfig([colors(ids)]).pairs, ids);
    expect(pairs.filter((pair) => pair.startsWith("Text.Neutral"))).toEqual([
      "Text.Neutral.Subtle on emphasis on Bg.Neutral.Fill Emphasis.Default",
    ]);
    expect(pairs.filter((pair) => pair.startsWith("Text.Strong"))).toHaveLength(6);
  });

  it("leaves out colors that mix a reference with other text", () => {
    const file = json("t.json", {
      color: {
        text: { default: color("#000000") },
        bg: { canvas: color("#ffffff"), hover: color("rgba({color.text.default}, 0.1)") },
      },
    });
    const config = inferConfig([file]);
    expect(config.colorCount).toBe(2);
    expect(config.pairs.flatMap((pair) => pair.bg)).not.toContain("color.bg.*");
  });
});
