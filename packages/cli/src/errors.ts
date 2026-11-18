import type { SourceLocation } from "@pairlint/tokens-core";

/** A problem with the user's config or token files. Exit code 2. */
export class InputError extends Error {
  readonly location: SourceLocation | undefined;

  constructor(message: string, location?: SourceLocation) {
    super(message);
    this.name = "InputError";
    this.location = location;
  }
}
