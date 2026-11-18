import type { SourceLocation } from "@pairlint/tokens-core";
import { type CheckReport, type PairResult, sortResults } from "./check.js";
import { pairName, ratioText, requirementText, suggestionText } from "./report-text.js";

export interface SarifOptions {
  version: string;
  /** Turns a token file path into a path relative to the repository root. */
  toUri: (file: string) => string;
}

const INFO_URI = "https://github.com/pairlint/pairlint";

interface Rule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri: string;
  defaultConfiguration: { level: "error" | "warning" };
  properties: { tags: string[] };
}

const rule = (
  id: string,
  name: string,
  short: string,
  full: string,
  level: "error" | "warning",
): Rule => ({
  id,
  name,
  shortDescription: { text: short },
  fullDescription: { text: full },
  helpUri: `${INFO_URI}#readme`,
  defaultConfiguration: { level },
  properties: { tags: ["accessibility", "wcag", "design-tokens"] },
});

export const SARIF_RULES = [
  rule(
    "body-text-contrast",
    "BodyTextContrast",
    "Body text does not have enough contrast",
    "Text smaller than 18pt (or 14pt bold) needs 4.5:1 for WCAG 1.4.3 AA, or 7:1 for 1.4.6 AAA.",
    "error",
  ),
  rule(
    "large-text-contrast",
    "LargeTextContrast",
    "Large text does not have enough contrast",
    "Text at least 18pt (or 14pt bold) needs 3:1 for WCAG 1.4.3 AA, or 4.5:1 for 1.4.6 AAA.",
    "error",
  ),
  rule(
    "ui-contrast",
    "UiContrast",
    "A UI component or graphic does not have enough contrast",
    "Borders, icons and other parts needed to understand a component need 3:1 for WCAG 1.4.11 AA.",
    "error",
  ),
  rule(
    "custom-contrast",
    "CustomContrast",
    "A pair is below its custom minimum ratio",
    "The pair has a custom minimum ratio set in pairlint.config.json.",
    "error",
  ),
  rule(
    "token-error",
    "TokenError",
    "A token could not be checked",
    "The token is missing, its alias cannot be resolved, or its value is not a color pairlint understands.",
    "error",
  ),
  rule(
    "token-warning",
    "TokenWarning",
    "A token result may be approximate or a token was skipped",
    "For example, a color outside the sRGB gamut, or a token name that cannot be referenced.",
    "warning",
  ),
];

const RULE_INDEX = new Map(SARIF_RULES.map((r, index) => [r.id, index]));

/** SARIF 2.1.0, for GitHub code scanning and other static analysis viewers. */
export function formatSarif(report: CheckReport, options: SarifOptions): string {
  const results: unknown[] = [];

  for (const result of sortResults(report.results, report.modes)) {
    if (result.status !== "fail" && result.status !== "error") continue;
    const ruleId = ruleFor(result);
    const entry: Record<string, unknown> = {
      ruleId,
      ruleIndex: RULE_INDEX.get(ruleId),
      level: "error",
      message: { text: messageFor(result) },
      partialFingerprints: {
        pairlintPair: `${result.mode}|${result.fg}|${result.bg}|${result.use}`,
      },
      properties: { mode: result.mode, fg: result.fg, bg: result.bg },
    };
    const primary = result.fgLocation ?? result.bgLocation;
    if (primary) entry.locations = [location(primary, options)];
    if (result.fgLocation && result.bgLocation) {
      entry.relatedLocations = [
        {
          id: 1,
          ...location(result.bgLocation, options),
          message: { text: `Background ${result.bg}` },
        },
      ];
    }
    results.push(entry);
  }

  for (const warning of report.warnings) {
    const entry: Record<string, unknown> = {
      ruleId: "token-warning",
      ruleIndex: RULE_INDEX.get("token-warning"),
      level: "warning",
      message: { text: `${warning.mode}: ${warning.message}` },
    };
    if (warning.location) entry.locations = [location(warning.location, options)];
    results.push(entry);
  }

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "pairlint",
            version: options.version,
            informationUri: INFO_URI,
            rules: SARIF_RULES,
          },
        },
        results,
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

function ruleFor(result: PairResult): string {
  if (result.status === "error") return "token-error";
  if (result.criterion === undefined) return "custom-contrast";
  if (result.use === "large") return "large-text-contrast";
  if (result.use === "ui") return "ui-contrast";
  return "body-text-contrast";
}

function messageFor(result: PairResult): string {
  const pair = `${pairName(result)} (${result.mode})`;
  if (result.status === "error") return `${pair}: ${result.message ?? "could not be checked"}`;
  const suggestion = result.suggestion ? ` Try: ${suggestionText(result.suggestion)}.` : "";
  const expired =
    result.baselineExpired && result.baseline
      ? ` Its baseline entry expired on ${result.baseline.expires}.`
      : "";
  return `${pair}: ${ratioText(result)}, needs ${requirementText(result)}.${suggestion}${expired}`;
}

function location(source: SourceLocation, options: SarifOptions) {
  return {
    physicalLocation: {
      artifactLocation: { uri: options.toUri(source.file) },
      region: { startLine: source.line, startColumn: source.column },
    },
  };
}
