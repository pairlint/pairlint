// The plugin panel. It turns the variables into DTCG, runs the same check as the command line, and
// lets you edit the pairs, check again and save both files. Nothing leaves the panel.
import { checkExport } from "./check.js";
import { exportSnapshot, type FigmaExport, TOKENS_FILE } from "./export.js";
import type { Snapshot } from "./snapshot.js";
import { escapeHtml, renderReport } from "./view.js";

const CONFIG_FILE = "pairlint.config.json";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const results = $<HTMLElement>("results");
const config = $<HTMLTextAreaElement>("config");
const status = $<HTMLElement>("status");
let current: FigmaExport | undefined;

window.onmessage = (event: MessageEvent) => {
  const message = (event.data as { pluginMessage?: unknown } | null)?.pluginMessage as
    | { type: "snapshot"; snapshot: Snapshot }
    | { type: "error"; message: string }
    | undefined;
  if (!message) return;
  if (message.type === "error") {
    results.innerHTML = `<p class="headline bad">${escapeHtml(message.message)}</p>`;
    return;
  }
  current = exportSnapshot(message.snapshot);
  config.value = current.config;
  status.textContent =
    current.colorCount === 0
      ? "This file has no color variables."
      : `${current.colorCount} color variables from "${message.snapshot.fileName}"`;
  for (const warning of current.warnings.slice(0, 20)) {
    status.textContent += `\n${warning}`;
  }
  check();
};

function check(): void {
  if (!current || current.colorCount === 0) {
    results.innerHTML = "";
    return;
  }
  const outcome = checkExport(current.tokens, config.value);
  results.innerHTML = outcome.ok
    ? renderReport(outcome.report)
    : `<p class="headline bad">${escapeHtml(
        outcome.line ? `Config line ${outcome.line}: ${outcome.error}` : outcome.error,
      )}</p>`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Figma panels cannot use the async clipboard API, so this copies through a hidden field. */
function copy(text: string, label: string): void {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  parent.postMessage(
    { pluginMessage: { type: "notify", text: copied ? `Copied ${label}` : "Could not copy" } },
    "*",
  );
}

$("check").onclick = check;
$("refresh").onclick = () => parent.postMessage({ pluginMessage: { type: "refresh" } }, "*");
$("save-tokens").onclick = () => current && download(TOKENS_FILE, current.tokens);
$("save-config").onclick = () => download(CONFIG_FILE, config.value);
$("copy-tokens").onclick = () => current && copy(current.tokens, TOKENS_FILE);
$("copy-config").onclick = () => copy(config.value, CONFIG_FILE);
