import { DEFAULT_MAX_DEPTH } from "./json.js";
import {
  type Diagnostic,
  type SourceFile,
  type SourceLocation,
  type Token,
  TokenFileError,
} from "./model.js";

/**
 * Reads CSS custom properties as tokens. Only declarations whose name starts with "--" are kept;
 * everything else in the file is skipped without being interpreted.
 *
 * Which declarations count depends on `set`:
 * - no set: `:root` and `html` rules outside any `@media`
 * - "@media <query>": `:root` and `html` rules inside that media query
 * - any other text: rules with exactly that selector, outside any `@media`
 *
 * `@layer` and `@supports` blocks are read as if they were not there. Other at-rules are skipped.
 * `var(--name)` becomes the alias "{name}", and `var(--name, fallback)` keeps the fallback.
 */
export function parseCssTokens(
  file: SourceFile,
  set?: string,
): { format: "css"; tokens: Token[]; diagnostics: Diagnostic[] } {
  const blocks = new CssParser(file).parse();
  const selection = parseSelection(set);
  const declarations = new Map<string, Declaration>();
  const contexts = new Set<string>();

  for (const block of blocks) {
    if (block.declarations.length === 0) continue;
    for (const context of describeContexts(block)) contexts.add(context);
    if (!selection.matches(block)) continue;
    for (const declaration of block.declarations) {
      // Later declarations win, as they do in the browser.
      declarations.delete(declaration.name);
      declarations.set(declaration.name, declaration);
    }
  }

  if (declarations.size === 0) {
    const available = [...contexts];
    throw new TokenFileError(
      `${file.path} has no custom properties for ${selection.label}. ` +
        (available.length > 0
          ? `Custom properties were found in: ${available.join(", ")}. Add one of these after "#" in the config, like "${file.path}#${available[0]}".`
          : "The file has no custom properties (names starting with --) inside rules."),
      { file: file.path, line: 1, column: 1 },
    );
  }

  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const declaration of declarations.values()) {
    const id = declaration.name.slice(2);
    if (id === "" || /[.{}]/.test(id)) {
      diagnostics.push({
        severity: "warning",
        message: `"${declaration.name}" contains ".", "{" or "}", which token names cannot use. It was skipped.`,
        location: declaration.location,
      });
      continue;
    }
    const token: Token = {
      id,
      path: [id],
      type: undefined,
      value: declaration.value,
      description: undefined,
      extensions: undefined,
      source: declaration.location,
    };
    const reference = parseVar(declaration.value);
    if (reference) {
      token.value = `{${reference.name}}`;
      if (reference.fallback !== undefined) {
        const nested = parseVar(reference.fallback);
        token.fallback = nested ? `{${nested.name}}` : reference.fallback;
      }
    }
    tokens.push(token);
  }
  return { format: "css", tokens, diagnostics };
}

/**
 * Every selection that has custom properties, in file order: ":root", selectors, and
 * "@media ..." queries. Each one can be passed back as `set`.
 */
export function listCssContexts(file: SourceFile): string[] {
  const contexts = new Set<string>();
  for (const block of new CssParser(file).parse()) {
    for (const context of describeContexts(block)) contexts.add(context);
  }
  return [...contexts];
}

export function isCssPath(path: string): boolean {
  return path.toLowerCase().endsWith(".css");
}

interface Declaration {
  name: string;
  value: string;
  location: SourceLocation;
}

interface Block {
  selectors: readonly string[];
  media: readonly string[];
  declarations: Declaration[];
}

const ROOT_SELECTORS = [":root", "html"];
const TRANSPARENT_AT_RULES = ["layer", "supports"];

interface Selection {
  label: string;
  matches(block: Block): boolean;
}

function parseSelection(set: string | undefined): Selection {
  if (set === undefined) {
    return {
      label: ":root",
      matches: (block) =>
        block.media.length === 0 && block.selectors.some((s) => ROOT_SELECTORS.includes(s)),
    };
  }
  const media = /^@media\s+([\s\S]+)$/i.exec(set.trim());
  if (media?.[1]) {
    const query = normalizeMedia(media[1]);
    return {
      label: `@media ${query}`,
      matches: (block) =>
        block.media.length === 1 &&
        block.media[0] === query &&
        block.selectors.some((s) => ROOT_SELECTORS.includes(s)),
    };
  }
  const selector = normalizeSelector(set);
  return {
    label: `"${selector}"`,
    matches: (block) => block.media.length === 0 && block.selectors.includes(selector),
  };
}

