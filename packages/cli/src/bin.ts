#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "./run.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

process.exitCode = run({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: process.stdout.isTTY === true,
  version: manifest.version,
});
