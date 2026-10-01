import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  EXIT_NOTIFICATION_TYPE,
  formatExitNotification,
  renderExitNotification,
} from "../src/exit-notification.js";

const notices = [
  {
    id: "t1",
    kind: "terminal" as const,
    command: "npm run dev",
    exit: { code: 1, signal: null },
    durationMs: 65_000,
    output: "one\ntwo\nthree\n",
  },
  {
    id: "b2",
    kind: "job" as const,
    command: "sleep 100",
    exit: { code: null, signal: "SIGKILL" },
    durationMs: 800,
    output: "",
    logPath: "/tmp/pi-termctrl/1-b2.log",
  },
];

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
} satisfies Pick<Theme, "fg" | "bold">;

describe("Exit notifications", () => {
  test("formats each exit with the last lines of its output", () => {
    const message = formatExitNotification(notices, 2);
    expect(message.content).toBe(
      'Terminal t1 exited with code 1 after 1m 5s: npm run dev\nterminal_send {"id": "t1"} returns its final screen.\nLast lines of final screen:\ntwo\nthree\n\nBackground job b2 ended by SIGKILL after 800ms: sleep 100\nLog: /tmp/pi-termctrl/1-b2.log',
    );
    expect(message.details).toEqual({
      exits: [
        {
          id: "t1",
          kind: "terminal",
          command: "npm run dev",
          exit_code: 1,
          signal: null,
          duration_ms: 65_000,
        },
        {
          id: "b2",
          kind: "background_job",
          command: "sleep 100",
          exit_code: null,
          signal: "SIGKILL",
          duration_ms: 800,
          log_path: "/tmp/pi-termctrl/1-b2.log",
        },
      ],
    });
    expect(formatExitNotification(notices, 0).content).not.toContain("Last lines");
  });

  test("renders one compact line per exit, and the full text when expanded", () => {
    const { content, details } = formatExitNotification(notices, 20);
    const message = {
      role: "custom" as const,
      customType: EXIT_NOTIFICATION_TYPE,
      content,
      display: true,
      details,
      timestamp: 0,
    };
    // SAFETY: The renderer uses only the checked fg and bold theme methods.
    const compact = renderExitNotification(
      message,
      { expanded: false, outputPad: 0 },
      theme as Theme,
    );
    expect(compact?.render(120).map((line) => line.trimEnd())).toEqual([
      "■ t1 exited with code 1 · 1m 5s · npm run dev",
      "■ b2 ended by SIGKILL · 800ms · sleep 100",
    ]);
    // SAFETY: As above.
    const expanded = renderExitNotification(
      message,
      { expanded: true, outputPad: 0 },
      theme as Theme,
    );
    expect(expanded?.render(120).map((line) => line.trimEnd())).toContain(
      "Last lines of final screen:",
    );
  });
});
