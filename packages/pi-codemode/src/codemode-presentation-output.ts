import type { CodeModeJsonValue } from "./codemode-tool-contract.js";

function orderedCodeModePresentationValue(value: CodeModeJsonValue): CodeModeJsonValue {
  if (Array.isArray(value)) return value.map(orderedCodeModePresentationValue);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The parsed JSON union is discriminated into its object arm for deterministic presentation.
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, orderedCodeModePresentationValue(entryValue)]),
  );
}

/** Format returned JSON data deterministically for Transcript display and Result Spills. */
export function formatCodeModePresentationData(value: CodeModeJsonValue): string {
  return JSON.stringify(orderedCodeModePresentationValue(value), undefined, 2);
}
