import { formatRatio } from "@pairlint/contrast";
import type { SourceLocation } from "@pairlint/tokens-core";
import { type CheckReport, type PairResult, type Suggestion, sortResults } from "./check.js";

export interface TextOptions {
  color: boolean;
  verbose: boolean;
}

const USE_LABELS = {
  body: "body text",
  large: "large text",
  ui: "UI components and graphics",
} as const;

export function formatText(report: CheckReport, options: TextOptions): string {
  const paint = painter(options.color);
  const lines: string[] = [];
  const results = sortResults(report.results, report.modes);

  for (const mode of report.modes) {
    const inMode = results.filter((result) => result.mode === mode);
    lines.push(paint.bold(mode));
    if (inMode.length === 0) {
      lines.push(`  ${paint.dim("no pairs apply to this mode")}`);
      lines.push("");
      continue;
    }

    for (const result of inMode) {
      if (result.status === "fail" || result.status === "error") {
        lines.push(...problemLines(result, paint));
      } else if (options.verbose) {
        lines.push(...detailLines(result, paint));
      }
    }

    if (!options.verbose) {
      const passed = inMode.filter((result) => result.status === "pass").length;
      const exempt = inMode.filter((result) => result.status === "exempt").length;
      if (passed > 0) {
        lines.push(
          `  ${paint.green("✓")} ${passed} ${passed === 1 ? "pair passes" : "pairs pass"}`,
        );
      }
      if (exempt > 0) {
        lines.push(`  ${paint.dim(`– ${exempt} exempt`)}`);
      }
    }
    lines.push("");
  }

  if (report.warnings.length > 0) {
    lines.push(paint.bold("Warnings"));
    for (const warning of report.warnings) {
      lines.push(`  ${paint.yellow("!")} ${warning.mode}: ${warning.message}`);
      if (warning.location) lines.push(`    ${paint.dim(formatLocation(warning.location))}`);
    }
    lines.push("");
  }

  lines.push(summary(report, paint));
  return `${lines.join("\n")}\n`;
}

function problemLines(result: PairResult, paint: Painter): string[] {
  const lines = [`  ${paint.red("✗")} ${pairName(result)}`];
  if (result.status === "error") {
    lines.push(`    Cannot check: ${result.message ?? "unknown problem"}`);
  } else {
    lines.push(`    ${ratioText(result)}, needs ${requirementText(result)}`);
    if (result.suggestion)
      lines.push(`    ${paint.cyan("Try:")} ${suggestionText(result.suggestion)}`);
  }
  const location = result.fgLocation ?? result.bgLocation;
  if (location) lines.push(`    ${paint.dim(formatLocation(location))}`);
  return lines;
}

function detailLines(result: PairResult, paint: Painter): string[] {
  if (result.status === "exempt") {
    return [
      `  ${paint.dim(`– ${pairName(result)} (exempt: ${result.reason ?? "no reason given"})`)}`,
    ];
  }
  return [`  ${paint.green("✓")} ${pairName(result)}  ${paint.dim(ratioText(result))}`];
}

export function pairName(result: PairResult): string {
  return `${result.fg} on ${result.bg}`;
}

export function ratioText(result: PairResult): string {
  const ratio = formatRatio(result.ratio ?? 0, result.required);
  return `${ratio}:1 (${result.fgColor} on ${result.bgColor})`;
}

export function suggestionText(suggestion: Suggestion): string {
  const ratio = `${formatRatio(suggestion.ratio)}:1`;
  if (suggestion.kind === "token") {
    return `point ${suggestion.token} at ${suggestion.value} (${ratio})`;
  }
  return `set ${suggestion.token} to ${suggestion.value}, or ${suggestion.oklch} (${ratio})`;
}

export function requirementText(result: PairResult): string {
  const required = `${result.required}:1`;
  if (result.criterion === undefined) return `${required} (custom minimum)`;
  const label = USE_LABELS[result.use as keyof typeof USE_LABELS];
  return `${required} for ${label} (WCAG ${result.criterion} ${result.criterionLevel})`;
}

export function formatLocation(location: SourceLocation): string {
  return `${location.file}:${location.line}:${location.column}`;
}

function summary(report: CheckReport, paint: Painter): string {
  const count = (status: PairResult["status"]) =>
    report.results.filter((result) => result.status === status).length;
  const failed = count("fail");
  const errors = count("error");
  const parts: string[] = [];
  if (errors > 0) parts.push(paint.red(`${errors} could not be checked`));
  parts.push(failed > 0 ? paint.red(`${failed} failed`) : `${failed} failed`);
  parts.push(`${count("pass")} passed`);
  const exempt = count("exempt");
  if (exempt > 0) parts.push(`${exempt} exempt`);
  const modes = report.modes.length;
  return `${parts.join(", ")} across ${modes} ${modes === 1 ? "mode" : "modes"} (WCAG ${report.level})`;
}

export interface Painter {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

export function painter(enabled: boolean): Painter {
  const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}
