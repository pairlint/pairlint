export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternError";
  }
}

export type TokenMatcher = (id: string) => boolean;

/**
 * Compiles a token id pattern. Segments are separated by ".".
 * "*" matches within one segment, "**" as a whole segment matches any number of segments.
 */
export function compileTokenPattern(pattern: string): TokenMatcher {
  if (pattern.trim() === "") throw new PatternError("A token pattern cannot be empty");
  if (pattern !== pattern.trim()) {
    throw new PatternError(`Token pattern "${pattern}" has spaces at the start or end`);
  }
  const segments = pattern.split(".");
  for (const segment of segments) {
    if (segment === "") throw new PatternError(`Token pattern "${pattern}" has an empty segment`);
    if (segment.includes("**") && segment !== "**") {
      throw new PatternError(
        `In token pattern "${pattern}", "**" must be a whole segment, like "color.**"`,
      );
    }
  }

  if (!pattern.includes("*")) return (id) => id === pattern;

  const matchers = segments.map(compileSegment);
  return (id) => matchSegments(matchers, id.split("."));
}

type SegmentMatcher = "**" | ((segment: string) => boolean);

function compileSegment(segment: string): SegmentMatcher {
  if (segment === "**") return "**";
  if (segment === "*") return () => true;
  if (!segment.includes("*")) return (value) => value === segment;
  const source = segment
    .split("*")
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, "\\$&"))
    .join("[^.]*");
  const regex = new RegExp(`^${source}$`);
  return (value) => regex.test(value);
}

function matchSegments(pattern: SegmentMatcher[], id: string[]): boolean {
  // failed[i * (id.length + 1) + j] records (i, j) states already known not to match.
  const failed = new Uint8Array((pattern.length + 1) * (id.length + 1));
  const visit = (i: number, j: number): boolean => {
    const key = i * (id.length + 1) + j;
    if (failed[key]) return false;
    let result: boolean;
    if (i === pattern.length) {
      result = j === id.length;
    } else {
      const matcher = pattern[i];
      if (matcher === "**") {
        result = false;
        for (let k = j; k <= id.length && !result; k++) result = visit(i + 1, k);
      } else {
        const segment = id[j];
        result = segment !== undefined && matcher?.(segment) === true && visit(i + 1, j + 1);
      }
    }
    if (!result) failed[key] = 1;
    return result;
  };
  return visit(0, 0);
}
