import { describe, expect, test, vi } from "vitest";
import {
  McpObserverUiController,
  buildMcpObserverSnapshot,
  type McpObserverUiContext,
} from "../src/mcp-observer-ui.js";

const plainTheme = { fg: (_color: string, text: string) => text };

function context(mode: McpObserverUiContext["mode"] = "tui") {
  const notify = vi.fn();
  const setStatus = vi.fn();
  const observerContext = {
    mode,
    ui: { notify, setStatus, theme: plainTheme },
  } satisfies McpObserverUiContext;
  return { context: observerContext, notify, setStatus };
}

describe("MCP Observer UI", () => {
  test("projects no footer without enabled Servers and a dim healthy ratio otherwise", () => {
    expect(
      buildMcpObserverSnapshot(new Map([["disabled", { state: "disabled" }]])).footer,
    ).toBeUndefined();
    expect(
      buildMcpObserverSnapshot(
        new Map([
          ["docs", { state: "connected" }],
          ["search", { state: "connected" }],
        ]),
      ).footer,
    ).toEqual({ color: "dim", text: "MCP 2/2" });
  });

  test("projects degraded health with state-backed text and actionable notices", () => {
    const snapshot = buildMcpObserverSnapshot(
      new Map([
        ["auth", { error: "bearer token", state: "needs_auth" }],
        ["down", { attempts: 2, error: "offline", state: "failed" }],
        ["starting", { attempt: 1, state: "connecting" }],
      ]),
    );

    expect(snapshot.footer?.color).toBe("error");
    expect(snapshot.footer?.text).toContain("MCP 0/3");
    expect(snapshot.footer?.text).toContain("connecting 1");
    expect(snapshot.footer?.text).toContain("authentication 1");
    expect(snapshot.notices).toEqual([
      {
        action: "/mcp auth auth",
        cause: "bearer token",
        condition: "needs_auth",
        level: "warning",
        serverId: "auth",
      },
      {
        action: "/mcp reconnect down",
        cause: "offline",
        condition: "failed",
        level: "error",
        serverId: "down",
      },
    ]);
  });

  test("emits each actionable notice once, re-arms after recovery, and clears its footer", () => {
    const { context: tui, notify, setStatus } = context();
    const observer = new McpObserverUiController(tui, (value) =>
      value.replaceAll("secret", "[REDACTED]"),
    );
    const failed = new Map([
      ["docs", { attempts: 1, error: "secret\u001b[31m failure", state: "failed" as const }],
    ]);

    observer.update(failed);
    observer.update(failed);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(
      "MCP Server docs failed: [REDACTED] failure\nRun /mcp reconnect docs",
      "error",
    );

    observer.update(new Map([["docs", { state: "connected" }]]));
    observer.update(failed);
    expect(notify).toHaveBeenCalledTimes(2);

    observer.dispose();
    observer.dispose();
    expect(setStatus).toHaveBeenLastCalledWith("pi-mcp", undefined);
  });

  test("sanitizes and redacts invalid-settings attention without a Server", () => {
    const { context: tui, notify } = context();
    const observer = new McpObserverUiController(tui, (value) =>
      value.replaceAll("secret", "[REDACTED]"),
    );

    observer.update(new Map(), ["bad secret\u001b]8;;https://bad\u0007 settings"]);

    expect(notify).toHaveBeenCalledWith(
      "MCP settings need attention: bad [REDACTED] settings\nRun /mcp status",
      "warning",
    );
  });

  test("sanitizes Server identities and quotes commands that contain spaces", () => {
    const { context: tui, notify } = context();
    const observer = new McpObserverUiController(tui, (value) => value);

    observer.update(
      new Map([["docs server\u001b[31m", { error: "offline", state: "needs_auth" as const }]]),
    );

    expect(notify).toHaveBeenCalledWith(
      'MCP Server docs server needs authentication: offline\nRun /mcp auth "docs server"',
      "warning",
    );
  });

  test("does nothing in RPC or print modes and isolates throwing UI callbacks", () => {
    for (const mode of ["rpc", "print"] as const) {
      const { context: nonTui, notify, setStatus } = context(mode);
      const observer = new McpObserverUiController(nonTui, (value) => value);
      observer.update(
        new Map([["docs", { attempts: 1, error: "down", state: "failed" as const }]]),
      );
      observer.dispose();
      expect(notify).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
    }

    const observer = new McpObserverUiController(
      {
        mode: "tui",
        ui: {
          notify: () => {
            throw new Error("notify failed");
          },
          setStatus: () => {
            throw new Error("status failed");
          },
          theme: plainTheme,
        },
      },
      (value) => value,
    );
    expect(() =>
      observer.update(
        new Map([["docs", { attempts: 1, error: "down", state: "failed" as const }]]),
      ),
    ).not.toThrow();
    expect(() => observer.dispose()).not.toThrow();
  });
});
