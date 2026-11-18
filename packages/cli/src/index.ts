export {
  type CheckOptions,
  type CheckReport,
  exitCode,
  MAX_CHECKS,
  type PairResult,
  type PairStatus,
  runCheck,
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
export { formatJson, JSON_SCHEMA_VERSION } from "./report-json.js";
export { formatLocation, formatText, type TextOptions } from "./report-text.js";
export { ISSUES_URL, type RunContext, run } from "./run.js";
