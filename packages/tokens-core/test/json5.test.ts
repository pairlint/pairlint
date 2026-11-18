import { describe, expect, it } from "vitest";
import { JsonParseError, parseJson, parseTokenFile } from "../src/index.js";

const json5 = (text: string) => parseJson(text, { json5: true }).value;

describe("parseJson with json5", () => {
  it("reads the example from the JSON5 site", () => {
    const text = `{
  // comments
  unquoted: 'and you can quote me on that',
  singleQuotes: 'I can use "double quotes" here',
  lineBreaks: "Look, Mom! \\
No \\\\n's!",
  hexadecimal: 0xdecaf,
  leadingDecimalPoint: .8675309, andTrailing: 8675309.,
  positiveSign: +1,
  trailingComma: 'in objects', andIn: ['arrays',],
  "backwardsCompatible": "with JSON",
}`;
    expect(json5(text)).toEqual({
      unquoted: "and you can quote me on that",
      singleQuotes: 'I can use "double quotes" here',
      lineBreaks: "Look, Mom! No \\n's!",
      hexadecimal: 0xdecaf,
      leadingDecimalPoint: 0.8675309,
      andTrailing: 8675309,
      positiveSign: 1,
      trailingComma: "in objects",
      andIn: ["arrays"],
      backwardsCompatible: "with JSON",
    });
  });

  it("reads every kind of number", () => {
    expect(json5("[Infinity, -Infinity, +Infinity, -0x1F, 0XfF, 1e3, 1.e-2, -.5, +5.]")).toEqual([
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      -31,
      255,
      1000,
      0.01,
      -0.5,
      5,
    ]);
    expect(json5("NaN")).toBeNaN();
    expect(json5("-NaN")).toBeNaN();
  });

  it("reads every escape", () => {
    expect(json5(String.raw`'\' \" \\ \/ \b \f \n \r \t \v \0 \x41 é \q \😀'`)).toBe(
      "' \" \\ / \b \f \n \r \t \v \0 A é q 😀",
    );
    expect(json5("'a\\\r\nb\\\rc\\ d'")).toBe("abcd");
    expect(json5("'line sep'")).toBe("line sep");
    expect(json5("'tab\there'")).toBe("tab\there");
  });

  it("reads unquoted keys, including reserved words, Unicode and escapes", () => {
    expect(json5("{ null: 1, $a_1: 2, ünïcode: 3, \\u0061b: 4, a\\u0062c: 5, _: 6 }")).toEqual({
      null: 1,
      $a_1: 2,
      ünïcode: 3,
      ab: 4,
      abc: 5,
      _: 6,
    });
  });

  it("skips JSON5 whitespace", () => {
    expect(json5("\u000b\u000c ﻿  　[1,  2]")).toEqual([1, 2]);
  });

  it("records positions for unquoted and single-quoted keys", () => {
    const { positions } = parseJson("{\n  a: 1,\n  'b': { c: 2 }\n}", { json5: true });
    expect(positions.get("/a")).toEqual({ line: 2, column: 3 });
    expect(positions.get("/b")).toEqual({ line: 3, column: 3 });
    expect(positions.get("/b/c")).toEqual({ line: 3, column: 10 });
  });

  it.each([
    ["01", 'Unexpected "1"'],
    ["0x", 'Unexpected "x"'],
    ["1x", 'Unexpected "x"'],
    ["Infinityx", 'Unexpected "x"'],
    ["Inf", 'Unexpected "I"'],
    ["+ 1", 'Unexpected "+"'],
    ["'a\nb'", "Line breaks inside strings must be escaped"],
    ["'a", "Unterminated string"],
    ["'a\\", "Unterminated string"],
    ["'\\1'", 'Invalid escape "\\1" in string'],
    ["'\\01'", '"\\0" cannot be followed by a digit'],
    ["'\\x4'", "Invalid hex escape in string"],
    ["{ 1a: 1 }", 'Expected a property name but found "1"'],
    ["{ a-b: 1 }", 'Expected ":" after "a" but found "-"'],
    ["{ \\u0031: 1 }", "Invalid character in property name"],
    ["{ a\\x62: 1 }", "Invalid escape in property name"],
    ["/* open", "Unterminated comment"],
    ["[1,,]", 'Unexpected ","'],
  ])("rejects %j", (text, reason) => {
    expect(() => json5(text)).toThrow(JsonParseError);
    try {
      json5(text);
    } catch (error) {
      expect((error as JsonParseError).reason).toBe(reason);
    }
  });

  it("keeps plain JSON strict", () => {
    expect(() => parseJson("{ a: 1 }")).toThrow("Expected a property name in double quotes");
    expect(() => parseJson("['a']")).toThrow('Unexpected "\'"');
    expect(() => parseJson("[0x1]")).toThrow('Expected "," or "]"');
    expect(() => parseJson('["\\x41"]')).toThrow('Invalid escape "\\x" in string');
    expect(() => parseJson('["a\tb"]')).toThrow("Control characters must be escaped");
  });

  it("reads .json5 token files and names JSON5 in errors", () => {
    const parsed = parseTokenFile({
      path: "tokens/color.json5",
      text: "{ color: { fg: { $type: 'color', $value: '#000', }, }, }",
    });
    expect(parsed.tokens.map((token) => token.id)).toEqual(["color.fg"]);
    expect(() => parseTokenFile({ path: "a.json5", text: "{ a: }" })).toThrow(
      "a.json5 is not valid JSON5",
    );
    expect(() => parseTokenFile({ path: "a.json", text: "{ a: 1 }" })).toThrow(
      "a.json is not valid JSON",
    );
  });
});

