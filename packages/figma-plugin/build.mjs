// Bundles the plugin into the two files Figma loads: dist/code.js for the main thread and
// dist/ui.html with the panel's script inlined. No source maps, nothing loaded at run time.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const common = {
  bundle: true,
  format: "iife",
  // Figma's main thread runs an older JavaScript engine, so modern syntax is lowered.
  target: "es2017",
  minify: false,
  legalComments: "none",
  write: false,
  logLevel: "warning",
};

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

const code = await build({ ...common, entryPoints: ["src/code.ts"] });
writeFileSync("dist/code.js", code.outputFiles[0].text);

const ui = await build({ ...common, entryPoints: ["src/ui.ts"], target: "es2020" });
// A literal "</script" inside the bundle would end the inline script early.
const script = ui.outputFiles[0].text.replaceAll("</script", "<\\/script");
const template = readFileSync("src/ui.html", "utf8");
if (!template.includes("<!-- script -->")) throw new Error("src/ui.html lost its script marker");
writeFileSync(
  "dist/ui.html",
  template.replace("<!-- script -->", () => `<script>\n${script}</script>`),
);

console.log("Built dist/code.js and dist/ui.html");
