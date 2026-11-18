import { type Dirent, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { SourceFile } from "@pairlint/tokens-core";
import { MAX_FILE_BYTES, toDisplayPath } from "./files.js";

const MAX_SCAN_DEPTH = 6;
const MAX_FILES = 2000;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "storybook-static",
]);
const SKIP_FILES =
  /^(package(-lock)?|tsconfig.*|jsconfig|composer|bower|lerna|turbo|nx|vercel|renovate|biome|pairlint\..*|.*\.schema|.*\.min)\.(json|css)$/i;

/**
 * Finds token files below `root`: JSON files with tokens and CSS files with custom properties.
 * It skips hidden folders, dependencies and build output, does not follow symlinks, and reads at
 * most MAX_FILES files.
 */
export function findTokenFiles(root: string): SourceFile[] {
  const found: SourceFile[] = [];
  let seen = 0;
  const visit = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (seen >= MAX_FILES) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH && !SKIP_DIRS.has(entry.name)) visit(path, depth + 1);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!entry.isFile() || (ext !== ".json" && ext !== ".css") || SKIP_FILES.test(entry.name)) {
        continue;
      }
      seen++;
      if (lstatSync(path).size > MAX_FILE_BYTES) continue;
      found.push({ path: toDisplayPath(relative(root, path)), text: readFileSync(path, "utf8") });
    }
  };
  visit(root, 0);
  return found;
}
