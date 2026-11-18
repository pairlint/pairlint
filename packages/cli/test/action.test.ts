import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const action = read("../../../action.yml");
const pkg = JSON.parse(read("../package.json"));
const readme = read("../../../README.md");

describe("action.yml", () => {
  it("runs the same pairlint version the package is at", () => {
    expect(action).toMatch(new RegExp(`version:\\n(?: {4}.*\\n)*? {4}default: "${pkg.version}"`));
  });

  it("passes inputs to the shell only through environment variables", () => {
    const lines = action.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes("${{ inputs.")) continue;
      const allowed =
        /^ {8}INPUT_[A-Z_]+: \$\{\{ inputs\.[a-z-]+ \}\}$/.test(line) ||
        /^ {6}working-directory: \$\{\{ inputs\.working-directory \}\}$/.test(line);
      expect({ line: index + 1, text: line, allowed }).toMatchObject({ allowed: true });
    }
  });

  it("never expands expressions inside the script", () => {
    const script = action.split("      run: |\n")[1] ?? "";
    expect(script).not.toContain("${{");
  });

  it("turns off bash -e, since GitHub runs the script with it and pairlint exits 1 on failures", () => {
    const script = action.split("      run: |\n")[1] ?? "";
    const firstCommand = script
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("#"));
    expect(firstCommand).toBe("set +e -uo pipefail");
  });

  it("documents every input in the README", () => {
    const block = action.slice(action.indexOf("\ninputs:\n"), action.indexOf("\noutputs:\n"));
    const inputs = [...block.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]);
    expect(inputs.length).toBeGreaterThan(5);
    for (const name of inputs) expect(readme).toContain(`\`${name}\``);
  });
});
