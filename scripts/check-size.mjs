// Keeps the install small. Raise the budget only with a reason in the pull request.
import { execFileSync } from "node:child_process";

const BUDGET_BYTES = 250_000;
const args = ["pack", "--dry-run", "--json", "--workspaces"];

// `npm run` sets npm_execpath, which lets us call npm through node without a shell on every OS.
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("Run this through npm: npm run check:size");
  process.exit(1);
}
const output = execFileSync(process.execPath, [npmCli, ...args], { encoding: "utf8" });
const packages = JSON.parse(output);

// The Figma plugin is private: it ships to the Figma Community, not npm, so it is not counted.
let total = 0;
for (const pkg of packages.filter((p) => !p.name.startsWith("@pairlint/figma-plugin"))) {
  total += pkg.unpackedSize;
  console.log(
    `${pkg.name.padEnd(24)} ${String(pkg.unpackedSize).padStart(8)} bytes, ${pkg.entryCount} files`,
  );
}
console.log(`${"total".padEnd(24)} ${String(total).padStart(8)} bytes (budget ${BUDGET_BYTES})`);

if (total > BUDGET_BYTES) {
  console.error(`Install size ${total} bytes is over the ${BUDGET_BYTES} byte budget.`);
  process.exit(1);
}
