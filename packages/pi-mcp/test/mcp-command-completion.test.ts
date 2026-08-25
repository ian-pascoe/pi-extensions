import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import {
  completeMcpCommandArguments,
  type McpCommandCompletionHost,
} from "../src/mcp-command-completion.js";
import { tokenizeMcpCommandLine } from "../src/mcp-command.js";

function completionHost(): McpCommandCompletionHost {
  return {
    completePromptArgument: vi.fn(async () => ({ hasMore: false, values: ["typed", "types"] })),
    listPrompts: vi.fn(async (serverId?: string) =>
      serverId === "docs"
        ? [
            {
              prompt: {
                arguments: [
                  { description: "Review topic", name: "topic", required: true },
                  { name: "tone" },
                ],
                description: "Review documentation",
                name: "review",
              },
              serverId,
            },
          ]
        : [],
    ),
    listResources: vi.fn(async (serverId?: string) =>
      serverId === "docs"
        ? [
            {
              resource: { name: "My Guide", uri: "file:///My Guide" },
              serverId,
            },
          ]
        : [],
    ),
    listStatuses: () =>
      new Map([
        ["alpha", { state: "disabled" }],
        ["docs", { state: "connected" }],
        ["Retrying", { attempt: 2, delayMs: 10, error: "offline", retryAt: 20, state: "retrying" }],
      ]),
    listSubscriptions: () => [
      { serverId: "docs", uri: "file:///My Guide" },
      { serverId: "docs", uri: "file:///archive" },
    ],
  };
}

function labels(items: Awaited<ReturnType<typeof completeMcpCommandArguments>>): readonly string[] {
  return items?.map(({ label }) => label) ?? [];
}

