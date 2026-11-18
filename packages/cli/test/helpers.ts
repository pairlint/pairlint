import { fileURLToPath } from "node:url";
import { run } from "../src/index.js";

export const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** A fixed "today" so baseline expiry tests do not depend on the real date. */
export const TEST_NOW = new Date("2026-06-01T12:00:00Z");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(
  argv: string[],
  options: { cwd: string; env?: Record<string, string>; isTTY?: boolean; now?: Date },
): CliResult {
  let stdout = "";
  let stderr = "";
  const code = run({
    argv,
    cwd: options.cwd,
    env: options.env ?? {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    isTTY: options.isTTY ?? false,
    version: "0.0.0-test",
    now: options.now ?? TEST_NOW,
  });
  return { code, stdout, stderr };
}
