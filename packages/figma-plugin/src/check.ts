import { type CheckReport, runCheck } from "../../cli/src/check.js";
import { parseConfig } from "../../cli/src/config.js";
import { InputError } from "../../cli/src/errors.js";
import { TOKENS_FILE } from "./export.js";

export type PluginCheck =
  | { ok: true; report: CheckReport }
  | { ok: false; error: string; line?: number };

/**
 * Runs the same check the command line runs, on the exported tokens and an edited config. Only
 * the exported file can be read, so a config cannot point the plugin at anything else.
 */
export function checkExport(tokens: string, configText: string): PluginCheck {
  try {
    const config = parseConfig(configText, "pairlint.config.json");
    const report = runCheck(config, (path) => {
      if (path !== TOKENS_FILE) {
        throw new InputError(`The plugin can only read ${TOKENS_FILE}, not ${path}`);
      }
      return { path, text: tokens };
    });
    return { ok: true, report };
  } catch (error) {
    if (error instanceof InputError) {
      return error.location
        ? { ok: false, error: error.message, line: error.location.line }
        : { ok: false, error: error.message };
    }
    throw error;
  }
}
