import { JsonParseError, type Position, parseJson } from "./json.js";
import {
  type Diagnostic,
  isPlainObject,
  type SourceFile,
  type Token,
  TokenFileError,
  type TokenFormat,
} from "./model.js";
import { toPointer } from "./pointer.js";

export interface ParseTokensOptions {
  /** Defaults to "auto", which looks for "$value" (DTCG) or "value" + "type" (Tokens Studio). */
  format?: TokenFormat | "auto";
  /** Read only this top-level key, for example one Tokens Studio set. */
  set?: string;
}

export interface ParsedTokens {
  format: TokenFormat;
  tokens: Token[];
  diagnostics: Diagnostic[];
}

interface Keys {
  value: string;
  type: string;
  description: string;
  inheritType: boolean;
}

const DTCG_KEYS: Keys = {
  value: "$value",
  type: "$type",
  description: "$description",
  inheritType: true,
};

const STUDIO_KEYS: Keys = {
  value: "value",
  type: "type",
  description: "description",
  inheritType: false,
};

const RESERVED_NAME_CHARS = /[.{}]/;

export function parseTokenFile(file: SourceFile, options: ParseTokensOptions = {}): ParsedTokens {
  let parsed: ReturnType<typeof parseJson>;
  try {
    parsed = parseJson(file.text, { jsonc: true });
  } catch (error) {
    if (error instanceof JsonParseError) {
      throw new TokenFileError(`${file.path} is not valid JSON: ${error.reason}`, {
        file: file.path,
        line: error.line,
        column: error.column,
      });
    }
    throw error;
  }

  const document = parsed.value;
  if (!isPlainObject(document)) {
    throw new TokenFileError(`${file.path} must contain a JSON object at the top level`, {
      file: file.path,
      line: 1,
      column: 1,
    });
  }

  const format =
    options.format === undefined || options.format === "auto"
      ? detectFormat(document)
      : options.format;
  const keys = format === "dtcg" ? DTCG_KEYS : STUDIO_KEYS;
  const walker = new Walker(file.path, parsed.positions, keys);

  if (options.set !== undefined) {
    const subtree = document[options.set];
    if (!isPlainObject(subtree)) {
      const available = Object.keys(document).filter((key) => !key.startsWith("$"));
      throw new TokenFileError(
        `Token set "${options.set}" was not found in ${file.path}. ` +
          `Available sets: ${available.length > 0 ? available.join(", ") : "none"}`,
        { file: file.path, line: 1, column: 1 },
      );
    }
    walker.walk(subtree, [], [options.set], undefined);
  } else if (isStudioMultiSet(document)) {
    for (const setName of studioSetOrder(document)) {
      const subtree = document[setName];
      if (isPlainObject(subtree)) walker.walk(subtree, [], [setName], undefined);
    }
  } else {
    walker.walk(document, [], [], undefined);
  }

  return { format, tokens: walker.tokens, diagnostics: walker.diagnostics };
}

function detectFormat(document: Record<string, unknown>): TokenFormat {
  if (containsKey(document, (node) => "$value" in node)) return "dtcg";
  if (containsKey(document, (node) => "value" in node && "type" in node)) return "tokens-studio";
  return "dtcg";
}

function containsKey(root: unknown, test: (node: Record<string, unknown>) => boolean): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isPlainObject(node)) continue;
    if (test(node)) return true;
    for (const child of Object.values(node)) stack.push(child);
  }
  return false;
}

function isStudioMultiSet(document: Record<string, unknown>): boolean {
  return "$themes" in document || "$metadata" in document;
}

function studioSetOrder(document: Record<string, unknown>): string[] {
  const metadata = document.$metadata;
  if (isPlainObject(metadata) && Array.isArray(metadata.tokenSetOrder)) {
    return metadata.tokenSetOrder.filter((name): name is string => typeof name === "string");
  }
  return Object.keys(document).filter((key) => !key.startsWith("$"));
}

class Walker {
  readonly tokens: Token[] = [];
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    private readonly file: string,
    private readonly positions: Map<string, Position>,
    private readonly keys: Keys,
  ) {}

  walk(
    node: Record<string, unknown>,
    path: string[],
    pointerPath: string[],
    inheritedType: string | undefined,
  ): void {
    if (this.isToken(node)) {
      this.addToken(node, path, pointerPath, inheritedType);
      return;
    }

    const ownType = node[this.keys.type];
    const groupType =
      this.keys.inheritType && typeof ownType === "string" ? ownType : inheritedType;

    for (const [name, child] of Object.entries(node)) {
      if (name.startsWith("$") || !isPlainObject(child)) continue;
      const childPath = [...path, name];
      const childPointer = [...pointerPath, name];
      if (RESERVED_NAME_CHARS.test(name)) {
        this.diagnostics.push({
          severity: "warning",
          message: `"${name}" contains ".", "{" or "}", which token names cannot use. It was skipped.`,
          location: this.locate(childPointer),
        });
        continue;
      }
      this.walk(child, childPath, childPointer, groupType);
    }
  }

  private isToken(node: Record<string, unknown>): boolean {
    if (!(this.keys.value in node)) return false;
    return this.keys === DTCG_KEYS || this.keys.type in node;
  }

  private addToken(
    node: Record<string, unknown>,
    path: string[],
    pointerPath: string[],
    inheritedType: string | undefined,
  ): void {
    const location = this.locate(pointerPath);
    if (path.length === 0) {
      this.diagnostics.push({
        severity: "warning",
        message: "A token at the top level of the file has no name. It was skipped.",
        location,
      });
      return;
    }
    const ownType = node[this.keys.type];
    const description = node[this.keys.description];
    const extensions = node.$extensions;
    this.tokens.push({
      id: path.join("."),
      path,
      type: typeof ownType === "string" ? ownType : inheritedType,
      value: node[this.keys.value],
      description: typeof description === "string" ? description : undefined,
      extensions: isPlainObject(extensions) ? extensions : undefined,
      source: location,
    });
  }

  private locate(pointerPath: string[]) {
    const position = this.positions.get(toPointer(pointerPath)) ?? { line: 1, column: 1 };
    return { file: this.file, line: position.line, column: position.column };
  }
}
