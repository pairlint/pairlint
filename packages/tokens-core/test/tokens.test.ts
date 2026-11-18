import { describe, expect, it } from "vitest";
import {
  aliasTarget,
  MAX_ALIAS_DEPTH,
  parseTokenFile,
  type Token,
  TokenFileError,
  TokenSet,
} from "../src/index.js";

const file = (path: string, value: unknown) => ({ path, text: JSON.stringify(value, null, 2) });

const token = (id: string, value: unknown, extra: Partial<Token> = {}): Token => ({
  id,
  path: id.split("."),
  type: undefined,
  value,
  description: undefined,
  extensions: undefined,
  source: { file: "t.css", line: 1, column: 1 },
  ...extra,
});

describe("parseTokenFile with DTCG", () => {
  it("reads tokens, inherits group types and records positions", () => {
    const parsed = parseTokenFile({
      path: "tokens.json",
      text: [
        "{",
        '  "color": {',
        '    "$type": "color",',
        '    "blue": {',
        '      "500": { "$value": "#0057ff", "$description": "Brand blue" }',
        "    },",
        '    "size": { "$type": "dimension", "$value": "4px" }',
        "  }",
        "}",
      ].join("\n"),
    });
    expect(parsed.format).toBe("dtcg");
    expect(parsed.tokens.map((t) => [t.id, t.type, t.value])).toEqual([
      ["color.blue.500", "color", "#0057ff"],
      ["color.size", "dimension", "4px"],
    ]);
    expect(parsed.tokens[0]?.description).toBe("Brand blue");
    expect(parsed.tokens[0]?.source).toEqual({ file: "tokens.json", line: 5, column: 7 });
  });

  it("keeps DTCG color objects as values", () => {
    const value = { colorSpace: "oklch", components: [0.6, 0.15, 250] };
    const parsed = parseTokenFile(file("t.json", { brand: { $type: "color", $value: value } }));
    expect(parsed.tokens[0]?.value).toEqual(value);
  });

  it("warns about names that cannot be referenced and skips them", () => {
    const parsed = parseTokenFile(
      file("t.json", { "a.b": { $value: "#fff" }, ok: { $value: "#000" } }),
    );
    expect(parsed.tokens.map((t) => t.id)).toEqual(["ok"]);
    expect(parsed.diagnostics[0]?.message).toContain('"a.b"');
  });

  it("explains invalid JSON with the file and position", () => {
    expect(() => parseTokenFile({ path: "bad.json", text: '{"a": }' })).toThrow(TokenFileError);
    try {
      parseTokenFile({ path: "bad.json", text: '{"a": }' });
    } catch (error) {
      expect((error as TokenFileError).location).toEqual({ file: "bad.json", line: 1, column: 7 });
    }
  });

  it("requires an object at the top level", () => {
    expect(() => parseTokenFile({ path: "list.json", text: "[]" })).toThrow(/JSON object/);
  });
});

describe("parseTokenFile with Tokens Studio", () => {
  const studio = {
    core: { gray: { 900: { value: "#111111", type: "color" } } },
    light: { text: { value: "{gray.900}", type: "color" } },
    dark: { text: { value: "#eeeeee", type: "color" } },
    $themes: [],
    $metadata: { tokenSetOrder: ["core", "light", "dark"] },
  };

  it("detects the format and reads all sets in tokenSetOrder", () => {
    const parsed = parseTokenFile(file("studio.json", studio));
    expect(parsed.format).toBe("tokens-studio");
    expect(parsed.tokens.map((t) => [t.id, t.value])).toEqual([
      ["gray.900", "#111111"],
      ["text", "{gray.900}"],
      ["text", "#eeeeee"],
    ]);
  });

  it("reads a single set when asked", () => {
    const parsed = parseTokenFile(file("studio.json", studio), { set: "dark" });
    expect(parsed.tokens.map((t) => t.id)).toEqual(["text"]);
    expect(parsed.tokens[0]?.source.line).toBeGreaterThan(1);
  });

  it("lists the available sets when the set is missing", () => {
    expect(() => parseTokenFile(file("studio.json", studio), { set: "brand" })).toThrow(
      /Available sets: core, light, dark/,
    );
  });

  it("does not inherit types from groups", () => {
    const parsed = parseTokenFile(
      file("s.json", { color: { type: "color", red: { value: "#f00", type: "color" } } }),
      { format: "tokens-studio" },
    );
    expect(parsed.tokens.map((t) => t.id)).toEqual(["color.red"]);
  });
});

