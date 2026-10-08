import { expect, it } from "vitest";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { promptSample } from "../src/advisor-calibration.js";

const usage = (input: number, cacheRead = 0, cacheWrite = 0): Usage => ({
  input,
  output: 10,
  cacheRead,
  cacheWrite,
  totalTokens: input + cacheRead + cacheWrite + 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const assistant = (
  usageValue: Usage,
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): Message => ({
  role: "assistant",
  content: [],
  api: "faux",
  provider: "faux",
  model: "faux",
  usage: usageValue,
  stopReason,
  timestamp: 0,
});

it("measures the input a prompt added: the first response's input less the context before it", () => {
  const messages = [user("earlier"), user("x".repeat(4_000)), assistant(usage(100, 7_000, 3_000))];
  expect(promptSample(messages, 1, 8_000)).toEqual({ estimated: 1_000, reported: 2_100 });
});

it("learns nothing without a known context size, a usable response, or a positive difference", () => {
  const prompted = (response: Message) => [user("x".repeat(4_000)), response];
  expect(promptSample(prompted(assistant(usage(5_000))), 0, null)).toBeUndefined();
  expect(promptSample(prompted(assistant(usage(5_000))), 0, undefined)).toBeUndefined();
  expect(promptSample(prompted(assistant(usage(0))), 0, 0)).toBeUndefined();
  expect(promptSample(prompted(assistant(usage(5_000), "error")), 0, 0)).toBeUndefined();
  expect(promptSample(prompted(assistant(usage(5_000), "aborted")), 0, 0)).toBeUndefined();
  expect(promptSample(prompted(assistant(usage(5_000))), 0, 5_000)).toBeUndefined();
  expect(promptSample([user("no response")], 0, 0)).toBeUndefined();
});
