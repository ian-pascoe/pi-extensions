import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import {
  asModelResponse,
  disposeLiveRootSessions,
  pendingRootDeliveries,
  rootResultEntries,
  startLiveRootSession,
} from "./fixtures/live-root-session.js";

afterEach(disposeLiveRootSessions);

interface ProviderRequest {
  readonly tools: string;
  readonly systemPrompt: string;
  readonly messages: Message[];
}

/** The Recording child's completed output, which reaches the root only as the result steer. */
const CHILD_OUTPUT = "completed child turn";
/** Covers the 1 s wait-claim grace period before automatic fallback, plus scheduling slack. */
const GRACE_TIMEOUT = { timeout: 5_000 };

/**
 * One live root Pi session scripted to spawn a child, then hold its next model request open,
 * so the child's result is steered into Pi's queue while the root turn runs.
 */
async function startHeldRootTurn() {
  const requests: ProviderRequest[] = [];
  let summaryRequests = 0;
  const held = Promise.withResolvers<void>();
  const session = await startLiveRootSession(
    "discarded",
    () => (currentModel, context, options) => {
      const request = {
        tools: JSON.stringify(getCurrentTools(context.messages)),
        systemPrompt: getCurrentSystemPrompt(context.messages),
        messages: structuredClone(context.messages),
      };
      const stream = createAssistantMessageEventStream();
      if (request.systemPrompt.startsWith("You are a context summarization assistant")) {
        // A branch summary that outlasts the grace period, as a real model call would.
        summaryRequests++;
        setTimeout(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: asModelResponse(
              currentModel,
              fauxAssistantMessage("## Goal\nSpawn a worker."),
            ),
          });
        }, 1_500);
        return stream;
      }
      requests.push(request);
      const respond = (message: AssistantMessage) => asModelResponse(currentModel, message);
      if (requests.length === 1) {
        const spawn = fauxAssistantMessage(
          fauxToolCall("subagent", { task: "Report back", agent_id: "worker" }, { id: "spawn" }),
          { stopReason: "toolUse" },
        );
        queueMicrotask(() =>
          stream.push({ type: "done", reason: "toolUse", message: respond(spawn) }),
        );
      } else if (requests.length === 2) {
        // The root keeps working until it is released or aborted.
        const abort = () =>
          stream.push({
            type: "error",
            reason: "aborted",
            error: respond(fauxAssistantMessage("", { stopReason: "aborted" })),
          });
        if (options?.signal?.aborted) queueMicrotask(abort);
        options?.signal?.addEventListener("abort", abort, { once: true });
        void held.promise.then(() =>
          stream.push({
            type: "done",
            reason: "stop",
            message: respond(fauxAssistantMessage("Still working.")),
          }),
        );
      } else {
        queueMicrotask(() =>
          stream.push({
            type: "done",
            reason: "stop",
            message: respond(fauxAssistantMessage("Done.")),
          }),
        );
      }
      return stream;
    },
  );

  const run = session.prompt("Spawn a worker");
  // The child completes at once; after the grace period its result is steered into the busy root.
  await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true), GRACE_TIMEOUT);
  expect(requests).toHaveLength(2);

  return {
    session,
    requests,
    run,
    releaseHeldResponse: () => held.resolve(),
    summaryRequests: () => summaryRequests,
    resultEntries: () => rootResultEntries(session),
    pendingDeliveries: () => pendingRootDeliveries(session),
  };
}

function requestCarriesResult(request: ProviderRequest | undefined): boolean {
  return JSON.stringify(request?.messages).includes(CHILD_OUTPUT);
}

