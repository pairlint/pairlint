import { formatRatio } from "@pairlint/contrast";
import { type CheckReport, type PairResult, sortResults } from "./check.js";
import { formatLocation } from "./report-text.js";

export const MARKDOWN_ROW_LIMIT = 50;

const USE_SHORT = { body: "body text", large: "large text", ui: "UI" } as const;

/** A short report for pull request comments and GitHub job summaries. */
export function formatMarkdown(report: CheckReport): string {
  const results = sortResults(report.results, report.modes);
  const failures = results.filter((result) => result.status === "fail");
  const errors = results.filter((result) => result.status === "error");
  const passed = results.filter((result) => result.status === "pass").length;
  const exempt = results.filter((result) => result.status === "exempt").length;
  const baselined = results.filter((result) => result.status === "baselined").length;
  const lines: string[] = [];

  if (failures.length === 0 && errors.length === 0) {
    lines.push(`### pairlint: all ${passed} ${passed === 1 ? "pair passes" : "pairs pass"}`);
  } else {
    const parts = [];
    if (failures.length > 0) parts.push(plural(failures.length, "contrast failure"));
    if (errors.length > 0) parts.push(plural(errors.length, "token problem"));
    lines.push(`### pairlint: ${parts.join(" and ")}`);
  }
  lines.push("");

  const summary = [`${failures.length} failed`, `${passed} passed`];
  if (exempt > 0) summary.push(`${exempt} exempt`);
  if (baselined > 0) summary.push(`${baselined} baselined`);
  if (errors.length > 0) summary.push(`${errors.length} could not be checked`);
  const modes = report.modes.length;
  lines.push(
    `${summary.join(", ")} across ${modes} ${modes === 1 ? "mode" : "modes"} (WCAG ${report.level}).`,
  );

  if (failures.length > 0) {
    lines.push("");
    lines.push("| Mode | Foreground | Background | Contrast | Needs | Suggested fix | Where |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const result of failures.slice(0, MARKDOWN_ROW_LIMIT)) lines.push(failureRow(result));
    if (failures.length > MARKDOWN_ROW_LIMIT) {
      lines.push("");
      lines.push(
        `And ${failures.length - MARKDOWN_ROW_LIMIT} more. Run \`pairlint\` locally or open the HTML report for the full list.`,
      );
    }
  }

  if (errors.length > 0) {
    lines.push("");
    lines.push("#### Could not be checked");
    lines.push("");
    for (const result of errors.slice(0, MARKDOWN_ROW_LIMIT)) {
      const where = result.fgLocation ?? result.bgLocation;
      lines.push(
        `- ${result.mode}: ${code(result.fg)} on ${code(result.bg)}: ${escapeText(result.message ?? "unknown problem")}${
          where ? ` (${code(formatLocation(where))})` : ""
        }`,
      );
    }
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push(`<details><summary>${plural(report.warnings.length, "warning")}</summary>`);
    lines.push("");
    for (const warning of report.warnings) {
      lines.push(
        `- ${warning.mode}: ${escapeText(warning.message)}${
          warning.location ? ` (${code(formatLocation(warning.location))})` : ""
        }`,
      );
    }
    lines.push("");
    lines.push("</details>");
  }

  return `${lines.join("\n")}\n`;
}

function failureRow(result: PairResult): string {
  const needs =
    result.criterion === undefined
      ? `${result.required}:1 custom`
      : `${result.required}:1 ${USE_SHORT[result.use as keyof typeof USE_SHORT]}`;
  const suggestion = result.suggestion;
  const fix = suggestion
    ? `${code(suggestion.value)} (${formatRatio(suggestion.ratio)}:1)${
        suggestion.side === "bg" ? " on the background" : ""
      }`
    : "";
  const where = result.fgLocation ?? result.bgLocation;
  const expired =
    result.baselineExpired && result.baseline
      ? ` (baseline expired ${result.baseline.expires})`
      : "";
  return `| ${[
    escapeCell(result.mode),
    code(result.fg),
    code(result.bg),
    `${formatRatio(result.ratio ?? 0, result.required)}:1${expired}`,
    needs,
    fix,
    where ? code(formatLocation(where)) : "",
  ].join(" | ")} |`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
}

function escapeCell(text: string): string {
  return escapeText(text).replace(/\|/g, "\\|");
}

function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (char) => `\\${char}`);
}
