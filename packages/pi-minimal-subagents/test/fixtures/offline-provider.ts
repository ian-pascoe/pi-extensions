// Offline Pi provider extension that records every model request as one JSON line.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, Model } from "@earendil-works/pi-ai";

export const OFFLINE_TEST_MODEL: Model<"openai-completions"> = {
  id: "model",
  name: "Offline provider test model",
  api: "openai-completions",
  provider: "provider",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Write the provider and a settings file into `directory`; each request answers "done". */
export function writeOfflineProvider(directory: string) {
  const requestsPath = join(directory, "requests.jsonl");
  const providerPath = join(directory, "offline-provider.ts");
  writeFileSync(requestsPath, "");
  writeFileSync(
    providerPath,
    `import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.registerProvider("provider", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "offline-test-key",
    models: [${JSON.stringify(OFFLINE_TEST_MODEL)}],
    streamSimple(model, context) {
      appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify(context) + "\\n");
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: ${JSON.stringify(ZERO_USAGE)},
        content: [{ type: "text", text: "done" }], stopReason: "stop",
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  });
}
`,
  );
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({
      extensions: [providerPath],
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  return {
    /** The recorded model requests in order, as the provider received them. */
    readRequests: (): { messages: Message[] }[] =>
      // SAFETY: the provider above writes one JSON-serialized Context per request.
      readFileSync(requestsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
