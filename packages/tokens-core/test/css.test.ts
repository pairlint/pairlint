import { describe, expect, it } from "vitest";
import {
  isCssPath,
  normalizeMedia,
  normalizeSelector,
  parseCssTokens,
  parseTokenFile,
  TokenFileError,
  TokenSet,
} from "../src/index.js";

const css = (text: string, path = "tokens.css") => ({ path, text });
const values = (text: string, set?: string) =>
  Object.fromEntries(parseCssTokens(css(text), set).tokens.map((t) => [t.id, t.value]));

const THEME = `
/* Brand palette */
:root {
  --blue-500: #0057ff;
  --gray-900: #111827;
  --text: var(--gray-900);
  --surface: #ffffff;
}

[data-theme="dark"] {
  --text: #f9fafb;
  --surface: #111827;
}

@media (prefers-color-scheme: dark) {
  :root {
    --text: #e5e7eb;
  }
}
`;

describe("parseCssTokens", () => {
  it("reads :root custom properties with positions", () => {
    const parsed = parseCssTokens(css(THEME));
    expect(parsed.format).toBe("css");
    expect(parsed.tokens.map((t) => [t.id, t.value])).toEqual([
      ["blue-500", "#0057ff"],
      ["gray-900", "#111827"],
      ["text", "{gray-900}"],
      ["surface", "#ffffff"],
    ]);
    expect(parsed.tokens[0]?.source).toEqual({ file: "tokens.css", line: 4, column: 3 });
    expect(parsed.tokens[0]?.type).toBeUndefined();
  });

  it("selects a theme by selector, with or without quotes", () => {
    const expected = { text: "#f9fafb", surface: "#111827" };
    expect(values(THEME, '[data-theme="dark"]')).toEqual(expected);
    expect(values(THEME, "[data-theme=dark]")).toEqual(expected);
    expect(values(THEME, "[data-theme='dark']")).toEqual(expected);
  });

  it("selects :root inside a media query, ignoring spacing and case", () => {
    expect(values(THEME, "@media (prefers-color-scheme: dark)")).toEqual({ text: "#e5e7eb" });
    expect(values(THEME, "@media (PREFERS-COLOR-SCHEME:dark)")).toEqual({ text: "#e5e7eb" });
  });

  it("treats html like :root and lets later declarations win", () => {
    const text = ":root { --a: #000; --b: #111 } html { --a: #fff }";
    const parsed = parseCssTokens(css(text));
    expect(parsed.tokens.map((t) => [t.id, t.value])).toEqual([
      ["b", "#111"],
      ["a", "#fff"],
    ]);
  });

  it("reads rules with several selectors", () => {
    const text = ":root, .light { --a: #000 } .dark, [data-theme=dark] { --a: #fff }";
    expect(values(text)).toEqual({ a: "#000" });
    expect(values(text, ".light")).toEqual({ a: "#000" });
    expect(values(text, "[data-theme=dark]")).toEqual({ a: "#fff" });
  });

  it("reads through @layer and @supports and skips other at-rules", () => {
    const text = `
      @import url("reset.css");
      @layer tokens { :root { --a: #000; } }
      @supports (color: oklch(0 0 0)) { :root { --b: oklch(0.5 0.1 250); } }
      @container card (width > 20rem) { :root { --c: #f00; } }
      @font-face { font-family: X; src: url(x.woff2); }
    `;
    expect(values(text)).toEqual({ a: "#000", b: "oklch(0.5 0.1 250)" });
  });

  it("reads media queries nested inside a rule", () => {
    const text = ":root { --a: #000; @media (prefers-color-scheme: dark) { --a: #fff; } }";
    expect(values(text)).toEqual({ a: "#000" });
    expect(values(text, "@media (prefers-color-scheme: dark)")).toEqual({ a: "#fff" });
  });

  it("resolves & in nested selectors", () => {
    const text = ":root { --a: #000; &[data-theme=dark] { --a: #fff; } .x { --a: #f00; } }";
    expect(values(text, ':root[data-theme="dark"]')).toEqual({ a: "#fff" });
    expect(values(text, ":root .x")).toEqual({ a: "#f00" });
  });

  it("ignores rules that only appear inside two media queries", () => {
    const text =
      ":root { --a: #000 } @media screen { @media (prefers-color-scheme: dark) { :root { --a: #fff } } }";
    expect(values(text)).toEqual({ a: "#000" });
  });

  it("keeps var() fallbacks and nested var() fallbacks", () => {
    const parsed = parseCssTokens(
      css(":root { --a: var(--x, #fff); --b: var( --x , var(--a) ); --c: var(--x,); }"),
    );
    expect(parsed.tokens.map((t) => [t.id, t.value, t.fallback])).toEqual([
      ["a", "{x}", "#fff"],
      ["b", "{x}", "{a}"],
      ["c", "{x}", undefined],
    ]);
  });

  it("leaves values that only start with var() alone", () => {
    expect(values(":root { --a: var(--x) var(--y); --b: var(--x), red; }")).toEqual({
      a: "var(--x) var(--y)",
      b: "var(--x), red",
    });
  });

  it("strips comments and !important from values and keeps strings intact", () => {
    const text = `:root {
      --a: #000 /* note */ !important;
      --b: "a;b}/*c*/";
      --c: url(data:image/png;base64,AAAA);
      --d: { nested: block };
      --e:#fff
    }`;
    expect(values(text)).toEqual({
      a: "#000",
      b: '"a;b}/*c*/"',
      c: "url(data:image/png;base64,AAAA)",
      d: "{ nested: block }",
      e: "#fff",
    });
  });

  it("ignores ordinary properties and declarations outside rules", () => {
    const text = "--stray: #000; :root { color: red; background: url(a.png); --a: #111 }";
    expect(values(text)).toEqual({ a: "#111" });
  });

  it("handles escapes in selectors and a byte order mark", () => {
    const text = "﻿.theme\\:dark { --a: #fff } :root { --b: #000 }";
    expect(values(text)).toEqual({ b: "#000" });
    expect(values(text, ".theme\\:dark")).toEqual({ a: "#fff" });
  });

  it("warns about names that cannot be token ids", () => {
    const parsed = parseCssTokens(css(":root { --a\\.b: #000; --ok: #fff; }"));
    expect(parsed.tokens.map((t) => t.id)).toEqual(["ok"]);
    expect(parsed.diagnostics[0]?.message).toContain("--a\\.b");
  });

  it("lists where custom properties were found when the selection is empty", () => {
    expect(() => parseCssTokens(css(THEME), ".missing")).toThrow(
      /no custom properties for ".missing".*:root, \[data-theme="dark"\], @media \(prefers-color-scheme: dark\)/,
    );
    expect(() => parseCssTokens(css(".x { color: red }"))).toThrow(/has no custom properties/);
    expect(() => parseCssTokens(css(".dark { --a: #000 }"))).toThrow(
      /Custom properties were found in: \.dark\. Add one of these after "#"/,
    );
  });

  it.each([
    [":root { --a: #000", "This block is never closed", 1, 7],
    [":root { --a: #000 } }", "Unexpected }", 1, 21],
    [":root { --a: #000 /* open", "This comment is never closed", 1, 19],
    [':root {\n  --a: "open\n}', "This string is never closed", 2, 8],
    ["{ --a: #000 }", "A rule is missing its selector", 1, 1],
  ])("reports broken CSS: %s", (text, reason, line, column) => {
    try {
      parseCssTokens(css(text));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TokenFileError);
      expect((error as TokenFileError).message).toContain(reason);
      expect((error as TokenFileError).location).toEqual({ file: "tokens.css", line, column });
    }
  });

  it("refuses absurdly deep nesting instead of overflowing the stack", () => {
    const text = `${".a{".repeat(400)}${"}".repeat(400)}`;
    expect(() => parseCssTokens(css(text))).toThrow(/nested too deeply/);
  });
});

