import type { SourceLocation } from "@pairlint/tokens-core";
import { type CheckReport, type PairResult, sortResults } from "./check.js";
import { pairName, ratioText, requirementText, suggestionText } from "./report-text.js";

export interface GithubOptions {
  /** Turns a token file path into a path relative to the repository root. */
  toPath: (file: string) => string;
}

/**
 * GitHub Actions workflow commands. Each failure becomes an error annotation on the token's line,
 * which shows up in the pull request diff and the run summary without code scanning.
 */
export function formatGithub(report: CheckReport, options: GithubOptions): string {
  const results = sortResults(report.results, report.modes);
  const lines: string[] = [];
  let failed = 0;
  let errors = 0;

  for (const result of results) {
    if (result.status === "fail") {
      failed++;
      lines.push(command("error", failureTitle(result), failureMessage(result), result, options));
    } else if (result.status === "error") {
      errors++;
      const title = `Cannot check ${pairName(result)} (${result.mode})`;
      lines.push(command("error", title, result.message ?? "", result, options));
    }
  }
  for (const warning of report.warnings) {
    lines.push(
      workflowCommand(
        "warning",
        { title: `pairlint (${warning.mode})`, ...position(warning.location, options) },
        warning.message,
      ),
    );
  }

  const passed = results.filter((result) => result.status === "pass").length;
  const summary = [`${failed} failed`, `${passed} passed`];
  if (errors > 0) summary.push(`${errors} could not be checked`);
  const modes = report.modes.length;
  lines.push(
    `pairlint: ${summary.join(", ")} across ${modes} ${modes === 1 ? "mode" : "modes"} (WCAG ${report.level})`,
  );
  return `${lines.join("\n")}\n`;
}

function failureTitle(result: PairResult): string {
  return `Contrast: ${pairName(result)} (${result.mode})`;
}

function failureMessage(result: PairResult): string {
  const parts = [`${ratioText(result)}, needs ${requirementText(result)}.`];
  if (result.baselineExpired && result.baseline?.expires) {
    parts.push(`The baseline entry for this pair expired on ${result.baseline.expires}.`);
  }
  if (result.suggestion) parts.push(`Try: ${suggestionText(result.suggestion)}`);
  return parts.join("\n");
}

function command(
  kind: "error" | "warning",
  title: string,
  message: string,
  result: PairResult,
  options: GithubOptions,
): string {
  const location = result.fgLocation ?? result.bgLocation;
  return workflowCommand(kind, { title, ...position(location, options) }, message);
}

function position(
  location: SourceLocation | undefined,
  options: GithubOptions,
): Record<string, string> {
  if (!location) return {};
  return {
    file: options.toPath(location.file),
    line: String(location.line),
    col: String(location.column),
  };
}

function workflowCommand(
  kind: "error" | "warning",
  properties: Record<string, string>,
  message: string,
): string {
  const props = Object.entries(properties)
    .map(([key, value]) => `${key}=${escapeProperty(value)}`)
    .join(",");
  return `::${kind}${props ? ` ${props}` : ""}::${escapeData(message)}`;
}

/** Escaping from the GitHub Actions toolkit, so a token name cannot inject another command. */
export function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
