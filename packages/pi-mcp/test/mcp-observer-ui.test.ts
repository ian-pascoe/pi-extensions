import { describe, expect, test, vi } from "vitest";
import {
  McpObserverUiController,
  buildMcpObserverSnapshot,
  type McpObserverUiContext,
} from "../src/mcp-observer-ui.js";

const plainTheme = { fg: (_color: string, text: string) => text };

function context(
  mode: McpObserverUiContext["mode"] = "tui",
  fg: (color: string, text: string) => string = plainTheme.fg,
) {
  const notify = vi.fn();
  const setStatus = vi.fn();
  const observerContext = {
    mode,
    ui: { notify, setStatus, theme: { fg } },
  } satisfies McpObserverUiContext;
  return { context: observerContext, notify, setStatus };
}

describe("MCP Observer UI", () => {
  test("always projects a portable connected-to-enabled ratio", () => {
    expect(
      buildMcpObserverSnapshot(new Map([["disabled", { state: "disabled" }]]), false).footer,
    ).toEqual([{ color: "dim", text: "MCP 0/0" }]);
    expect(
      buildMcpObserverSnapshot(
        new Map([
          ["docs", { state: "connected" }],
          ["search", { state: "connected" }],
        ]),
        false,
      ).footer,
    ).toEqual([{ color: "dim", text: "MCP 2/2" }]);
  });

  test("groups portable busy, auth, and failed health with individual colors", () => {
    const snapshot = buildMcpObserverSnapshot(
      new Map([
        ["auth", { error: "bearer token", state: "needs_auth" }],
        ["down", { attempts: 2, error: "offline", state: "failed" }],
        ["retry", { attempt: 2, delayMs: 10, error: "retrying", retryAt: 20, state: "retrying" }],
        ["starting", { attempt: 1, state: "connecting" }],
      ]),
      false,
    );

    expect(snapshot.footer).toEqual([
      { color: "dim", text: "MCP 0/4" },
      { color: "warning", text: "busy 2" },
      { color: "warning", text: "auth 1" },
      { color: "error", text: "failed 1" },
    ]);
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

  test("renders Nerd Font health icons as individually styled segments", () => {
    const { context: tui, setStatus } = context(
      "tui",
      (color, text) => `<${color}>${text}</${color}>`,
    );
    const observer = new McpObserverUiController(tui, (value) => value, true);

    observer.update(
      new Map([
        ["auth", { error: "login", state: "needs_client_registration" }],
        ["connected", { state: "connected" }],
        ["down", { attempts: 1, error: "offline", state: "failed" }],
        ["starting", { attempt: 1, state: "connecting" }],
      ]),
    );

    expect(setStatus).toHaveBeenLastCalledWith(
      "pi-mcp",
      "<dim> 1/4</dim> · <warning> 1</warning> · <warning> 1</warning> · <error> 1</error>",
    );
  });

  test("does not redraw an unchanged footer", () => {
    const { context: tui, setStatus } = context();
    const observer = new McpObserverUiController(tui, (value) => value, false);
    const statuses = new Map([["docs", { state: "connected" as const }]]);

    observer.update(statuses);
    observer.update(statuses);

    expect(setStatus).toHaveBeenCalledTimes(1);
  });

  test("emits each actionable notice once, re-arms after recovery, and clears its footer", () => {
    const { context: tui, notify, setStatus } = context();
    const observer = new McpObserverUiController(
      tui,
      (value) => value.replaceAll("secret", "[REDACTED]"),
      false,
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
    const observer = new McpObserverUiController(
      tui,
      (value) => value.replaceAll("secret", "[REDACTED]"),
      false,
    );

    observer.update(new Map(), ["bad secret\u001b]8;;https://bad\u0007 settings"]);

    expect(notify).toHaveBeenCalledWith(
      "MCP settings need attention: bad [REDACTED] settings\nRun /mcp status",
      "warning",
    );
  });

  test("sanitizes Server identities and quotes commands that contain spaces", () => {
    const { context: tui, notify } = context();
    const observer = new McpObserverUiController(tui, (value) => value, false);

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
      const observer = new McpObserverUiController(nonTui, (value) => value, false);
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
      false,
    );
    expect(() =>
      observer.update(
        new Map([["docs", { attempts: 1, error: "down", state: "failed" as const }]]),
      ),
    ).not.toThrow();
    expect(() => observer.dispose()).not.toThrow();
  });
});
