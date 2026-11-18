import { escapePointerSegment } from "./pointer.js";

export interface Position {
  line: number;
  column: number;
}

export class JsonParseError extends Error {
  readonly line: number;
  readonly column: number;
  readonly reason: string;

  constructor(reason: string, position: Position) {
    super(`${reason} (line ${position.line}, column ${position.column})`);
    this.name = "JsonParseError";
    this.reason = reason;
    this.line = position.line;
    this.column = position.column;
  }
}

export interface ParseJsonOptions {
  /** Accept comments and trailing commas. */
  jsonc?: boolean;
  /**
   * Accept JSON5 (https://spec.json5.org): comments, trailing commas, unquoted and single-quoted
   * keys and strings, more escapes, hex numbers, leading or trailing decimal points, "+",
   * Infinity and NaN.
   */
  json5?: boolean;
  maxDepth?: number;
}

export interface ParsedJson {
  value: unknown;
  /**
   * Where each object member and array element starts, keyed by JSON Pointer.
   * Members point at their key, elements at their value.
   */
  positions: Map<string, Position>;
}

export const DEFAULT_MAX_DEPTH = 256;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const NUMBER5 =
  /(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
const ID_START = /[$_\p{ID_Start}]/u;
const ID_PART = /[$_\p{ID_Continue}]|\u200c|\u200d/u;
/** JSON5 whitespace: JSON's, plus vertical tab, form feed, BOM and Unicode spaces and line breaks. */
const SPACE5 = /[\s\ufeff]/;
const ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

export function parseJson(text: string, options: ParseJsonOptions = {}): ParsedJson {
  return new Parser(text, options).parse();
}

class Parser {
  private pos = 0;
  private readonly bom: boolean;
  private readonly lineStarts: number[] = [0];
  private readonly positions = new Map<string, Position>();
  private readonly jsonc: boolean;
  private readonly json5: boolean;
  private readonly maxDepth: number;

  constructor(
    private readonly text: string,
    options: ParseJsonOptions,
  ) {
    this.json5 = options.json5 ?? false;
    this.jsonc = (options.jsonc ?? false) || this.json5;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.bom = text.charCodeAt(0) === 0xfeff;
    if (this.bom) this.pos = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  parse(): ParsedJson {
    this.skipTrivia();
    this.positions.set("", this.positionAt(this.pos));
    const value = this.parseValue("", 0);
    this.skipTrivia();
    if (this.pos < this.text.length) {
      this.fail(`Unexpected ${this.describe()} after the end of the document`);
    }
    return { value, positions: this.positions };
  }

  private positionAt(offset: number): Position {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    let column = offset - (this.lineStarts[lo] ?? 0) + 1;
    if (lo === 0 && this.bom) column -= 1;
    return { line: lo + 1, column };
  }

  private fail(reason: string): never {
    throw new JsonParseError(reason, this.positionAt(this.pos));
  }

  private describe(): string {
    if (this.pos >= this.text.length) return "end of file";
    return `"${this.text[this.pos]}"`;
  }

  private parseValue(pointer: string, depth: number): unknown {
    if (depth > this.maxDepth) this.fail(`Nesting is deeper than ${this.maxDepth} levels`);
    const ch = this.text[this.pos];
    switch (ch) {
      case "{":
        return this.parseObject(pointer, depth);
      case "[":
        return this.parseArray(pointer, depth);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        if (this.json5) {
          if (ch === "'") return this.parseString();
          if (ch !== undefined && "+-.0123456789IN".includes(ch)) return this.parseNumber5();
        }
        if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) return this.parseNumber();
        this.fail(`Unexpected ${this.describe()}`);
    }
  }

  private parseObject(pointer: string, depth: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.pos++;
    this.skipTrivia();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return result;
    }
    for (;;) {
      const keyStart = this.pos;
      const quote = this.text[this.pos];
      let key: string;
      if (quote === '"' || (this.json5 && quote === "'")) {
        key = this.parseString();
      } else if (this.json5) {
        key = this.parseIdentifier();
      } else {
        this.fail(`Expected a property name in double quotes but found ${this.describe()}`);
      }
      const childPointer = `${pointer}/${escapePointerSegment(key)}`;
      this.positions.set(childPointer, this.positionAt(keyStart));
      this.skipTrivia();
      if (this.text[this.pos] !== ":") {
        this.fail(`Expected ":" after "${key}" but found ${this.describe()}`);
      }
      this.pos++;
      this.skipTrivia();
      const value = this.parseValue(childPointer, depth + 1);
      // A plain assignment to "__proto__" would replace the prototype instead of adding a key.
      if (key === "__proto__") {
        Object.defineProperty(result, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        result[key] = value;
      }
      this.skipTrivia();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos++;
        this.skipTrivia();
        if (this.text[this.pos] === "}") {
          if (!this.jsonc) this.fail("Trailing commas are not allowed in JSON");
          this.pos++;
          return result;
        }
        continue;
      }
      if (next === "}") {
        this.pos++;
        return result;
      }
      this.fail(`Expected "," or "}" but found ${this.describe()}`);
    }
  }

  private parseArray(pointer: string, depth: number): unknown[] {
    const result: unknown[] = [];
    this.pos++;
    this.skipTrivia();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return result;
    }
    for (;;) {
      const childPointer = `${pointer}/${result.length}`;
      this.positions.set(childPointer, this.positionAt(this.pos));
      result.push(this.parseValue(childPointer, depth + 1));
      this.skipTrivia();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos++;
        this.skipTrivia();
        if (this.text[this.pos] === "]") {
          if (!this.jsonc) this.fail("Trailing commas are not allowed in JSON");
          this.pos++;
          return result;
        }
        continue;
      }
      if (next === "]") {
        this.pos++;
        return result;
      }
      this.fail(`Expected "," or "]" but found ${this.describe()}`);
    }
  }

  private parseString(): string {
    const start = this.pos;
    const quote = this.text.charCodeAt(this.pos);
    this.pos++;
    let out = "";
    let chunkStart = this.pos;
    for (;;) {
      if (this.pos >= this.text.length) {
        this.pos = start;
        this.fail("Unterminated string");
      }
      const code = this.text.charCodeAt(this.pos);
      if (code === quote) {
        out += this.text.slice(chunkStart, this.pos);
        this.pos++;
        return out;
      }
      if (code === 0x5c) {
        out += this.text.slice(chunkStart, this.pos);
        out += this.json5 ? this.escape5() : this.escape();
        chunkStart = this.pos;
        continue;
      }
      if (this.json5 ? code === 0x0a || code === 0x0d : code < 0x20) {
        this.fail(
          this.json5
            ? "Line breaks inside strings must be escaped"
            : "Control characters must be escaped inside strings",
        );
      }
      this.pos++;
    }
  }

  /** Reads a JSON escape at a backslash and returns the character it stands for. */
  private escape(): string {
    const escaped = this.text[this.pos + 1] ?? "";
    if (escaped === "u") return this.unicodeEscape();
    const value =
      escaped === '"' || escaped === "\\" || escaped === "/" ? escaped : ESCAPES[escaped];
    if (value === undefined) this.fail(`Invalid escape "\\${escaped}" in string`);
    this.pos += 2;
    return value;
  }

  /**
   * Reads a JSON5 escape: JSON's, plus \', \v, \0, \xHH, a backslash before a line break
   * (which continues the string), and any other character standing for itself.
   */
  private escape5(): string {
    const escaped = this.text[this.pos + 1] ?? "";
    if (escaped === "u") return this.unicodeEscape();
    if (escaped === "x") {
      const hex = this.text.slice(this.pos + 2, this.pos + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail("Invalid hex escape in string");
      this.pos += 4;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    if (escaped === "") this.fail("Unterminated string");
    this.pos += 2;
    if (escaped === "\r") {
      if (this.text[this.pos] === "\n") this.pos++;
      return "";
    }
    if (escaped === "\n" || escaped === "\u2028" || escaped === "\u2029") return "";
    if (escaped === "0") {
      if (/\d/.test(this.text[this.pos] ?? "")) this.fail('"\\0" cannot be followed by a digit');
      return "\0";
    }
    if (escaped >= "1" && escaped <= "9") {
      this.pos -= 2;
      this.fail(`Invalid escape "\\${escaped}" in string`);
    }
    return escaped === "v" ? "\v" : (ESCAPES[escaped] ?? escaped);
  }

  private unicodeEscape(): string {
    const hex = this.text.slice(this.pos + 2, this.pos + 6);
    if (!HEX4.test(hex)) this.fail("Invalid unicode escape in string");
    this.pos += 6;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  /** A JSON5 unquoted key: a JavaScript identifier name, which may use \\u escapes. */
  private parseIdentifier(): string {
    let out = "";
    for (;;) {
      let char: string;
      let length: number;
      if (this.text[this.pos] === "\\") {
        if (this.text[this.pos + 1] !== "u") this.fail("Invalid escape in property name");
        const hex = this.text.slice(this.pos + 2, this.pos + 6);
        if (!HEX4.test(hex)) this.fail("Invalid unicode escape in property name");
        char = String.fromCharCode(Number.parseInt(hex, 16));
        length = 6;
        if (!(out === "" ? ID_START : ID_PART).test(char)) {
          this.fail("Invalid character in property name");
        }
      } else {
        const point = this.text.codePointAt(this.pos);
        if (point === undefined) break;
        char = String.fromCodePoint(point);
        length = char.length;
        if (!(out === "" ? ID_START : ID_PART).test(char)) break;
      }
      out += char;
      this.pos += length;
    }
    if (out === "") this.fail(`Expected a property name but found ${this.describe()}`);
    return out;
  }

  /** A JSON5 number: an optional sign, then hex, Infinity, NaN or a decimal. */
  private parseNumber5(): number {
    const sign = this.text[this.pos];
    const signed = sign === "+" || sign === "-";
    NUMBER5.lastIndex = this.pos + (signed ? 1 : 0);
    const match = NUMBER5.exec(this.text);
    if (!match) this.fail(`Unexpected ${this.describe()}`);
    this.pos = NUMBER5.lastIndex;
    // An identifier character right after a number, as in "1x" or "Infinityx", is a mistake.
    if (ID_PART.test(this.text[this.pos] ?? "")) this.fail(`Unexpected ${this.describe()}`);
    const value = Number(match[0]);
    return sign === "-" ? -value : value;
  }

  private parseNumber(): number {
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (!match) this.fail(`Unexpected ${this.describe()}`);
    this.pos += match[0].length;
    return Number(match[0]);
  }

  private parseLiteral<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) this.fail(`Unexpected ${this.describe()}`);
    this.pos += word.length;
    return value;
  }

  private skipTrivia(): void {
    for (;;) {
      const code = this.text.charCodeAt(this.pos);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        this.pos++;
        continue;
      }
      if (this.json5 && SPACE5.test(this.text[this.pos] ?? "")) {
        this.pos++;
        continue;
      }
      if (code === 0x2f) {
        if (!this.jsonc) this.fail("Comments are not allowed in JSON");
        const next = this.text.charCodeAt(this.pos + 1);
        if (next === 0x2f) {
          const end = this.text.indexOf("\n", this.pos);
          this.pos = end === -1 ? this.text.length : end;
          continue;
        }
        if (next === 0x2a) {
          const end = this.text.indexOf("*/", this.pos + 2);
          if (end === -1) this.fail("Unterminated comment");
          this.pos = end + 2;
          continue;
        }
        this.fail('Unexpected "/"');
      }
      return;
    }
  }
}
