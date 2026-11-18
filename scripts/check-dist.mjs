// Fails the build if published code could reach the network, run other programs or evaluate
// strings as code, or if any package declares install scripts. These are promises in SECURITY.md.
// The Figma plugin's bundle, including the script inlined in its panel, is checked the same way.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  [
    /\bfrom\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process|cluster|worker_threads|vm|inspector)["']/,
    "imports a network, process or VM module",
  ],
  [/\bfetch\s*\(/, "calls fetch()"],
  [/\bXMLHttpRequest\b|\bWebSocket\b/, "uses a network API"],
  [/\beval\s*\(/, "calls eval()"],
  [/\bnew\s+Function\s*\(/, "builds a function from a string"],
  [/\brequire\s*\(/, "calls require()"],
  [/\bimport\s*\(/, "uses dynamic import()"],
];

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];

const problems = [];

for (const name of readdirSync("packages")) {
  const dir = join("packages", name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const script of INSTALL_SCRIPTS) {
    if (manifest.scripts?.[script])
      problems.push(`${dir}/package.json declares a "${script}" script`);
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (!dependency.startsWith("@pairlint/")) {
      problems.push(`${dir}/package.json has a third-party runtime dependency: ${dependency}`);
    }
  }

  const dist = join(dir, "dist");
  let files;
  try {
    files = walk(dist).filter((file) => file.endsWith(".js") || file.endsWith(".html"));
  } catch {
    problems.push(`${dist} is missing. Run npm run build first.`);
    continue;
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [pattern, description] of FORBIDDEN) {
      if (pattern.test(source)) problems.push(`${file} ${description}`);
    }
  }
}

if (problems.length > 0) {
  console.error(
    `check-dist found ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  "check-dist: published code has no network, process or eval access, and no install scripts.",
);

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
