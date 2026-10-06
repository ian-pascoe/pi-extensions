import { onTestFinished, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import "./fixtures/hierarchy-extension.js";

it.each([false, true])(
  "holds CLI-only Advisor child delivery and live hierarchy policy (CM + built-in codemode: %s)",
  async (combined) => {
    const directory = await mkdtemp(join(tmpdir(), "advisor-hierarchy-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    onTestFinished(async () => {
      vi.unstubAllEnvs();
    });
    const backend = fileURLToPath(new URL("./fixtures/hierarchy-extension.ts", import.meta.url));
    const inheritedExtensions = [
      backend,
      ...(combined
        ? [
            fileURLToPath(new URL("../../pi-context-management/src/index.ts", import.meta.url)),
            "builtin:codemode",
          ]
        : []),
    ];
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        extensions: inheritedExtensions,
        defaultTools: [combined ? "+codemode" : "-codemode"],
        minimalSubagents: { enabled: true },
        advisor: {
          enabled: true,
          includeSubagents: true,
          catchUpThreshold: "off",
          maxNitsPerRequest: 1,
          allowedTools: [
            "read",
            "grep",
            "find",
            "ls",
            ...(combined
              ? ["context_notes", "context_history", "context_rollover", "codemode"]
              : []),
          ],
        },
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    let mainCalls = 0;
    let childCalls = 0;
    let childReviews = 0;
    let requestedAgent = "worker";
    let delivery: "subagent" | "agent_message" = "subagent";
    const childThinking: string[] = [];
    const reviewCodemode = new Map<string, string | undefined>();
    globalThis.advisorHierarchyTest = {
      roles: new Map(),
      stream(role, model, context, options) {
        if (role === "review-child") childThinking.push(options?.reasoning ?? "off");
        if (role.startsWith("review-") && !reviewCodemode.has(role))
          reviewCodemode.set(
            role,
            context.tools?.find((tool) => tool.name === "codemode")?.description,
          );
        const message = {
          ...fauxAssistantMessage(
            role === "child" ? (++childCalls === 1 ? "original" : "corrected") : "Done",
          ),
          api: model.api,
          provider: model.provider,
          model: model.id,
        };
        const call = (name: string, args: ToolCall["arguments"]) => {
          message.content = [
            { type: "toolCall", id: `${role}-${mainCalls}-${childReviews}`, name, arguments: args },
          ];
          message.stopReason = "toolUse";
        };
        if (role === "main") {
          mainCalls++;
          if (mainCalls === 1)
            call(
              delivery,
              delivery === "agent_message"
                ? { agent_id: requestedAgent, message: "Continue with another verified result" }
                : {
                    agent_id: requestedAgent,
                    task: "Produce a verified result",
                    tools: "read",
                    session_context: "omit",
                    project_context: "omit",
                    delegation: requestedAgent === "branch" ? "fanout" : "none",
                    thinking_level: "low",
                  },
            );
          else if (mainCalls === 2)
            call("subagent_wait", { agent_id: requestedAgent, timeout_ms: 10000 });
        } else if (role === "child" && context.tools?.some((tool) => tool.name === "subagent")) {
          if (
            !context.messages.some(
              (message) => message.role === "toolResult" && message.toolName === "subagent",
            )
          )
            call("subagent", {
              agent_id: "nested",
              task: "Verify the nested result",
              tools: "read",
              delegation: "none",
              session_context: "omit",
              project_context: "omit",
            });
          else if (
            !context.messages.some(
              (message) => message.role === "toolResult" && message.toolName === "subagent_wait",
            )
          )
            call("subagent_wait", { agent_id: "branch.nested", timeout_ms: 10000 });
        } else if (role === "review-child") {
          childReviews++;
          const nit = (message: string) => ({
            severity: "nit",
            message,
            evidence: { quote: "Done" },
          });
          call(
            "advisor_report",
            // Two Nits in one child task exceed maxNitsPerRequest; the next task gets its own.
            childReviews === 3
              ? { findings: [nit("First child Nit."), nit("Second child Nit.")] }
              : childReviews === 4
                ? { findings: [nit("Next task Nit.")] }
                : childReviews === 1
                  ? {
                      findings: [
                        {
                          severity: "blocker",
                          message: "Verify the result before completing.",
                          evidence: { quote: "Done" },
                        },
                      ],
                    }
                  : { severity: "none" },
          );
        } else if (role === "review-main") call("advisor_report", { severity: "none" });
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() =>
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          }),
        );
        return stream;
      },
    };
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const services = await createAgentSessionServices({
      cwd: directory,
      agentDir: directory,
      modelRuntime,
      settingsManager: SettingsManager.create(directory, directory),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noThemes: true,
        noPromptTemplates: true,
        additionalExtensionPaths: [
          ...inheritedExtensions,
          fileURLToPath(new URL("../../pi-minimal-subagents/src/index.ts", import.meta.url)),
          fileURLToPath(new URL("../src/index.ts", import.meta.url)),
        ],
        extensionFactories: [
          { name: "codemode", factory: createCodemodeExtension(), builtin: true },
        ],
      },
    });
    const model = modelRuntime.getModel("hierarchy-fixture", "model");
    if (!model) throw new Error("Missing offline model");
    const created = await createAgentSessionFromServices({
      services,
      model,
      sessionManager: SessionManager.create(directory, join(directory, "sessions")),
    });
    const runtime = new AgentSessionRuntime(created.session, services, async () => {
      throw new Error("No replacement");
    });
    onTestFinished(async () => {
      await runtime.session.abort();
      await runtime.dispose();
    });
    await runtime.session.bindExtensions({ mode: "print" });
    expect(runtime.session.getActiveToolNames().includes("codemode")).toBe(combined);
    await runtime.session.prompt("Delegate and wait for the verified result.");
    const result = runtime.session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "subagent_wait",
    );
    expect(result).toMatchObject({ isError: false });
    expect(JSON.stringify(result)).toContain("corrected");
    expect(childCalls).toBe(2);
    expect(childReviews).toBe(2);
    expect(childThinking).toEqual(["low", "low"]);
    // Each Advisor Session reproduces its observed agent's codemode: children have no model API.
    if (combined) {
      expect(reviewCodemode.get("review-main")).toContain("- `models`:");
      expect(reviewCodemode.get("review-child")).toContain("tools");
      expect(reviewCodemode.get("review-child")).not.toContain("- `models`:");
    }
    await runtime.session.prompt("/advisor status");
    expect(
      runtime.session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: {
        children: [
          {
            agentId: "worker",
            effectiveModel: "hierarchy-fixture/model",
            effectiveThinkingLevel: "low",
          },
        ],
      },
    });
    expect(runtime.session.sessionManager.getBranch()).toContainEqual(
      expect.objectContaining({ type: "custom", customType: "pi-advisor-child" }),
    );

    await runtime.session.prompt("/advisor off");
    delivery = "agent_message";
    mainCalls = 0;
    await runtime.session.prompt("Continue the existing worker.");
    expect(childCalls).toBe(3);
    expect(childReviews).toBe(2);

    requestedAgent = "future";
    delivery = "subagent";
    mainCalls = 0;
    await runtime.session.prompt("Create another worker while Advisor is off.");
    expect(childCalls).toBe(4);
    expect(childReviews).toBe(2);

    await runtime.session.prompt("/advisor on");
    delivery = "agent_message";
    mainCalls = 0;
    await runtime.session.prompt("Continue the worker created while disabled.");
    expect(childCalls).toBe(5);
    expect(childReviews).toBe(3);
    // Minimal's beginTurn starts each child task's Nit allowance.
    mainCalls = 0;
    await runtime.session.prompt("Continue that worker once more.");
    expect(childCalls).toBe(6);
    expect(childReviews).toBe(4);
    const childNits = runtime.session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-advisor-child" &&
        JSON.stringify(entry.data).includes("Nit.")
          ? [JSON.stringify(entry.data)]
          : [],
      );
    expect(childNits).toEqual([
      expect.stringContaining("First child Nit."),
      expect.stringContaining("Next task Nit."),
    ]);

    await runtime.session.prompt("/advisor set includeSubagents false");
    mainCalls = 0;
    await runtime.session.prompt("Continue with main-only coverage.");
    expect(childCalls).toBe(7);
    expect(childReviews).toBe(4);
    await runtime.session.prompt("/advisor status");
    expect(
      runtime.session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: {
        children: [
          { agentId: "worker", state: "disabled" },
          { agentId: "future", state: "disabled" },
        ],
      },
    });

    await runtime.session.prompt("/advisor set includeSubagents true");
    requestedAgent = "branch";
    delivery = "subagent";
    mainCalls = 0;
    await runtime.session.prompt("Delegate a nested task.");
    await runtime.session.prompt("/advisor status");
    expect(
      runtime.session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: {
        children: expect.arrayContaining([
          expect.objectContaining({ agentId: "branch.nested", state: "armed" }),
        ]),
      },
    });
    expect(childReviews).toBeGreaterThanOrEqual(6);
  },
  30_000,
);
