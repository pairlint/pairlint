import type { Explanation, SideDetail } from "./check.js";
import {
  formatLocation,
  type Painter,
  painter,
  ratioText,
  requirementText,
  suggestionText,
} from "./report-text.js";

export function formatExplainText(explanations: readonly Explanation[], color: boolean): string {
  const paint = painter(color);
  const blocks = explanations.map((explanation) => explainBlock(explanation, paint));
  return `${blocks.join("\n")}`;
}

function explainBlock(explanation: Explanation, paint: Painter): string {
  const { result } = explanation;
  const lines = [paint.bold(`${result.fg} on ${result.bg} (${explanation.mode})`)];

  switch (result.status) {
    case "pass":
      lines.push(`  ${paint.green("✓")} ${ratioText(result)}, needs ${requirementText(result)}`);
      break;
    case "fail":
      lines.push(`  ${paint.red("✗")} ${ratioText(result)}, needs ${requirementText(result)}`);
      break;
    case "exempt":
      lines.push(`  ${paint.dim(`– exempt: ${result.reason ?? "no reason given"}`)}`);
      break;
    case "error":
      lines.push(`  ${paint.red("✗")} Cannot check: ${result.message ?? "unknown problem"}`);
      break;
  }
  if (!explanation.inPairs) {
    lines.push(
      `  ${paint.yellow("!")} No pair in your config covers these tokens, so this used body text rules.`,
    );
  }

  lines.push(...sideLines("foreground", explanation.fg, paint));
  lines.push(...sideLines("background", explanation.bg, paint));
  if (explanation.base) lines.push(`  ${"base".padEnd(12)}${explanation.base}`);
  if (result.fgColor && result.bgColor) {
    lines.push(`  ${"blended".padEnd(12)}${result.fgColor} on ${result.bgColor}`);
  }
  if (result.suggestion) lines.push(`  ${paint.cyan("Try:")} ${suggestionText(result.suggestion)}`);
  return `${lines.join("\n")}\n`;
}

function sideLines(label: string, side: SideDetail, paint: Painter): string[] {
  const lines = [`  ${label.padEnd(12)}${side.chain.join(" → ")}`];
  const details: string[] = [];
  if (side.color) details.push(side.color);
  if (side.location) details.push(paint.dim(formatLocation(side.location)));
  if (details.length > 0) lines.push(`  ${"".padEnd(12)}${details.join("  ")}`);
  return lines;
}
