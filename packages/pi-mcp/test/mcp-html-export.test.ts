import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { renderMcpServerToolCall, renderMcpToolResult } from "../src/mcp-presentation.js";

test("Pi HTML export uses MCP renderers without changing stored tool data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-html-"));
  const agentDirectory = join(directory, "agent");
  const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
  const settingsManager = SettingsManager.inMemory({ theme: "dark" });
  const resourceLoader = new DefaultResourceLoader({
    agentDir: agentDirectory,
    cwd: directory,
    extensionFactories: [],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });
  await resourceLoader.reload();

  const details = {
    mcp: {
      isError: false,
      operation: "Server Tool docs/search",
      owner: "pi-mcp",
      serverId: "docs",
      toolName: "search",
    },
    result: { storedContent: [], summary: "answer" },
  };
  const tool: ToolDefinition = {
    description: "Search docs",
    execute: async () => ({
      content: [{ text: "answer", type: "text" as const }],
      details,
    }),
    label: "Search",
    name: "mcp__docs__search",
    parameters: Type.Object({ query: Type.String() }),
    renderCall: (arguments_, theme, context) =>
      renderMcpServerToolCall("docs", "search", arguments_, theme, context.expanded),
    renderResult: (result, options, theme, context) =>
      renderMcpToolResult(result, options, theme, context.isError),
  };
  const faux = registerFauxProvider({
    models: [{ id: "mcp-html", reasoning: false }],
    tokensPerSecond: 10_000,
  });
  const { session } = await createAgentSession({
    agentDir: agentDirectory,
    customTools: [tool],
    cwd: directory,
    model: faux.getModel(),
    noTools: "builtin",
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  try {
    await session.bindExtensions({});
    expect(session.getToolDefinition(tool.name)?.renderCall).toEqual(expect.any(Function));
    const toolCall = fauxToolCall(tool.name, { query: "observer UI" });
    sessionManager.appendMessage(fauxAssistantMessage(toolCall, { stopReason: "toolUse" }));
    sessionManager.appendMessage({
      content: [{ text: "answer", type: "text" }],
      details,
      isError: false,
      role: "toolResult",
      timestamp: 1,
      toolCallId: toolCall.id,
      toolName: tool.name,
    } satisfies ToolResultMessage);
    const storedBefore = structuredClone(sessionManager.getBranch());
    const outputPath = join(directory, "session.html");
    initTheme("dark");
    await session.exportToHtml(outputPath);
    const html = await readFile(outputPath, "utf8");
    const encodedSession =
      /<script id="session-data" type="application\/json">([^<]+)<\/script>/u.exec(html)?.[1];
    if (encodedSession === undefined) throw new Error("Expected Pi HTML session data");
    // SAFETY: Pi produced this export in-process; the assertions below verify the optional renderer fields before reading them.
    const exported = JSON.parse(Buffer.from(encodedSession, "base64").toString("utf8")) as {
      readonly renderedTools?: Readonly<
        Record<
          string,
          {
            readonly callHtml?: string;
            readonly resultHtmlCollapsed?: string;
            readonly resultHtmlExpanded?: string;
          }
        >
      >;
    };
    const rendered = exported.renderedTools?.[toolCall.id];

    expect(rendered?.callHtml).toContain("docs / search");
    expect(rendered?.resultHtmlCollapsed).toContain("✓ completed");
    expect(rendered?.resultHtmlExpanded).toContain("1 text block");
    expect(sessionManager.getBranch()).toEqual(storedBefore);
  } finally {
    session.dispose();
    faux.unregister();
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);
