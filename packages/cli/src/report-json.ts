import { type CheckReport, type Explanation, type PairResult, sortResults } from "./check.js";

export const JSON_SCHEMA_VERSION = 1;

export function formatJson(report: CheckReport): string {
  const count = (status: PairResult["status"]) =>
    report.results.filter((result) => result.status === status).length;
  const output = {
    schemaVersion: JSON_SCHEMA_VERSION,
    level: report.level,
    modes: report.modes,
    summary: {
      checked: report.results.length,
      passed: count("pass"),
      failed: count("fail"),
      exempt: count("exempt"),
      baselined: count("baselined"),
      errors: count("error"),
      warnings: report.warnings.length,
    },
    results: sortResults(report.results, report.modes),
    warnings: report.warnings,
  };
  return `${JSON.stringify(output, null, 2)}\n`;
}

export function formatExplainJson(explanations: readonly Explanation[]): string {
  return `${JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, explanations }, null, 2)}\n`;
}