describe("CSS through parseTokenFile and TokenSet", () => {
  it("is chosen by the .css extension whatever the format option says", () => {
    const parsed = parseTokenFile(css(":root { --a: #000 }", "Theme.CSS"), { format: "dtcg" });
    expect(parsed.format).toBe("css");
    expect(isCssPath("a.json")).toBe(false);
  });

  it("can be asked for by format", () => {
    expect(parseTokenFile(css(":root { --a: #000 }", "tokens.txt"), { format: "css" }).format).toBe(
      "css",
    );
  });

  it("layers a theme over :root and resolves var() through both", () => {
    const tokens = TokenSet.fromFiles([
      { file: css(THEME) },
      { file: css(THEME), set: "[data-theme=dark]" },
    ]);
    expect(tokens.resolve("text")).toMatchObject({ ok: true, value: "#f9fafb" });
    expect(tokens.resolve("blue-500")).toMatchObject({ ok: true, value: "#0057ff" });
  });

  it("uses var() fallbacks for missing properties", () => {
    const tokens = TokenSet.fromFiles([{ file: css(":root { --a: var(--brand, #0057ff) }") }]);
    expect(tokens.resolve("a")).toMatchObject({ ok: true, value: "#0057ff", chain: ["a"] });
  });
});

describe("selector and media normalization", () => {
  it("collapses spacing around combinators and quotes attribute values", () => {
    expect(normalizeSelector("  .a   >  .b  [x = 'y']")).toBe('.a > .b [x="y"]');
  });

  it("lowercases media queries and tidies parentheses", () => {
    expect(normalizeMedia("SCREEN  and ( prefers-color-scheme : Dark )")).toBe(
      "screen and (prefers-color-scheme: dark)",
    );
  });
});
