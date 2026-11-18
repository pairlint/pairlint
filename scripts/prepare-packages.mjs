// Copies LICENSE into every package and the root README into the CLI package before publishing.
// Relative links are rewritten to GitHub so they work on npmjs.com.
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "https://github.com/pairlint/pairlint/blob/main/";

for (const name of readdirSync("packages")) {
  copyFileSync("LICENSE", join("packages", name, "LICENSE"));
}

const readme = readFileSync("README.md", "utf8").replace(
  /\]\((?!https?:|#)([^)]+)\)/g,
  (_, path) => `](${REPO}${path})`,
);
writeFileSync(join("packages", "cli", "README.md"), readme);

console.log("Copied LICENSE to every package and README.md to packages/cli.");