/** How each block could be selected, for the error message when nothing matches. */
function describeContexts(block: Block): string[] {
  if (block.media.length > 1) return [];
  const roots = block.selectors.filter((s) => ROOT_SELECTORS.includes(s));
  if (block.media.length === 1) return roots.length > 0 ? [`@media ${block.media[0]}`] : [];
  return block.selectors.map((s) => (ROOT_SELECTORS.includes(s) ? ":root" : s));
}

const VAR = /^var\(\s*--([^\s,()]+)\s*(?:,([\s\S]*))?\)$/i;

function parseVar(value: string): { name: string; fallback?: string } | undefined {
  const match = VAR.exec(value);
  if (!match?.[1] || !balanced(match[2] ?? "")) return undefined;
  const fallback = match[2]?.trim();
  return fallback ? { name: match[1], fallback } : { name: match[1] };
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth++;
    else if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

export function normalizeSelector(selector: string): string {
  return selector
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([>+~])\s*/g, " $1 ")
    .replace(/\[\s*([^\]=\s]+)\s*=\s*(["']?)([^\]"']*)\2\s*\]/g, '[$1="$3"]');
}

export function normalizeMedia(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\(\s*/g, "(")
    .replace(/\s*\)/g, ")")
    .replace(/\s*:\s*/g, ": ");
}

function splitSelectors(prelude: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const char = prelude[i];
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      selectors.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  selectors.push(prelude.slice(start));
  return selectors.map(normalizeSelector).filter((s) => s !== "");
}

function nest(parents: readonly string[], children: readonly string[]): string[] {
  if (parents.length === 0) return [...children];
  const result: string[] = [];
  for (const parent of parents) {
    for (const child of children) {
      result.push(
        child.includes("&")
          ? normalizeSelector(child.replaceAll("&", parent))
          : `${parent} ${child}`,
      );
    }
  }
  return result;
}

/**
 * A small CSS reader. It understands comments, strings, escapes and nested blocks well enough to
 * find custom property declarations and the rules around them. It never evaluates anything.
 */
class CssParser {
  private index = 0;
  private readonly lineStarts: number[] = [0];
  private readonly blocks: Block[] = [];

  constructor(private readonly file: SourceFile) {
    const text = file.text;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  parse(): Block[] {
    if (this.file.text.charCodeAt(0) === 0xfeff) this.index = 1;
    this.readBlock({ selectors: [], media: [], skip: false }, 0);
    if (this.index < this.file.text.length) {
      this.fail("Unexpected }", this.index);
    }
    return this.blocks;
  }

  /** Reads until the matching "}" (which it consumes) or the end of the file at depth 0. */
  private readBlock(
    context: { selectors: readonly string[]; media: readonly string[]; skip: boolean },
    depth: number,
  ): void {
    if (depth > DEFAULT_MAX_DEPTH) this.fail("Blocks are nested too deeply", this.index);
    const block: Block = { selectors: context.selectors, media: context.media, declarations: [] };
    const text = this.file.text;
    const opened = this.index - 1;

    for (;;) {
      this.skipSpaceAndComments();
      if (this.index >= text.length) {
        if (depth > 0) this.fail("This block is never closed", opened);
        break;
      }
      if (text[this.index] === "}") {
        if (depth === 0) break;
        this.index++;
        break;
      }

      const start = this.index;
      const isCustomProperty = text.startsWith("--", start);
      const terminator = this.scanComponent(isCustomProperty);
      const raw = text.slice(start, this.index);

      if (terminator === "{") {
        const prelude = stripComments(raw.slice(0, -1)).trim();
        this.readChild(prelude, context, depth, start);
        continue;
      }
      const statement = terminator === ";" ? raw.slice(0, -1) : raw;
      if (isCustomProperty && !context.skip && context.selectors.length > 0) {
        const declaration = this.readDeclaration(statement, start);
        if (declaration) block.declarations.push(declaration);
      }
    }

    if (block.declarations.length > 0) this.blocks.push(block);
  }

  private readChild(
    prelude: string,
    context: { selectors: readonly string[]; media: readonly string[]; skip: boolean },
    depth: number,
    start: number,
  ): void {
    if (prelude.startsWith("@")) {
      const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude);
      const name = match?.[1]?.toLowerCase() ?? "";
      const condition = match?.[2] ?? "";
      if (name === "media") {
        this.readBlock(
          { ...context, media: [...context.media, normalizeMedia(condition)] },
          depth + 1,
        );
      } else if (TRANSPARENT_AT_RULES.includes(name)) {
        this.readBlock(context, depth + 1);
      } else {
        this.readBlock({ ...context, skip: true }, depth + 1);
      }
      return;
    }
    if (prelude === "") this.fail("A rule is missing its selector", start);
    this.readBlock(
      { ...context, selectors: nest(context.selectors, splitSelectors(prelude)) },
      depth + 1,
    );
  }

  private readDeclaration(statement: string, start: number): Declaration | undefined {
    const colon = statement.indexOf(":");
    if (colon === -1) return undefined;
    const name = statement.slice(0, colon).trim();
    if (!/^--[^\s:]*$/.test(name)) return undefined;
    const value = stripComments(statement.slice(colon + 1))
      .trim()
      .replace(/\s*!\s*important$/i, "")
      .trim();
    return { name, value, location: this.locate(start) };
  }

  /**
   * Advances past one declaration or rule prelude and returns what ended it: ";", "{", or ""
   * for a closing "}" or the end of the file (neither is consumed). Custom property values may
   * contain balanced braces, so for those only ";" or an unmatched "}" ends the value.
   */
  private scanComponent(customProperty: boolean): ";" | "{" | "" {
    const text = this.file.text;
    let parens = 0;
    let braces = 0;
    let sawColon = false;
    while (this.index < text.length) {
      const char = text[this.index];
      if (char === "/" && text[this.index + 1] === "*") {
        this.skipComment();
        continue;
      }
      if (char === '"' || char === "'") {
        this.skipString(char);
        continue;
      }
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      if (char === "(" || char === "[") parens++;
      else if ((char === ")" || char === "]") && parens > 0) parens--;
      else if (char === ":" && parens === 0) sawColon = true;
      else if (parens === 0) {
        if (char === "{") {
          if (customProperty && sawColon) braces++;
          else {
            this.index++;
            return "{";
          }
        } else if (char === "}") {
          if (braces === 0) return "";
          braces--;
        } else if (char === ";" && braces === 0) {
          this.index++;
          return ";";
        }
      }
      this.index++;
    }
    return "";
  }

  private skipSpaceAndComments(): void {
    const text = this.file.text;
    while (this.index < text.length) {
      const char = text[this.index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f") {
        this.index++;
      } else if (char === "/" && text[this.index + 1] === "*") {
        this.skipComment();
      } else if (char === ";") {
        this.index++;
      } else {
        return;
      }
    }
  }

  private skipComment(): void {
    const end = this.file.text.indexOf("*/", this.index + 2);
    if (end === -1) this.fail("This comment is never closed", this.index);
    this.index = end + 2;
  }

  private skipString(quote: string): void {
    const text = this.file.text;
    const start = this.index;
    this.index++;
    while (this.index < text.length) {
      const char = text[this.index];
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      if (char === quote) {
        this.index++;
        return;
      }
      if (char === "\n") break;
      this.index++;
    }
    this.fail("This string is never closed", start);
  }

  private locate(offset: number): SourceLocation {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return {
      file: this.file.path,
      line: low + 1,
      column: offset - (this.lineStarts[low] ?? 0) + 1,
    };
  }

  private fail(reason: string, offset: number): never {
    const location = this.locate(offset);
    throw new TokenFileError(`${this.file.path} is not valid CSS: ${reason}`, location);
  }
}

function stripComments(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== char) j += text[j] === "\\" ? 2 : 1;
      result += text.slice(i, j + 1);
      i = j + 1;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      result += " ";
    } else {
      result += char;
      i++;
    }
  }
  return result;
}
