import { formatRatio } from "@pairlint/contrast";
import { type CheckReport, type PairResult, type Suggestion, sortResults } from "./check.js";
import { formatLocation, requirementText } from "./report-text.js";

export const HTML_ROW_LIMIT = 5000;

/**
 * The report's own colors. Every text and background pair here is checked by the test suite,
 * so the accessibility report itself meets WCAG AA.
 */
export const HTML_PALETTE = {
  light: {
    page: "#ffffff",
    text: "#1b1b1f",
    muted: "#5b5b66",
    border: "#8a8a96",
    failBg: "#fde8e7",
    failText: "#8c1d18",
    passBg: "#e3f4e8",
    passText: "#0d5a28",
    exemptBg: "#eeeef2",
    exemptText: "#43434d",
  },
  dark: {
    page: "#16161a",
    text: "#ececf1",
    muted: "#a6a6b3",
    border: "#6e6e7a",
    failBg: "#4a1714",
    failText: "#ffd9d5",
    passBg: "#103a20",
    passText: "#c6f0d2",
    exemptBg: "#2a2a31",
    exemptText: "#d0d0da",
  },
} as const;

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

export interface HtmlOptions {
  version: string;
}

/** A single self-contained page for designers: no scripts, no external files. */
export function formatHtml(report: CheckReport, options: HtmlOptions): string {
  const results = sortResults(report.results, report.modes);
  const count = (status: PairResult["status"]) =>
    results.filter((result) => result.status === status).length;
  const failed = count("fail");
  const errors = count("error");

  let rowsLeft = HTML_ROW_LIMIT;
  const sections = report.modes.map((mode) => {
    const inMode = results.filter(
      (result) =>
        result.status !== "exempt" && result.status !== "baselined" && result.mode === mode,
    );
    const exempt = results.filter((result) => result.status === "exempt" && result.mode === mode);
    const baselined = results.filter(
      (result) => result.status === "baselined" && result.mode === mode,
    );
    const problems = inMode.filter((result) => result.status !== "pass");
    const passes = inMode.filter((result) => result.status === "pass");
    const shownPasses = passes.slice(0, Math.max(0, rowsLeft - problems.length));
    rowsLeft -= problems.length + shownPasses.length;
    return modeSection(
      mode,
      problems,
      shownPasses,
      passes.length - shownPasses.length,
      exempt,
      baselined,
    );
  });

  const headline =
    failed + errors === 0
      ? `All ${count("pass")} pairs pass`
      : [
          failed > 0 ? plural(failed, "pair fails", "pairs fail") : "",
          errors > 0
            ? plural(errors, "pair could not be checked", "pairs could not be checked")
            : "",
        ]
          .filter(Boolean)
          .join(", ");

  const warnings =
    report.warnings.length === 0
      ? ""
      : `<section aria-labelledby="warnings"><h2 id="warnings">Warnings</h2><ul class="warnings">${report.warnings
          .map(
            (warning) =>
              `<li><strong>${escapeHtml(warning.mode)}:</strong> ${escapeHtml(warning.message)}${
                warning.location
                  ? ` <span class="where">${escapeHtml(formatLocation(warning.location))}</span>`
                  : ""
              }</li>`,
          )
          .join("")}</ul></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="pairlint ${escapeHtml(options.version)}">
<title>Contrast report</title>
<style>${styles()}</style>
</head>
<body>
<main>
<header>
<h1>Contrast report</h1>
<p class="headline">${escapeHtml(headline)}</p>
<p class="meta">${count("fail")} failed, ${count("pass")} passed, ${count("exempt")} exempt, ${count("baselined")} baselined, ${errors} could not be checked. WCAG ${report.level}, ${plural(report.modes.length, "mode", "modes")}.</p>
<p class="note">Passing means these token pairs meet WCAG 2.2 contrast ratios. It is not a full accessibility audit.</p>
</header>
${sections.join("\n")}
${warnings}
</main>
</body>
</html>
`;
}

function modeSection(
  mode: string,
  problems: PairResult[],
  passes: PairResult[],
  hiddenPasses: number,
  exempt: PairResult[],
  baselined: PairResult[],
): string {
  const id = `mode-${slug(mode)}`;
  const parts = [`<section aria-labelledby="${id}"><h2 id="${id}">${escapeHtml(mode)}</h2>`];
  if (
    problems.length === 0 &&
    passes.length === 0 &&
    exempt.length === 0 &&
    baselined.length === 0
  ) {
    parts.push(`<p class="muted">No pairs apply to this mode.</p>`);
  }
  if (problems.length > 0) parts.push(table(`Problems in ${mode}`, problems));
  else if (passes.length > 0) parts.push(`<p class="all-pass">Every pair in this mode passes.</p>`);
  if (passes.length > 0) {
    parts.push(
      `<details><summary>${plural(passes.length + hiddenPasses, "passing pair", "passing pairs")}</summary>${table(`Passing pairs in ${mode}`, passes)}${
        hiddenPasses > 0
          ? `<p class="muted">${hiddenPasses} more not shown. Use the JSON report for everything.</p>`
          : ""
      }</details>`,
    );
  }
  if (baselined.length > 0) {
    parts.push(
      `<details><summary>${plural(baselined.length, "baselined pair", "baselined pairs")}</summary>${table(`Baselined pairs in ${mode}`, baselined)}</details>`,
    );
  }
  if (exempt.length > 0) {
    parts.push(
      `<details><summary>${plural(exempt.length, "exempt pair", "exempt pairs")}</summary><ul class="exempt">${exempt
        .map(
          (result) =>
            `<li><code>${escapeHtml(result.fg)}</code> on <code>${escapeHtml(result.bg)}</code>: ${escapeHtml(result.reason ?? "no reason given")}</li>`,
        )
        .join("")}</ul></details>`,
    );
  }
  parts.push("</section>");
  return parts.join("\n");
}

