export {
  type CheckOptions,
  type CheckReport,
  type Explanation,
  exitCode,
  explainPair,
  MAX_CHECKS,
  type PairResult,
  type PairStatus,
  runCheck,
  type SideDetail,
  type Suggestion,
  sortResults,
  type Warning,
} from "./check.js";
export {
  CONFIG_FILE,
  type Config,
  DEFAULT_BASE,
  DEFAULT_MODE,
  type ModeConfig,
  type PairRule,
  type PairUse,
  parseConfig,
  type TokenSource,
} from "./config.js";
export { InputError } from "./errors.js";
export { createFileReader, MAX_FILE_BYTES, type ReadFile } from "./files.js";
export { formatExplainText } from "./report-explain.js";
export { formatHtml, HTML_PALETTE, HTML_ROW_LIMIT, type HtmlOptions } from "./report-html.js";
export { formatExplainJson, formatJson, JSON_SCHEMA_VERSION } from "./report-json.js";
export { formatMarkdown, MARKDOWN_ROW_LIMIT } from "./report-markdown.js";
export { formatSarif, SARIF_RULES, type SarifOptions } from "./report-sarif.js";
export { formatLocation, formatText, type TextOptions } from "./report-text.js";
export { ISSUES_URL, type RunContext, run } from "./run.js";
