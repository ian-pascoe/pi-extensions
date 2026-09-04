import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool, redactWebSearchApiKey } from "./web-search.js";

/** Environment values read once while composing the Web Tools extension. */
export type PiWebToolsEnvironment = {
  readonly EXA_API_KEY?: string | undefined;
  readonly PARALLEL_API_KEY?: string | undefined;
};

/** Testable composition inputs for Web Search and Web Fetch transport. */
export type PiWebToolsExtensionOptions = {
  readonly environment?: PiWebToolsEnvironment | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly exaUrl?: string | undefined;
  readonly parallelUrl?: string | undefined;
};

/** Compose the Web Search and Web Fetch definitions with one environment snapshot. */
export function createPiWebToolsExtension(
  options: PiWebToolsExtensionOptions = {},
): ExtensionFactory {
  const environment = options.environment ?? process.env;
  const exaApiKey = environment.EXA_API_KEY;
  const parallelApiKey = environment.PARALLEL_API_KEY;
  const search = createWebSearchTool({
    fetch: options.fetch,
    exaUrl: options.exaUrl,
    parallelUrl: options.parallelUrl,
    exaApiKey: exaApiKey ? redactWebSearchApiKey(exaApiKey) : undefined,
    parallelApiKey: parallelApiKey ? redactWebSearchApiKey(parallelApiKey) : undefined,
  });
  const fetch = createWebFetchTool({ fetch: options.fetch });

  return (pi) => {
    pi.registerTool(search);
    pi.registerTool(fetch);
  };
}

/** Install the Web Search and Web Fetch model tools into Pi. */
export default function piWebToolsExtension(pi: ExtensionAPI): void | Promise<void> {
  return createPiWebToolsExtension()(pi);
}