function table(caption: string, rows: PairResult[]): string {
  return `<div class="scroll"><table><caption class="visually-hidden">${escapeHtml(caption)}</caption><thead><tr><th scope="col">Sample</th><th scope="col">Pair</th><th scope="col">Contrast</th><th scope="col">Result</th><th scope="col">Suggested fix</th></tr></thead><tbody>${rows
    .map(row)
    .join("")}</tbody></table></div>`;
}

function row(result: PairResult): string {
  const where = result.fgLocation ?? result.bgLocation;
  const pair = `<code>${escapeHtml(result.fg)}</code><br>on <code>${escapeHtml(result.bg)}</code>${
    where ? `<div class="where">${escapeHtml(formatLocation(where))}</div>` : ""
  }`;
  if (result.status === "error") {
    return `<tr><td></td><td>${pair}</td><td></td><td><span class="badge fail">Cannot check</span><div class="detail">${escapeHtml(result.message ?? "unknown problem")}</div></td><td></td></tr>`;
  }
  const status =
    result.status === "pass" ? "pass" : result.status === "baselined" ? "baselined" : "fail";
  const label = { pass: "Passes", fail: "Fails", baselined: "Baselined" }[status];
  let baseline = "";
  if (result.baseline) {
    const expires = result.baseline.expires ? escapeHtml(result.baseline.expires) : undefined;
    const when = result.baselineExpired
      ? `Baseline expired on ${expires}`
      : `Baselined${expires ? ` until ${expires}` : ""}`;
    baseline = `<div class="detail">${when}, owner ${escapeHtml(result.baseline.owner)}: ${escapeHtml(result.baseline.reason)}</div>`;
  }
  return `<tr><td>${sample(result.fgColor, result.bgColor)}</td><td>${pair}</td><td><span class="ratio">${escapeHtml(
    formatRatio(result.ratio ?? 0, result.required),
  )}:1</span><div class="detail">${escapeHtml(result.fgColor ?? "")} on ${escapeHtml(result.bgColor ?? "")}</div></td><td><span class="badge ${status}">${label}</span><div class="detail">needs ${escapeHtml(
    requirementText(result),
  )}</div>${baseline}</td><td>${result.suggestion ? suggestion(result, result.suggestion) : ""}</td></tr>`;
}

function suggestion(result: PairResult, fix: Suggestion): string {
  const color = fix.kind === "token" ? fix.color : fix.value;
  const preview = fix.side === "fg" ? sample(color, result.bgColor) : sample(result.fgColor, color);
  const extra = fix.kind === "color" ? `<div class="detail">${escapeHtml(fix.oklch)}</div>` : "";
  return `<div class="fix">${preview}<div><code>${escapeHtml(fix.value)}</code> for <code>${escapeHtml(fix.token)}</code><div class="detail">${escapeHtml(
    formatRatio(fix.ratio),
  )}:1</div>${extra}</div></div>`;
}

function sample(fg: string | undefined, bg: string | undefined): string {
  if (!fg || !bg || !HEX.test(fg) || !HEX.test(bg)) return "";
  return `<span class="sample" style="color:${fg};background:${bg}" aria-hidden="true">Aa</span>`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "mode"
  );
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function styles(): string {
  const vars = (palette: Record<string, string>) =>
    Object.entries(palette)
      .map(([name, value]) => `--${name}:${value};`)
      .join("");
  return [
    `:root{${vars(HTML_PALETTE.light)}color-scheme:light dark}`,
    `@media (prefers-color-scheme:dark){:root{${vars(HTML_PALETTE.dark)}}}`,
    "*{box-sizing:border-box}",
    "body{margin:0;background:var(--page);color:var(--text);font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}",
    "main{max-width:72rem;margin:0 auto;padding:2rem 1rem 4rem}",
    "h1{font-size:2rem;margin:0 0 .25rem}h2{font-size:1.375rem;margin:2.5rem 0 .75rem}",
    ".headline{font-size:1.25rem;font-weight:600;margin:0}.meta,.muted,.note,.where,.detail{color:var(--muted)}",
    ".note{font-size:.875rem}.where,.detail{font-size:.8125rem}",
    "code{font:.875em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
    ".scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:40rem}",
    "th,td{text-align:left;vertical-align:top;padding:.75rem .5rem;border-bottom:1px solid var(--border)}",
    "th{font-size:.875rem}",
    ".sample{display:inline-flex;align-items:center;justify-content:center;width:3.5rem;height:3.5rem;border-radius:.5rem;border:1px solid var(--border);font-size:1.5rem;font-weight:600}",
    ".fix{display:flex;gap:.75rem;align-items:flex-start}",
    ".ratio{font-size:1.125rem;font-weight:600;font-variant-numeric:tabular-nums}",
    ".badge{display:inline-block;padding:.125rem .5rem;border-radius:1rem;font-size:.875rem;font-weight:600}",
    ".badge.fail{background:var(--failBg);color:var(--failText)}.badge.pass{background:var(--passBg);color:var(--passText)}.badge.baselined{background:var(--exemptBg);color:var(--exemptText)}",
    ".all-pass{background:var(--passBg);color:var(--passText);padding:.75rem 1rem;border-radius:.5rem}",
    ".exempt li{background:var(--exemptBg);color:var(--exemptText);padding:.25rem .5rem;margin:.25rem 0;border-radius:.25rem;list-style:none}",
    "details{margin-top:1rem}summary{cursor:pointer;font-weight:600}",
    "summary:focus-visible,a:focus-visible{outline:3px solid var(--text);outline-offset:2px}",
    ".visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
  ].join("\n");
}
