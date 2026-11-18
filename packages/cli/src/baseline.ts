import {
  isPlainObject,
  JsonParseError,
  type Position,
  parseJson,
  type SourceLocation,
  toPointer,
} from "@pairlint/tokens-core";
import type { CheckReport, PairResult, Warning } from "./check.js";
import type { PairUse } from "./config.js";
import { InputError } from "./errors.js";
import { closest } from "./suggest.js";

export const BASELINE_VERSION = 1;

export interface BaselineEntry {
  mode: string;
  fg: string;
  bg: string;
  use: PairUse;
  /** Why this failure is accepted for now. Required. */
  reason: string;
  /** Who is responsible for fixing it, for example "@design-systems". Required. */
  owner: string;
  /** YYYY-MM-DD. From the day after, the pair fails again until it is fixed or re-justified. */
  expires?: string;
  location?: SourceLocation;
}

export interface Baseline {
  file: string;
  entries: BaselineEntry[];
}

const ENTRY_KEYS = ["mode", "fg", "bg", "use", "reason", "owner", "expires"];
const USES: readonly PairUse[] = ["body", "large", "ui"];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function entryKey(entry: { mode: string; fg: string; bg: string; use: string }): string {
  return `${entry.mode}\u0000${entry.fg}\u0000${entry.bg}\u0000${entry.use}`;
}

/** Today's date as YYYY-MM-DD in UTC, so results do not depend on the machine's time zone. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isValidDate(text: string): boolean {
  const match = DATE.exec(text);
  if (!match) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && isoDate(date) === text;
}

export function parseBaseline(text: string, file: string): Baseline {
  let parsed: ReturnType<typeof parseJson>;
  try {
    parsed = parseJson(text, { jsonc: true });
  } catch (error) {
    if (error instanceof JsonParseError) {
      throw new InputError(`${file} is not valid JSON: ${error.reason}`, {
        file,
        line: error.line,
        column: error.column,
      });
    }
    throw error;
  }
  const { value, positions } = parsed;
  const locate = (path: string[]): SourceLocation => {
    const position: Position = positions.get(toPointer(path)) ?? { line: 1, column: 1 };
    return { file, ...position };
  };
  const fail = (path: string[], message: string): never => {
    throw new InputError(message, locate(path));
  };

  if (!isPlainObject(value)) fail([], `${file} must be a JSON object`);
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!["$schema", "version", "entries"].includes(key)) {
      const hint = closest(key, ["version", "entries"]);
      fail([key], `Unknown setting "${key}"${hint ? `. Did you mean "${hint}"?` : ""}`);
    }
  }
  if (root.version !== BASELINE_VERSION) {
    fail(["version"], `"version" must be ${BASELINE_VERSION}`);
  }
  if (!Array.isArray(root.entries)) fail(["entries"], '"entries" must be a list');
  const list = root.entries as unknown[];

  const seen = new Set<string>();
  const entries = list.map((raw, index) => {
    const path = ["entries", String(index)];
    if (!isPlainObject(raw)) fail(path, "Each baseline entry must be an object");
    const item = raw as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!ENTRY_KEYS.includes(key)) {
        const hint = closest(key, ENTRY_KEYS);
        fail([...path, key], `Unknown setting "${key}"${hint ? `. Did you mean "${hint}"?` : ""}`);
      }
    }
    const text = (key: string, explanation: string): string => {
      const field = item[key];
      if (typeof field !== "string" || field.trim() === "") {
        fail(item[key] === undefined ? path : [...path, key], explanation);
      }
      return field as string;
    };
    const entry: BaselineEntry = {
      mode: text("mode", 'Each baseline entry needs a "mode"'),
      fg: text("fg", 'Each baseline entry needs "fg"'),
      bg: text("bg", 'Each baseline entry needs "bg"'),
      use: text("use", 'Each baseline entry needs "use"') as PairUse,
      reason: text("reason", 'Baseline entries need a "reason", so the next person knows why'),
      owner: text("owner", 'Baseline entries need an "owner" who will fix the pair'),
      location: locate(path),
    };
    if (!USES.includes(entry.use)) {
      fail([...path, "use"], `"use" must be ${USES.map((u) => `"${u}"`).join(", ")}`);
    }
    if (item.expires !== undefined) {
      if (typeof item.expires !== "string" || !isValidDate(item.expires)) {
        fail([...path, "expires"], '"expires" must be a date like "2027-03-31"');
      }
      entry.expires = item.expires as string;
    }
    const key = entryKey(entry);
    if (seen.has(key)) fail(path, `${entry.fg} on ${entry.bg} (${entry.mode}) is listed twice`);
    seen.add(key);
    return entry;
  });

  return { file, entries };
}

/**
 * Marks failures covered by a current baseline entry as "baselined", turns expired entries back
 * into failures with an explanation, and warns about entries that no longer match a failure.
 */
