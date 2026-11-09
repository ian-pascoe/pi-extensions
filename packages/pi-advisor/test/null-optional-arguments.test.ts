import { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { expectNullOptionalArgumentsOmitted } from "@ian-pascoe/pi-utils/tool-testing";
import { expect, it, onTestFinished } from "vitest";
import { fixture } from "./fixtures/advisor-runtime.js";
import { activeFixture, longSessionStream } from "./fixtures/observer-harness.js";
import { AdvisorObserver } from "../src/advisor-observer.js";
import { readAdvisorSettings } from "../src/advisor-settings.js";

it("advisor_ask treats null for an optional parameter like omitting it", async () => {
  const { session } = await fixture();
  const ask = session.extensionRunner?.getToolDefinition("advisor_ask");
  if (!ask) throw new Error("Expected the advisor_ask tool");
  // Its only parameter is required, so there is nothing optional to reject null.
  expect(expectNullOptionalArgumentsOmitted(ask)).toEqual([]);
});

it("advisor_report treats null for an optional parameter like omitting it", async () => {
  globalThis.advisorObserverTest = longSessionStream({}, [], {
    result: (id) => `ok ${id}`,
    isError: () => false,
  });
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 1 },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  onTestFinished(() => observer.dispose());
  await session.prompt("Answer");
  // The private Advisor Session holds the real tool definition the observer built for it.
  // oxlint-disable-next-line typescript/dot-notation -- Test-only read of the private runtime, to reach the tool definition the observer built.
  const advisor = observer["runtime"];
  if (!(advisor instanceof AgentSessionRuntime))
    throw new Error("Expected a live private Advisor Session");
  const report = advisor.session.getToolDefinition("advisor_report");
  if (!report) throw new Error("Expected the advisor_report tool");
  // Only its nested evidence fields are optional; `refs: null` is proven through a Review in
  // finding-quality.test.ts. Every top-level optional parameter must be null-safe.
  expect(expectNullOptionalArgumentsOmitted(report)).toEqual([]);
});
