// The plugin's main thread. It only reads color variables and hands them to the panel. It never
// changes the file, and the manifest blocks all network access.
import { readSnapshot, type VariablesApi } from "./snapshot.js";

figma.showUI(__html__, { width: 440, height: 640, themeColors: true, title: "pairlint" });

const api: VariablesApi = {
  rootName: figma.root.name,
  documentColorProfile: figma.root.documentColorProfile,
  getLocalVariableCollectionsAsync: () => figma.variables.getLocalVariableCollectionsAsync(),
  getLocalVariablesAsync: (type) => figma.variables.getLocalVariablesAsync(type),
  getVariableByIdAsync: (id) => figma.variables.getVariableByIdAsync(id),
  getVariableCollectionByIdAsync: (id) => figma.variables.getVariableCollectionByIdAsync(id),
};

async function sendSnapshot(): Promise<void> {
  try {
    figma.ui.postMessage({ type: "snapshot", snapshot: await readSnapshot(api) });
  } catch (error) {
    figma.ui.postMessage({ type: "error", message: (error as Error).message });
  }
}

figma.ui.onmessage = (message: unknown) => {
  const type = (message as { type?: unknown } | null)?.type;
  if (type === "refresh") void sendSnapshot();
  if (type === "notify") {
    const text = (message as { text?: unknown }).text;
    if (typeof text === "string") figma.notify(text.slice(0, 200));
  }
};

void sendSnapshot();