describe("parseTokenFile with Style Dictionary", () => {
  const dictionary = {
    color: {
      base: {
        blue: { value: "#0057ff", comment: "Brand blue", attributes: { category: "color" } },
        gray: { value: "#6b7280", type: "color" },
      },
      text: { link: { value: "{color.base.blue.value}" } },
    },
  };

  it("detects tokens that have a value and no type", () => {
    const parsed = parseTokenFile(file("sd.json", dictionary));
    expect(parsed.format).toBe("style-dictionary");
    expect(parsed.tokens.map((t) => [t.id, t.type, t.value])).toEqual([
      ["color.base.blue", undefined, "#0057ff"],
      ["color.base.gray", "color", "#6b7280"],
      ["color.text.link", undefined, "{color.base.blue.value}"],
    ]);
  });

  it("reads comment as the description and falls back to description", () => {
    const parsed = parseTokenFile(
      file("sd.json", {
        a: { value: "#000", comment: "First" },
        b: { value: "#fff", description: "Second" },
      }),
      { format: "style-dictionary" },
    );
    expect(parsed.tokens.map((t) => t.description)).toEqual(["First", "Second"]);
  });

  it("is not chosen for files whose values are all objects", () => {
    expect(parseTokenFile(file("t.json", { a: { value: { r: 1 } } })).format).toBe("dtcg");
  });

  it("resolves Style Dictionary 3 references that end in .value", () => {
    const tokens = TokenSet.fromFiles([{ file: file("sd.json", dictionary) }]);
    expect(tokens.resolve("color.text.link")).toMatchObject({
      ok: true,
      value: "#0057ff",
      chain: ["color.text.link", "color.base.blue"],
    });
  });

  it("prefers a token whose id really ends in .value", () => {
    const tokens = new TokenSet([
      token("a", "#111111"),
      token("a.value", "#222222"),
      token("b", "{a.value}"),
    ]);
    expect(tokens.resolve("b")).toMatchObject({ ok: true, value: "#222222" });
  });

  it("reports a missing reference by its written id", () => {
    const tokens = TokenSet.fromFiles([{ file: file("sd.json", { b: { value: "{a.value}" } }) }]);
    const resolution = tokens.resolve("b");
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.error).toContain('"{a.value}"');
  });
});

