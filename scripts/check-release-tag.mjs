// Refuses to publish when the git tag and the package versions disagree.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const tag = process.argv[2] ?? "";
const expected = tag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error(`"${tag}" is not a release tag like v1.2.3`);
  process.exit(1);
}

let ok = true;
for (const name of readdirSync("packages")) {
  const manifest = JSON.parse(readFileSync(join("packages", name, "package.json"), "utf8"));
  if (manifest.version !== expected) {
    console.error(`${manifest.name} is at ${manifest.version}, but the tag is ${tag}`);
    ok = false;
  }
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@pairlint/") && range !== expected) {
      console.error(`${manifest.name} depends on ${dependency}@${range}, expected ${expected}`);
      ok = false;
    }
  }
}
// The GitHub Action runs this version from npm by default, so it has to move with the release.
const actionVersion = actionDefaultVersion(readFileSync("action.yml", "utf8"));
if (actionVersion !== expected) {
  console.error(
    `action.yml runs pairlint ${actionVersion ?? "(not found)"}, but the tag is ${tag}`,
  );
  ok = false;
}
if (!ok) process.exit(1);
console.log(`All packages and action.yml are at ${expected}.`);

/** The default of the "version" input in action.yml. */
export function actionDefaultVersion(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.indexOf("  version:");
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ")) return undefined;
    const match = /^ {4}default: "([^"]+)"$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}
