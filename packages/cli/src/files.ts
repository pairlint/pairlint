import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SourceFile } from "@pairlint/tokens-core";
import { InputError } from "./errors.js";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type ReadFile = (path: string) => SourceFile;

/**
 * Reads files inside `root` only. Paths that leave the root, directly or through a symlink,
 * are refused so a config cannot point pairlint at arbitrary files on the machine.
 */
export function createFileReader(root: string): ReadFile {
  const realRoot = realpathSync(root);
  return (path) => {
    const absolute = resolve(root, path);
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      throw new InputError(`Cannot find ${path} (looked for ${absolute})`);
    }
    if (!isInside(realRoot, real)) {
      throw new InputError(
        `${path} is outside the project folder (${realRoot}). pairlint only reads files inside the folder that holds its config.`,
      );
    }
    const stats = statSync(real);
    if (!stats.isFile()) throw new InputError(`${path} is not a file`);
    if (stats.size > MAX_FILE_BYTES) {
      throw new InputError(
        `${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, which is more than any token file should need`,
      );
    }
    return { path: toDisplayPath(relative(root, absolute)), text: readFileSync(real, "utf8") };
  };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function toDisplayPath(path: string): string {
  return path.split(sep).join("/");
}