export function applyBaseline(report: CheckReport, baseline: Baseline, today: string): void {
  const byKey = new Map(baseline.entries.map((entry) => [entryKey(entry), entry]));
  const used = new Set<string>();
  const checkedModes = new Set(report.modes);
  const checked = new Set(report.results.map(entryKey));

  for (const result of report.results) {
    const key = entryKey(result);
    const entry = byKey.get(key);
    if (!entry) continue;
    used.add(key);
    if (result.status !== "fail") continue;
    result.baseline = baselineInfo(entry);
    if (entry.expires !== undefined && entry.expires < today) {
      result.baselineExpired = true;
      continue;
    }
    result.status = "baselined";
  }

  for (const entry of baseline.entries) {
    const key = entryKey(entry);
    if (!checkedModes.has(entry.mode)) continue;
    let message: string | undefined;
    if (!checked.has(key)) {
      message = `Baseline entry ${entry.fg} on ${entry.bg} (${entry.use}) is no longer checked. Run "pairlint baseline" to remove it.`;
    } else if (used.has(key)) {
      const result = report.results.find((r) => entryKey(r) === key);
      if (result && result.status === "pass") {
        message = `Baseline entry ${entry.fg} on ${entry.bg} (${entry.use}) passes now. Run "pairlint baseline" to remove it.`;
      }
    }
    if (message) {
      const warning: Warning = { mode: entry.mode, message };
      if (entry.location) warning.location = entry.location;
      report.warnings.push(warning);
    }
  }
}

function baselineInfo(entry: BaselineEntry): NonNullable<PairResult["baseline"]> {
  const info: NonNullable<PairResult["baseline"]> = { reason: entry.reason, owner: entry.owner };
  if (entry.expires !== undefined) info.expires = entry.expires;
  return info;
}

export interface BaselineUpdate {
  entries: BaselineEntry[];
  added: number;
  kept: number;
  removed: number;
  expired: number;
}

/**
 * Rebuilds the baseline from a full check: keeps entries that still fail (with their reasons),
 * adds new failures with the given reason and owner, and drops everything else.
 */
export function updateBaseline(
  report: CheckReport,
  previous: Baseline | undefined,
  defaults: { reason: string; owner: string; expires?: string },
  today: string,
): BaselineUpdate {
  const old = new Map((previous?.entries ?? []).map((entry) => [entryKey(entry), entry]));
  const checkedModes = new Set(report.modes);
  const entries: BaselineEntry[] = [];
  let added = 0;
  let kept = 0;
  let expired = 0;
  const keptKeys = new Set<string>();

  for (const result of report.results) {
    const failing =
      result.status === "fail" || result.status === "baselined" || result.baselineExpired === true;
    if (!failing || result.use === "exempt") continue;
    const key = entryKey(result);
    if (keptKeys.has(key)) continue;
    keptKeys.add(key);
    const existing = old.get(key);
    if (existing) {
      const { location: _location, ...rest } = existing;
      entries.push(rest);
      kept++;
      if (existing.expires !== undefined && existing.expires < today) expired++;
    } else {
      const entry: BaselineEntry = {
        mode: result.mode,
        fg: result.fg,
        bg: result.bg,
        use: result.use,
        reason: defaults.reason,
        owner: defaults.owner,
      };
      if (defaults.expires !== undefined) entry.expires = defaults.expires;
      entries.push(entry);
      added++;
    }
  }

  // Entries for modes this run did not check are kept as they are.
  for (const entry of previous?.entries ?? []) {
    if (checkedModes.has(entry.mode)) continue;
    const { location: _location, ...rest } = entry;
    entries.push(rest);
    kept++;
  }

  const removed = (previous?.entries.length ?? 0) - kept;
  entries.sort((a, b) => compare(entryKey(a), entryKey(b)));
  return { entries, added, kept, removed, expired };
}

export function serializeBaseline(entries: readonly BaselineEntry[]): string {
  const clean = entries.map(({ location: _location, ...entry }) => {
    const ordered: Record<string, string> = {
      mode: entry.mode,
      fg: entry.fg,
      bg: entry.bg,
      use: entry.use,
      reason: entry.reason,
      owner: entry.owner,
    };
    if (entry.expires !== undefined) ordered.expires = entry.expires;
    return ordered;
  });
  return `${JSON.stringify({ version: BASELINE_VERSION, entries: clean }, null, 2)}\n`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
