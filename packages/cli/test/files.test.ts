import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileReader, InputError } from "../src/index.js";

const sandbox = mkdtempSync(join(tmpdir(), "pairlint-files-"));
const root = join(sandbox, "project");
mkdirSync(join(root, "tokens"), { recursive: true });
writeFileSync(join(root, "tokens", "light.json"), "{}");
writeFileSync(join(sandbox, "secret.json"), "{}");

// Creating symlinks needs extra rights on some Windows setups, so that test runs only where it can.
let symlinked = false;
try {
  symlinkSync(join(sandbox, "secret.json"), join(root, "link.json"));
  symlinked = true;
} catch {
  symlinked = false;
}

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("createFileReader", () => {
  it("reads files inside the root and reports forward-slash paths", () => {
    expect(createFileReader(root)("tokens/light.json")).toEqual({
      path: "tokens/light.json",
      text: "{}",
    });
  });

  it("refuses paths that leave the root", () => {
    const read = createFileReader(root);
    expect(() => read("../secret.json")).toThrow(InputError);
    expect(() => read("../secret.json")).toThrow(/outside the project folder/);
    expect(() => read(join(sandbox, "secret.json"))).toThrow(/outside the project folder/);
  });

  it("explains missing files and refuses folders", () => {
    const read = createFileReader(root);
    expect(() => read("tokens/dark.json")).toThrow(/Cannot find tokens\/dark\.json/);
    expect(() => read("tokens")).toThrow(/is not a file/);
  });

  it.runIf(symlinked)("refuses symlinks that point outside the root", () => {
    expect(() => createFileReader(root)("link.json")).toThrow(/outside the project folder/);
  });
});