/** A small seeded generator, so a failing case can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick };
}

type Rng = ReturnType<typeof random>;

const CHARS = [..."abcXYZ09 _$-./'\"\\\t\n\r\b\f\v\0é漢😀   {}[],:"];

function randomString(rng: Rng): string {
  let out = "";
  for (let i = rng.int(8); i > 0; i--) out += rng.pick(CHARS);
  return out;
}

function randomValue(rng: Rng, depth: number): unknown {
  const kind = rng.int(depth > 3 ? 4 : 6);
  switch (kind) {
    case 0:
      return rng.pick([null, true, false]);
    case 1:
      return rng.pick([0, 1, 7, 42, 255, 65535, 1e21, -3, -1e-7]);
    case 2:
      return Math.round((rng.next() - 0.5) * 1e6) / 1000 || 1;
    case 3:
      return randomString(rng);
    case 4:
      return Array.from({ length: rng.int(4) }, () => randomValue(rng, depth + 1));
    default: {
      const object: Record<string, unknown> = {};
      for (let i = rng.int(4); i > 0; i--) {
        object[rng.pick(["a", "$b", "_c1", "null", "ünï", randomString(rng)])] = randomValue(
          rng,
          depth + 1,
        );
      }
      return object;
    }
  }
}

/** Writes a value as JSON5, choosing randomly among the forms JSON5 allows. */
function write(value: unknown, rng: Rng): string {
  const space = () => rng.pick(["", " ", "\n", "\t", "\u000b", " ", " ", " // note\n", "/* c */"]);
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    const sign = value >= 0 && rng.int(4) === 0 ? "+" : "";
    if (Number.isInteger(value) && value >= 0 && value < 2 ** 32 && rng.int(3) === 0) {
      return `${sign}0x${value.toString(rng.int(2) ? 16 : 16).toUpperCase()}`;
    }
    const text = String(value);
    if (/^0\.\d/.test(text) && rng.int(2)) return `${sign}${text.slice(1)}`;
    if (/^\d+$/.test(text) && rng.int(3) === 0) return `${sign}${text}.`;
    return `${sign}${text}`;
  }
  if (typeof value === "string") return quote(value, rng);
  const trailing = () => (rng.int(3) === 0 ? "," : "");
  if (Array.isArray(value)) {
    if (value.length === 0) return `[${space()}]`;
    return `[${value.map((item) => `${space()}${write(item, rng)}${space()}`).join(",")}${trailing()}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `{${space()}}`;
  const key = (name: string) =>
    /^[A-Za-z_$][\w$]*$/.test(name) && rng.int(2) ? name : quote(name, rng);
  return `{${entries
    .map(([name, item]) => `${space()}${key(name)}${space()}:${space()}${write(item, rng)}`)
    .join(",")}${trailing()}${space()}}`;
}

function quote(text: string, rng: Rng): string {
  const mark = rng.pick(["'", '"']);
  let out = mark;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === mark || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += rng.pick(["\\n", "\\u000a", "\\x0A"]);
    else if (char === "\r") out += rng.pick(["\\r", "\\x0d"]);
    // "\0" before a digit would be an octal escape, which JSON5 does not allow.
    else if (char === "\0") out += rng.pick(["\\x00", "\\u0000"]);
    else if (char === "\v") out += rng.pick(["\\v", "\v"]);
    else if (code < 0x20) out += rng.pick([char, `\\x${code.toString(16).padStart(2, "0")}`]);
    else if (code < 0x10000 && rng.int(6) === 0) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (rng.int(10) === 0 && /[a-zA-Z]/.test(char) && !"bfnrtvux".includes(char)) {
      out += `\\${char}`;
    } else out += char;
  }
  // A line continuation adds nothing to the value.
  if (rng.int(5) === 0) out += rng.pick(["\\\n", "\\\r\n", "\\ "]);
  return out + mark;
}

describe("parseJson with json5, fuzzed", () => {
  it("reads back random values written in random JSON5 forms", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const rng = random(seed);
      const value = randomValue(rng, 0);
      const text = write(value, rng);
      let parsed: unknown;
      try {
        parsed = json5(text);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}\n${text}`);
      }
      expect(parsed, `seed ${seed}: ${text}`).toEqual(value);
    }
  });

  it("reads plain JSON the same way JSON.parse does", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const text = JSON.stringify(randomValue(random(seed), 0), null, seed % 3);
      expect(json5(text)).toEqual(JSON.parse(text));
      expect(parseJson(text).value).toEqual(JSON.parse(text));
    }
  });

  it("either parses or throws JsonParseError on mangled input, and never hangs", () => {
    const pieces = ["'", '"', "\\", "/", "*", "0x", ".", "+", "{", "}", "[", "]", ",", ":", "\n"];
    for (let seed = 1; seed <= 3000; seed++) {
      const rng = random(seed);
      let text = write(randomValue(rng, 0), rng);
      for (let edits = 1 + rng.int(3); edits > 0; edits--) {
        const at = rng.int(text.length + 1);
        const cut = rng.int(3);
        text = text.slice(0, at) + (rng.int(2) ? rng.pick(pieces) : "") + text.slice(at + cut);
      }
      try {
        json5(text);
      } catch (error) {
        if (!(error instanceof JsonParseError)) {
          throw new Error(`seed ${seed}: ${String(error)}\n${JSON.stringify(text)}`);
        }
      }
    }
  });
});
