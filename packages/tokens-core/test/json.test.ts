import { describe, expect, it } from "vitest";
import { JsonParseError, parseJson } from "../src/index.js";

describe("parseJson", () => {
  it("parses the same values as JSON.parse", () => {
    const text = '{"a": [1, -2.5e3, true, false, null], "b": {"c": "d\\n\\u00e9\\"x"}}';
    expect(parseJson(text).value).toEqual(JSON.parse(text));
  });

  it("records the position of every member key and array element", () => {
    const text = '{\n  "color": {\n    "red": { "$value": "#f00" }\n  },\n  "list": [10, 20]\n}';
    const { positions } = parseJson(text);
    expect(positions.get("")).toEqual({ line: 1, column: 1 });
    expect(positions.get("/color")).toEqual({ line: 2, column: 3 });
    expect(positions.get("/color/red")).toEqual({ line: 3, column: 5 });
    expect(positions.get("/color/red/$value")).toEqual({ line: 3, column: 14 });
    expect(positions.get("/list/1")).toEqual({ line: 5, column: 16 });
  });

  it("escapes pointer segments that contain / or ~", () => {
    const { positions } = parseJson('{"a/b": {"c~d": 1}}');
    expect(positions.has("/a~1b/c~0d")).toBe(true);
  });

  it("ignores a byte order mark when reporting columns", () => {
    const { positions } = parseJson('﻿{"a": 1}');
    expect(positions.get("/a")).toEqual({ line: 1, column: 2 });
  });

  it("allows comments and trailing commas only in JSONC mode", () => {
    const text = '{\n  // note\n  "a": [1, 2,], /* more */\n  "b": 2,\n}';
    expect(parseJson(text, { jsonc: true }).value).toEqual({ a: [1, 2], b: 2 });
    expect(() => parseJson(text)).toThrow(JsonParseError);
    expect(() => parseJson('{"a": 1,}')).toThrow(/Trailing commas/);
  });

  it("keeps __proto__ as a normal key instead of changing the prototype", () => {
    const value = parseJson('{"__proto__": {"polluted": true}}').value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ['{"a": 1', 'Expected "," or "}" but found end of file', 1, 8],
    ['{"a" 1}', 'Expected ":" after "a"', 1, 6],
    ["{a: 1}", "Expected a property name", 1, 2],
    ['["unterminated]', "Unterminated string", 1, 2],
    ['"bad \\x escape"', 'Invalid escape "\\x"', 1, 6],
    ["[1, 2] 3", "after the end of the document", 1, 8],
    ["[01]", 'Expected "," or "]"', 1, 3],
    ["/* open", "Comments are not allowed", 1, 1],
  ])("reports %s with a position", (text, message, line, column) => {
    try {
      parseJson(text);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JsonParseError);
      const parseError = error as JsonParseError;
      expect(parseError.reason).toContain(message);
      expect([parseError.line, parseError.column]).toEqual([line, column]);
    }
  });

  it("rejects raw control characters inside strings", () => {
    expect(() => parseJson('"a\tb"')).toThrow(/Control characters/);
  });

  it("stops at the nesting limit instead of overflowing the stack", () => {
    const deep = `${"[".repeat(300)}${"]".repeat(300)}`;
    expect(() => parseJson(deep)).toThrow(/deeper than 256/);
    expect(() => parseJson("[[[]]]", { maxDepth: 1 })).toThrow(/deeper than 1/);
  });
});
