import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { WcagLevel } from "@pairlint/contrast";
import { exitCode, explainPair, runCheck } from "./check.js";
import { CONFIG_FILE, parseConfig } from "./config.js";
import { InputError } from "./errors.js";
import { createFileReader, MAX_FILE_BYTES, toDisplayPath } from "./files.js";
import { formatExplainText } from "./report-explain.js";
import { formatHtml } from "./report-html.js";
import { formatExplainJson, formatJson } from "./report-json.js";
import { formatMarkdown } from "./report-markdown.js";
import { formatSarif } from "./report-sarif.js";
import { formatLocation, formatText } from "./report-text.js";

export interface RunContext {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
  version: string;
}

export const ISSUES_URL = "https://github.com/pairlint/pairlint/issues";

const HELP = `Usage
  pairlint [check] [options]       Check every pair in pairlint.config.json
  pairlint explain <fg> <bg>       Show how one pair's result was worked out

Options
  -c, --config <path>   Config file (default: ./${CONFIG_FILE})
  -f, --format <name>   text, json, sarif, markdown or html (default: text)
  -o, --output <path>   Write the report to a file instead of the terminal
  -l, --level <level>   AA or AAA, overrides the config
  -m, --mode <name>     Check only this mode. Repeat for more than one
      --verbose         List passing and exempt pairs too
      --color           Force colored output
      --no-color        Disable colored output
  -h, --help            Show this help
  -v, --version         Show the version

Exit codes
  0  every pair passes
  1  at least one pair fails
  2  the config or a token file has a problem
  3  pairlint itself hit a bug
`;

/** Runs the CLI and returns the exit code. Never calls process.exit. */
export function run(context: RunContext): number {
  try {
    return runOrThrow(context);
  } catch (error) {
    if (error instanceof InputError) {
      context.stderr(`pairlint: ${error.message}\n`);
      if (error.location) context.stderr(`  at ${formatLocation(error.location)}\n`);
      return 2;
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    context.stderr(
      `pairlint hit an unexpected error. Please report it at ${ISSUES_URL} with the details below.\n\n${detail}\n`,
    );
    return 3;
  }
}

function runOrThrow(context: RunContext): number {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(context.argv);
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      throw new InputError(
        `${(error as Error).message}\nRun "pairlint --help" to see the options.`,
      );
    }
    throw error;
  }
  const { values, positionals } = parsed;

  if (values.help) {
    context.stdout(HELP);
    return 0;
  }
  if (values.version) {
    context.stdout(`${context.version}\n`);
    return 0;
  }
  const command = positionals[0] ?? "check";
  if (command === "explain") {
    if (positionals.length !== 3) {
      throw new InputError(
        'explain needs a foreground and a background token, like "pairlint explain color.text.muted color.surface.base"',
      );
    }
  } else if (command !== "check" || positionals.length > 1) {
    throw new InputError(`Unknown command "${positionals.join(" ")}". Run "pairlint --help".`);
  }

  const format = normalizeFormat(values.format ?? "text");
  if (format === undefined) {
    throw new InputError(
      `Unknown format "${values.format}". Use ${FORMATS.map((name) => `"${name}"`).join(", ")}.`,
    );
  }
  if (command === "explain" && format !== "text" && format !== "json") {
    throw new InputError('explain supports "text" and "json" output only.');
  }
  const write = (text: string) => {
    if (values.output === undefined) {
      context.stdout(text);
      return;
    }
    const path = resolve(context.cwd, values.output);
    try {
      writeFileSync(path, text, "utf8");
    } catch (error) {
      throw new InputError(`Cannot write ${values.output}: ${(error as Error).message}`);
    }
  };
  let level: WcagLevel | undefined;
  if (values.level !== undefined) {
    const upper = values.level.toUpperCase();
    if (upper !== "AA" && upper !== "AAA") {
      throw new InputError(`Unknown level "${values.level}". Use "AA" or "AAA".`);
    }
    level = upper;
  }

  const configPath = resolve(context.cwd, values.config ?? CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new InputError(
      values.config
        ? `Cannot find the config file ${values.config}`
        : `No ${CONFIG_FILE} in ${context.cwd}. Create one (see the README) or pass --config.`,
    );
  }
  const configText = readFileSync(configPath, "utf8");
  if (configText.length > MAX_FILE_BYTES)
    throw new InputError(`${configPath} is too large to be a config file`);
  const config = parseConfig(configText, toDisplayPath(values.config ?? CONFIG_FILE));

  const modes = values.mode;
  if (modes) {
    const known = config.modes.map((mode) => mode.name);
    for (const mode of modes) {
      if (!known.includes(mode)) {
        throw new InputError(`Unknown mode "${mode}". The config defines: ${known.join(", ")}`);
      }
    }
  }

  const options = { ...(level ? { level } : {}), ...(modes ? { modes } : {}) };
  const readFile = createFileReader(dirname(configPath));

  if (command === "explain") {
    const [, fg, bg] = positionals as [string, string, string];
    const explanations = explainPair(config, readFile, fg, bg, options);
    write(
      format === "json"
        ? formatExplainJson(explanations)
        : formatExplainText(explanations, useColor(values, context) && values.output === undefined),
    );
    return exitCode({ results: explanations.map((explanation) => explanation.result) });
  }

  const report = runCheck(config, readFile, options);

  const configDir = dirname(configPath);
  const toUri = (file: string) => toDisplayPath(relative(context.cwd, resolve(configDir, file)));
  switch (format) {
    case "json":
      write(formatJson(report));
      break;
    case "sarif":
      write(formatSarif(report, { version: context.version, toUri }));
      break;
    case "markdown":
      write(formatMarkdown(report));
      break;
    case "html":
      write(formatHtml(report, { version: context.version }));
      break;
    case "text":
      write(
        formatText(report, {
          color: useColor(values, context) && values.output === undefined,
          verbose: values.verbose === true,
        }),
      );
      break;
  }
  return exitCode(report);
}

const FORMATS = ["text", "json", "sarif", "markdown", "html"] as const;
type Format = (typeof FORMATS)[number];

function normalizeFormat(name: string): Format | undefined {
  const lower = name.toLowerCase();
  if (lower === "md") return "markdown";
  return (FORMATS as readonly string[]).includes(lower) ? (lower as Format) : undefined;
}

function parseCliArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      config: { type: "string", short: "c" },
      format: { type: "string", short: "f" },
      output: { type: "string", short: "o" },
      level: { type: "string", short: "l" },
      mode: { type: "string", short: "m", multiple: true },
      verbose: { type: "boolean" },
      color: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

function useColor(values: { color?: boolean | undefined }, context: RunContext): boolean {
  if (values.color === false) return false;
  if (values.color === true) return true;
  if (context.env.NO_COLOR) return false;
  const force = context.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  return context.isTTY && context.env.TERM !== "dumb";
}