describe("MCP command completion", () => {
  test("completes every runtime command with descriptions and full-prefix replacements", async () => {
    const items = await completeMcpCommandArguments("lo", completionHost());

    expect(items).toEqual([
      {
        description: "Remove stored authentication",
        label: "logout",
        value: "logout ",
      },
      {
        description: "Read retained Server logs",
        label: "logs",
        value: "logs",
      },
    ]);
    expect(labels(await completeMcpCommandArguments("", completionHost()))).toEqual([
      "add",
      "auth",
      "disable",
      "enable",
      "help",
      "list",
      "logout",
      "logs",
      "prompt",
      "reconnect",
      "remove",
      "status",
      "subscribe",
      "test",
      "unsubscribe",
    ]);
  });

  test.each([
    [
      "add ",
      [
        "--auth",
        "--client-id",
        "--client-secret",
        "--cwd",
        "--environment",
        "--header",
        "--local",
        "--redirect-uri",
        "--scope",
        "--token",
        "--transport",
      ],
    ],
    ["auth ", ["--callback", "--code", "--no-open", "--state", "alpha", "docs", "Retrying"]],
    ["disable ", ["--local", "alpha", "docs", "Retrying"]],
    ["enable ", ["--local", "alpha", "docs", "Retrying"]],
    ["logs ", ["alpha", "docs", "Retrying"]],
    ["logout ", ["--all", "alpha", "docs", "Retrying"]],
    ["prompt ", ["docs"]],
    ["reconnect ", ["alpha", "docs", "Retrying"]],
    ["remove ", ["--local", "--logout", "alpha", "docs", "Retrying"]],
    ["subscribe ", ["docs"]],
    ["test ", ["--all", "alpha", "docs", "Retrying"]],
    ["unsubscribe ", ["docs"]],
  ])("offers legal first arguments for %s", async (prefix, expected) => {
    expect(labels(await completeMcpCommandArguments(prefix, completionHost()))).toEqual(expected);
  });

  test("hides used singleton flags, keeps repeatable flags, and honors coupled options", async () => {
    const host = completionHost();

    expect(labels(await completeMcpCommandArguments("remove -l ", host))).toEqual([
      "--logout",
      "alpha",
      "docs",
      "Retrying",
    ]);
    expect(labels(await completeMcpCommandArguments("logout --all ", host))).toEqual(["--force"]);
    expect(labels(await completeMcpCommandArguments("auth docs --code abc ", host))).toEqual([
      "--no-open",
      "--state",
    ]);
    expect(
      labels(await completeMcpCommandArguments("auth docs --callback https://done ", host)),
    ).toEqual(["--no-open"]);
    expect(
      labels(await completeMcpCommandArguments("auth docs --code abc --state xyz ", host)),
    ).toEqual(["--no-open"]);
    expect(await completeMcpCommandArguments("logout --all --force ", host)).toBeNull();
    expect(await completeMcpCommandArguments("test --json ", host)).toBeNull();
    expect(
      labels(await completeMcpCommandArguments("prompt docs review --arg topic=typed ", host)),
    ).toContain("--arg");
  });

  test("completes closed add values and filters incompatible local and remote options", async () => {
    const host = completionHost();

    expect(await completeMcpCommandArguments("add docs --auth B", host)).toEqual([
      {
        description: "Bearer token authentication",
        label: "bearer",
        value: "add docs --auth bearer ",
      },
    ]);
    expect(labels(await completeMcpCommandArguments("add docs --transport=", host))).toEqual([
      "http",
      "sse",
      "stdio",
    ]);
    expect(labels(await completeMcpCommandArguments("add docs --transport stdio ", host))).toEqual([
      "--",
      "--cwd",
      "--environment",
      "--local",
    ]);
    expect(
      labels(await completeMcpCommandArguments("add docs https://example.test ", host)),
    ).toEqual([
      "--auth",
      "--client-id",
      "--client-secret",
      "--header",
      "--local",
      "--redirect-uri",
      "--scope",
      "--token",
      "--transport",
    ]);
    expect(await completeMcpCommandArguments("auth docs --code ", host)).toBeNull();
    expect(
      await completeMcpCommandArguments("add docs https://example.test --auth n", host),
    ).toEqual([
      {
        description: "No authentication",
        label: "none",
        value: "add docs https://example.test --auth none",
      },
    ]);
    expect(
      await completeMcpCommandArguments("add docs https://example.test --transport h", host),
    ).toEqual([
      {
        description: "Streamable HTTP transport",
        label: "http",
        value: "add docs https://example.test --transport http",
      },
    ]);
    expect(
      await completeMcpCommandArguments(
        "add docs https://example.test --token secret --auth ",
        host,
      ),
    ).toEqual([
      {
        description: "Bearer token authentication",
        label: "bearer",
        value: "add docs https://example.test --token secret --auth bearer",
      },
    ]);
    expect(
      labels(
        await completeMcpCommandArguments("add docs https://example.test --token secret ", host),
      ),
    ).not.toEqual(expect.arrayContaining(["--client-id", "--client-secret", "--scope"]));
    expect(
      await completeMcpCommandArguments(
        "add docs https://example.test --token secret --client-id client ",
        host,
      ),
    ).toBeNull();
  });

  test("queries only the selected Server for prompts and reconstructs every prompt prefix", async () => {
    const host = completionHost();

    expect(await completeMcpCommandArguments("prompt docs r", host)).toEqual([
      {
        description: "Review documentation",
        label: "review",
        value: "prompt docs review",
      },
    ]);
    expect(host.listPrompts).toHaveBeenCalledWith("docs");
    expect(await completeMcpCommandArguments("prompt docs review --arg t", host)).toEqual([
      {
        label: "tone",
        value: "prompt docs review --arg tone=",
      },
      {
        description: "Review topic",
        label: "topic",
        value: "prompt docs review --arg topic=",
      },
    ]);
    expect(await completeMcpCommandArguments("prompt docs review --arg=topic=ty", host)).toEqual([
      {
        label: "typed",
        value: "prompt docs review --arg=topic=typed",
      },
      {
        label: "types",
        value: "prompt docs review --arg=topic=types",
      },
    ]);
    expect(host.completePromptArgument).toHaveBeenCalledWith("docs", "review", "topic", "ty");
  });

  test("adds a space only when the selected candidate requires another argument", async () => {
    const host = completionHost();

    expect(await completeMcpCommandArguments("reconnect d", host)).toEqual([
      { description: "connected", label: "docs", value: "reconnect docs" },
    ]);
    expect(await completeMcpCommandArguments("prompt d", host)).toEqual([
      { description: "connected", label: "docs", value: "prompt docs " },
    ]);
  });

  test("completes live and subscribed Resource URIs inside unfinished quotes", async () => {
    const host = completionHost();

    expect(await completeMcpCommandArguments('subscribe docs "file:///my g', host)).toEqual([
      {
        description: "My Guide",
        label: "file:///My Guide",
        value: 'subscribe docs "file:///My Guide"',
      },
    ]);
    expect(host.listResources).toHaveBeenCalledWith("docs");
    expect(await completeMcpCommandArguments("unsubscribe docs file:///a", host)).toEqual([
      {
        description: "Subscribed Resource",
        label: "file:///archive",
        value: "unsubscribe docs file:///archive",
      },
    ]);
    expect(host.listResources).toHaveBeenCalledTimes(1);
  });

  test("quotes completed tokens that contain whitespace, apostrophes, or escapes", async () => {
    const host = completionHost();
    host.listResources = vi.fn(async (serverId?: string) => [
      { resource: { name: "Ian's Guide", uri: "file:///Ian's Guide" }, serverId: serverId ?? "" },
      { resource: { name: "My Guide", uri: "file:///My Guide" }, serverId: serverId ?? "" },
    ]);

    expect(await completeMcpCommandArguments("subscribe docs 'file:///ian", host)).toEqual([
      {
        description: "Ian's Guide",
        label: "file:///Ian's Guide",
        value: 'subscribe docs "file:///Ian\'s Guide"',
      },
    ]);
    expect(await completeMcpCommandArguments("subscribe docs file:///My\\ G", host)).toEqual([
      {
        description: "My Guide",
        label: "file:///My Guide",
        value: 'subscribe docs "file:///My Guide"',
      },
    ]);
  });

  test("round-trips quoted Resource completions through command tokenization", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.constantFrom("a", " ", "'", '"', "\\", "é", "中", "🚀"), {
            minLength: 1,
          })
          .map((characters) => characters.join("")),
        async (uri) => {
          const host = completionHost();
          host.listResources = vi.fn(async (serverId?: string) => [
            { resource: { name: "Generated", uri }, serverId: serverId ?? "" },
          ]);

          const items = await completeMcpCommandArguments("subscribe docs ", host);

          expect(items).toHaveLength(1);
          expect(tokenizeMcpCommandLine(items?.[0]?.value ?? "")).toEqual([
            "subscribe",
            "docs",
            uri,
          ]);
        },
      ),
    );
  });

  test("silences dynamic failures, stops completed commands, and caps sorted results", async () => {
    const host = completionHost();
    host.listPrompts = vi.fn(async () => {
      throw new Error("offline");
    });
    host.listStatuses = () =>
      new Map(
        Array.from({ length: 120 }, (_, index) => [
          `server-${String(index).padStart(3, "0")}`,
          { state: "connected" as const },
        ]),
      );

    expect(await completeMcpCommandArguments("prompt server-001 ", host)).toBeNull();
    expect(await completeMcpCommandArguments("status ", host)).toBeNull();
    expect(await completeMcpCommandArguments("help ", host)).toBeNull();
    expect(await completeMcpCommandArguments("list ", host)).toBeNull();
    expect(await completeMcpCommandArguments("remove -- ", host)).toBeNull();
    expect(await completeMcpCommandArguments("auth docs --code --state ", host)).toBeNull();
    expect(await completeMcpCommandArguments("prompt --arg ", host)).toBeNull();
    expect(await completeMcpCommandArguments("logs server-", host)).toHaveLength(100);
  });
});