describe("TokenSet", () => {
  const set = (value: unknown) => TokenSet.fromFiles([{ file: file("t.json", value) }]);

  it("lets later files override earlier ones", () => {
    const tokens = TokenSet.fromFiles([
      { file: file("base.json", { text: { $value: "#000" }, bg: { $value: "#fff" } }) },
      { file: file("dark.json", { text: { $value: "#fff" } }) },
    ]);
    expect(tokens.get("text")?.value).toBe("#fff");
    expect(tokens.get("text")?.source.file).toBe("dark.json");
    expect(tokens.get("bg")?.source.file).toBe("base.json");
  });

  it("resolves alias chains and keeps the requesting token", () => {
    const tokens = set({
      color: {
        $type: "color",
        blue: { $value: "#0057ff" },
        brand: { $value: "{color.blue}" },
        link: { $value: "{color.brand}" },
      },
    });
    const resolution = tokens.resolve("color.link");
    expect(resolution).toMatchObject({
      ok: true,
      value: "#0057ff",
      type: "color",
      chain: ["color.link", "color.brand", "color.blue"],
    });
    if (resolution.ok) expect(resolution.token.id).toBe("color.link");
  });

  it("resolves aliases whose names contain spaces, as Figma variable exports write them", () => {
    const tokens = set({
      Light: { "Moss Green": { "7": { $type: "color", $value: "#007079" } } },
      Border: { Accent: { $type: "color", $value: "{Light.Moss Green.7}" } },
    });
    expect(tokens.resolve("Border.Accent")).toMatchObject({ ok: true, value: "#007079" });
  });

  it("does not read a value with spaces around the name as an alias", () => {
    expect(aliasTarget("{ color.blue }")).toBeUndefined();
    expect(aliasTarget("{color.blue} {color.red}")).toBeUndefined();
    expect(aliasTarget("{Moss Green.7}")).toBe("Moss Green.7");
  });

  it("takes the type from the alias target when the token has none", () => {
    const tokens = set({ a: { $type: "color", $value: "#fff" }, b: { $value: "{a}" } });
    const resolution = tokens.resolve("b");
    expect(resolution.ok && resolution.type).toBe("color");
  });

  it("reports missing targets with the token that refers to them", () => {
    const tokens = set({ a: { $value: "{b}" }, b: { $value: "{c}" } });
    expect(tokens.resolve("a")).toMatchObject({
      ok: false,
      error: '"b" refers to "{c}", which does not exist',
    });
    expect(tokens.resolve("nope")).toMatchObject({
      ok: false,
      error: 'Token "nope" does not exist',
    });
  });

  it("detects cycles", () => {
    const tokens = set({ a: { $value: "{b}" }, b: { $value: "{c}" }, c: { $value: "{a}" } });
    expect(tokens.resolve("a")).toMatchObject({ ok: false, error: "Alias cycle: a → b → c → a" });
  });

  it("stops long chains", () => {
    const chain: Record<string, unknown> = { t0: { $value: "#fff" } };
    for (let i = 1; i <= MAX_ALIAS_DEPTH + 5; i++) chain[`t${i}`] = { $value: `{t${i - 1}}` };
    const resolution = set(chain).resolve(`t${MAX_ALIAS_DEPTH + 5}`);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.error).toContain(`more than ${MAX_ALIAS_DEPTH} aliases`);
  });

  it("refuses references embedded in other text", () => {
    const tokens = set({ a: { $value: "#000" }, b: { $value: "rgba({a}, 0.5)" } });
    expect(tokens.resolve("b")).toMatchObject({ ok: false });
    const resolution = tokens.resolve("b");
    if (!resolution.ok) expect(resolution.error).toContain("cannot resolve yet");
  });

  it("uses a fallback when the alias target is missing", () => {
    const tokens = new TokenSet([
      token("a", "{missing}", { fallback: "#123456" }),
      token("b", "{missing}", { fallback: "{c}" }),
      token("c", "#abcdef"),
      token("d", "{c}", { fallback: "#000000" }),
      token("e", "{missing}", { fallback: "{also-missing}" }),
    ]);
    expect(tokens.resolve("a")).toMatchObject({ ok: true, value: "#123456", chain: ["a"] });
    expect(tokens.resolve("b")).toMatchObject({ ok: true, value: "#abcdef", chain: ["b", "c"] });
    expect(tokens.resolve("d")).toMatchObject({ ok: true, value: "#abcdef", chain: ["d", "c"] });
    const missing = tokens.resolve("e");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('"{also-missing}", which does not exist');
  });

  it("matches patterns and returns sorted ids", () => {
    const tokens = set({
      text: { b: { $value: "#000" }, a: { $value: "#111" } },
      bg: { $value: "#fff" },
    });
    expect(tokens.match("text.*")).toEqual(["text.a", "text.b"]);
    expect(tokens.ids()).toEqual(["bg", "text.a", "text.b"]);
    expect(tokens.size).toBe(3);
  });
});
