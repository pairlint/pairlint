export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export type TokenFormat = "dtcg" | "tokens-studio" | "style-dictionary" | "css";

export interface Token {
  /** Dot-separated path, for example "color.text.primary". */
  id: string;
  path: readonly string[];
  /** The token's own type, or the type inherited from its group (DTCG only). */
  type: string | undefined;
  value: unknown;
  description: string | undefined;
  extensions: Record<string, unknown> | undefined;
  source: SourceLocation;
  /**
   * Used when the token is an alias whose target does not exist, the way CSS uses the second
   * argument of var(). Only the CSS reader sets it.
   */
  fallback?: unknown;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  location?: SourceLocation;
}

export interface SourceFile {
  /** Path as it should appear in messages, relative to the project root. */
  path: string;
  text: string;
}

export class TokenFileError extends Error {
  readonly location: SourceLocation | undefined;

  constructor(message: string, location?: SourceLocation) {
    super(message);
    this.name = "TokenFileError";
    this.location = location;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