/** Outlast the grace period so any automatic re-send would already have reached Pi. */
async function outlastGracePeriod(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

test("delivers a result Esc discarded once the user starts the root's next run", async () => {
  const { session, requests, run, resultEntries, pendingDeliveries } = await startHeldRootTurn();

  // Pi's Esc: clear the queue, then abort the running turn.
  session.clearQueue();
  await session.abort();
  await run;
  // Recovery respects Esc: no provider request until the user prompts again.
  await outlastGracePeriod();
  expect(requests).toHaveLength(2);
  expect(resultEntries()).toHaveLength(0);

  await session.prompt("next");
  await session.waitForIdle();
  expect(requests).toHaveLength(3);
  expect(requestCarriesResult(requests[2])).toBe(true);
  expect(resultEntries()).toHaveLength(1);

  await outlastGracePeriod();
  await session.waitForIdle();
  expect(requests).toHaveLength(3);
  expect(resultEntries()).toHaveLength(1);
  expect(pendingDeliveries()).toEqual([]);
});

test("starts no root turn when /tree summarizes the branch after Esc", async () => {
  const { session, requests, run, summaryRequests } = await startHeldRootTurn();
  const firstUser = session.sessionManager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  if (!firstUser) throw new Error("Expected the root's first user message");

  session.clearQueue();
  await session.abort();
  await run;
  const navigation = await session.navigateTree(firstUser.id, { summarize: true });
  expect(navigation.cancelled).toBe(false);
  await outlastGracePeriod();
  await session.waitForIdle();

  expect(summaryRequests()).toBe(1);
  expect(requests).toHaveLength(2);
  expect(
    session.sessionManager
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom_message" && entry.customType === "minimal-subagents.result",
      ),
  ).toEqual([]);
});

test("delivers a queued result once when nothing clears the queue", async () => {
  const { session, requests, run, releaseHeldResponse, resultEntries, pendingDeliveries } =
    await startHeldRootTurn();

  releaseHeldResponse();
  await run;
  await outlastGracePeriod();
  await session.waitForIdle();

  expect(requests).toHaveLength(3);
  expect(requestCarriesResult(requests[2])).toBe(true);
  expect(resultEntries()).toHaveLength(1);
  expect(pendingDeliveries()).toEqual([]);
  // Cache proof: the turn_end handler leaves the provider prefix untouched. Tools and system prompt
  // are byte-equal, and each request's history is an exact prefix of the next.
  const [spawned, held, delivered] = requests;
  expect(held?.tools).toBe(spawned?.tools);
  expect(delivered?.tools).toBe(spawned?.tools);
  expect(held?.systemPrompt).toBe(spawned?.systemPrompt);
  expect(delivered?.systemPrompt).toBe(spawned?.systemPrompt);
  expect(held?.messages.slice(0, spawned?.messages.length)).toEqual(spawned?.messages);
  expect(delivered?.messages.slice(0, held?.messages.length)).toEqual(held?.messages);
});

test("delivers a result in the same run when the queue is cleared without an abort", async () => {
  const { session, requests, run, releaseHeldResponse, resultEntries, pendingDeliveries } =
    await startHeldRootTurn();

  // A dequeue or RPC `clear_queue` drops the steer but leaves the root turn running.
  session.clearQueue();
  releaseHeldResponse();
  await run;

  expect(requests).toHaveLength(3);
  expect(requestCarriesResult(requests[2])).toBe(true);
  expect(resultEntries()).toHaveLength(1);
  await outlastGracePeriod();
  await session.waitForIdle();
  expect(requests).toHaveLength(3);
  expect(resultEntries()).toHaveLength(1);
  expect(pendingDeliveries()).toEqual([]);
});

test("keeps a result queued across a plain abort", async () => {
  const { session, requests, run, resultEntries, pendingDeliveries } = await startHeldRootTurn();

  // An abort without clearing leaves the steer in Pi's queue for the next run.
  await session.abort();
  await run;
  await outlastGracePeriod();
  expect(requests).toHaveLength(2);
  expect(session.agent.hasQueuedMessages()).toBe(true);

  await session.prompt("next");
  await outlastGracePeriod();
  await session.waitForIdle();

  expect(requests).toHaveLength(3);
  expect(requestCarriesResult(requests[2])).toBe(true);
  expect(resultEntries()).toHaveLength(1);
  expect(pendingDeliveries()).toEqual([]);
});
