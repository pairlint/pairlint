/** Escapes one JSON Pointer segment (RFC 6901). */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function toPointer(segments: readonly string[]): string {
  let pointer = "";
  for (const segment of segments) pointer += `/${escapePointerSegment(segment)}`;
  return pointer;
}
