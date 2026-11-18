import { type CheckReport, type PairResult, sortResults } from "../../cli/src/check.js";
import { pairName, ratioText, requirementText, suggestionText } from "../../cli/src/report-text.js";

/** Rows shown before the list says how many more there are. */
export const VIEW_ROW_LIMIT = 200;

/** The results panel as an HTML string. Every value from the file is escaped. */
export function renderReport(report: CheckReport): string {
  const results = sortResults(report.results, report.modes);
  const failed = results.filter((r) => r.status === "fail");
  const errors = results.filter((r) => r.status === "error");
  const passed = results.filter((r) => r.status === "pass").length;
  const exempt = results.filter((r) => r.status === "exempt").length;

  const counts = [`${failed.length} failed`, `${passed} passed`];
  if (exempt > 0) counts.push(`${exempt} exempt`);
  if (errors.length > 0) counts.push(`${errors.length} could not be checked`);
  const modes = report.modes.length;
  const headline =
    failed.length === 0 && errors.length === 0
      ? `All ${passed} ${passed === 1 ? "pair passes" : "pairs pass"}`
      : `${failed.length + errors.length} ${failed.length + errors.length === 1 ? "problem" : "problems"}`;

  const parts = [
    `<p class="headline ${failed.length + errors.length === 0 ? "ok" : "bad"}">${escapeHtml(headline)}</p>`,
    `<p class="meta">${escapeHtml(`${counts.join(", ")} across ${modes} ${modes === 1 ? "mode" : "modes"} (WCAG ${report.level})`)}</p>`,
  ];

  const problems = [...errors, ...failed];
  for (const mode of report.modes) {
    const rows = problems.filter((r) => r.mode === mode);
    if (rows.length === 0) continue;
    parts.push(`<h2>${escapeHtml(mode)}</h2>`, '<ul class="results">');
    for (const result of rows.slice(0, VIEW_ROW_LIMIT)) parts.push(row(result));
    if (rows.length > VIEW_ROW_LIMIT) {
      parts.push(`<li class="more">And ${rows.length - VIEW_ROW_LIMIT} more in this mode.</li>`);
    }
    parts.push("</ul>");
  }
  for (const warning of report.warnings) {
    parts.push(`<p class="warning">${escapeHtml(`${warning.mode}: ${warning.message}`)}</p>`);
  }
  return parts.join("\n");
}

function row(result: PairResult): string {
  const name = `<span class="pair">${escapeHtml(pairName(result))}</span>`;
  if (result.status === "error") {
    return `<li class="error">${name}<span class="detail">${escapeHtml(result.message ?? "")}</span></li>`;
  }
  const sample = `<span class="sample" style="background:${safeColor(result.bgColor)};color:${safeColor(result.fgColor)}" aria-hidden="true">Aa</span>`;
  const detail = `${ratioText(result)}, needs ${requirementText(result)}`;
  const fix = result.suggestion
    ? `<span class="fix">Try: ${escapeHtml(suggestionText(result.suggestion))}</span>`
    : "";
  return `<li class="fail">${sample}<span class="text">${name}<span class="detail">${escapeHtml(detail)}</span>${fix}</span></li>`;
}

/** Only #rrggbb from pairlint's own output reaches a style attribute. */
function safeColor(value: string | undefined): string {
  return value !== undefined && /^#[0-9a-f]{6}$/i.test(value) ? value : "transparent";
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
