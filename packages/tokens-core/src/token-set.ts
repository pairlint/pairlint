import type { Diagnostic, SourceFile, Token, TokenFormat } from "./model.js";
import { parseTokenFile } from "./parse-tokens.js";
import { compileTokenPattern } from "./pattern.js";

export const MAX_ALIAS_DEPTH = 32;

const ALIAS = /^\{([^{}\s]+)\}$/;
const EMBEDDED_ALIAS = /\{[^{}\s]+\}/;

export type Resolution =
  | {
      ok: true;
      id: string;
      /** The token that was asked for, not the end of its alias chain. */
      token: Token;
      value: unknown;
      type: string | undefined;
      /** Every id visited, starting with the one asked for. */
      chain: readonly string[];
    }
  | {
      ok: false;
      id: string;
      error: string;
      chain: readonly string[];
    };

export interface TokenSetInput {
  file: SourceFile;
  set?: string;
  format?: TokenFormat | "auto";
}

/** Returns the referenced id when the value is exactly one alias like "{color.blue.500}". */
export function aliasTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return ALIAS.exec(value)?.[1];
}

/**
 * Tokens merged from one or more files. When two files define the same id, the later one wins,
 * which is how mode files override a shared base.
 */
export class TokenSet {
  private readonly tokens = new Map<string, Token>();
  private readonly cache = new Map<string, Resolution>();
  private sortedIds: string[] | undefined;
  readonly diagnostics: readonly Diagnostic[];

  constructor(tokens: Iterable<Token>, diagnostics: readonly Diagnostic[] = []) {
    for (const token of tokens) this.tokens.set(token.id, token);
    this.diagnostics = diagnostics;
  }

  static fromFiles(inputs: readonly TokenSetInput[]): TokenSet {
    const tokens: Token[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const input of inputs) {
      const options: { set?: string; format?: TokenFormat | "auto" } = {};
      if (input.set !== undefined) options.set = input.set;
      if (input.format !== undefined) options.format = input.format;
      const parsed = parseTokenFile(input.file, options);
      tokens.push(...parsed.tokens);
      diagnostics.push(...parsed.diagnostics);
    }
    return new TokenSet(tokens, diagnostics);
  }

  get size(): number {
    return this.tokens.size;
  }

  has(id: string): boolean {
    return this.tokens.has(id);
  }

  get(id: string): Token | undefined {
    return this.tokens.get(id);
  }

  ids(): readonly string[] {
    this.sortedIds ??= [...this.tokens.keys()].sort();
    return this.sortedIds;
  }

  /** Ids matching a pattern, sorted. See compileTokenPattern for the syntax. */
  match(pattern: string): string[] {
    const matches = compileTokenPattern(pattern);
    return this.ids().filter(matches);
  }

  resolve(id: string): Resolution {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const result = this.resolveUncached(id);
    this.cache.set(id, result);
    return result;
  }

  /**
   * Style Dictionary 3 references point at the value itself, like "{color.blue.500.value}".
   * Those resolve to the token when no token has the longer id.
   */
  private canonicalId(id: string): string {
    if (this.tokens.has(id) || !id.endsWith(".value")) return id;
    const short = id.slice(0, -".value".length);
    return this.tokens.has(short) ? short : id;
  }

  private resolveUncached(id: string): Resolution {
    const first = this.tokens.get(id);
    if (!first) return { ok: false, id, error: `Token "${id}" does not exist`, chain: [id] };

    const chain: string[] = [];
    let type: string | undefined;
    let current = id;
    let referrer: Token | undefined;
    for (;;) {
      current = this.canonicalId(current);
      if (chain.includes(current)) {
        return {
          ok: false,
          id,
          error: `Alias cycle: ${[...chain, current].join(" → ")}`,
          chain,
        };
      }
      chain.push(current);
      if (chain.length > MAX_ALIAS_DEPTH) {
        return {
          ok: false,
          id,
          error: `"${id}" follows more than ${MAX_ALIAS_DEPTH} aliases`,
          chain,
        };
      }
      const token = this.tokens.get(current);
      if (!token && referrer?.fallback !== undefined) {
        // CSS: var(--missing, fallback) uses the fallback. The missing id leaves the chain.
        chain.pop();
        const fallback = referrer.fallback;
        const fallbackTarget = aliasTarget(fallback);
        if (fallbackTarget === undefined) {
          return { ok: true, id, token: first, value: fallback, type, chain };
        }
        referrer = undefined;
        current = fallbackTarget;
        continue;
      }
      if (!token) {
        const from = chain[chain.length - 2] ?? id;
        return {
          ok: false,
          id,
          error: `"${from}" refers to "{${current}}", which does not exist`,
          chain,
        };
      }
      type ??= token.type;
      const target = aliasTarget(token.value);
      if (target === undefined) {
        if (typeof token.value === "string" && EMBEDDED_ALIAS.test(token.value)) {
          return {
            ok: false,
            id,
            error: `"${token.id}" mixes a reference with other text ("${token.value}"), which pairlint cannot resolve yet`,
            chain,
          };
        }
        return { ok: true, id, token: first, value: token.value, type, chain };
      }
      referrer = token;
      current = target;
    }
  }
}
