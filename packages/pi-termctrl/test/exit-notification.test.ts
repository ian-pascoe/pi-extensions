import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { beforeAll, describe, expect, test } from "vitest";
import {
  EXIT_NOTIFICATION_TYPE,
  formatExitNotification,
  renderExitNotification,
} from "../src/exit-notification.js";

type Notice = Parameters<typeof formatExitNotification>[0][number];

const notices: Notice[] = [
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

// SAFETY: The renderer draws only through the fg, bg and bold methods the escape-tagged theme provides.
const theme = escapeTaggedTheme as Theme;

beforeAll(() => {
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

function messageFor(exitNotices: typeof notices, tailLines = 20) {
  const { content, details } = formatExitNotification(exitNotices, tailLines);
  return {
    role: "custom" as const,
    customType: EXIT_NOTIFICATION_TYPE,
    content,
    display: true,
    details,
    timestamp: 0,
  };
}

/** Check the component fits at 40 and 120 columns; return its readable lines without the box background. */
function rendered(component: ReturnType<typeof renderExitNotification>): string[] {
  expect(component).toBeDefined();
  expectLinesFitWidth(component?.render(40) ?? [], 40);
  const wide = component?.render(120) ?? [];
  expectLinesFitWidth(wide, 120);
  return wide.map((line) =>
    readableTags(line)
      .replaceAll(/<\/?bg:customMessageBg>/gu, "")
      .trim(),
  );
}

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

  test("collapses to a bold label and one Status Mark row per exit, with the Expand Hint", () => {
    const collapsed = rendered(
      renderExitNotification(messageFor(notices), { expanded: false, outputPad: 1 }, theme),
    );
    expect(collapsed).toEqual([
      "",
      "<customMessageLabel><b>[termctrl]</b></customMessageLabel>",
      "",
      "<muted>■</muted> <customMessageText><b>t1</b></customMessageText> <customMessageText>exited with code 1</customMessageText><dim> · </dim><customMessageText>1m 5s</customMessageText><dim> · </dim><muted>npm run dev</muted>",
      "<muted>■</muted> <customMessageText><b>b2</b></customMessageText> <customMessageText>ended by SIGKILL</customMessageText><dim> · </dim><customMessageText>800ms</customMessageText><dim> · </dim><muted>sleep 100</muted><dim> (ctrl+o to expand)</dim>",
      "",
    ]);
  });

  test("a clean exit is marked done", () => {
    const clean: Notice = {
      id: "t1",
      kind: "terminal",
      command: "true",
      exit: { code: 0, signal: null },
      durationMs: 100,
      output: "",
    };
    const collapsed = rendered(
      renderExitNotification(messageFor([clean], 0), { expanded: false, outputPad: 0 }, theme),
    );
    expect(collapsed[3]).toContain("<success>✓</success> <customMessageText><b>t1</b>");
  });

  test("more than 10 exits collapse to 10 rows and the Expand Hint", () => {
    const many = Array.from({ length: 13 }, (_, index): Notice => ({
      id: `t${index + 1}`,
      kind: "terminal",
      command: "false",
      exit: { code: 1, signal: null },
      durationMs: 100,
      output: "",
    }));
    const collapsed = rendered(
      renderExitNotification(messageFor(many, 0), { expanded: false, outputPad: 0 }, theme),
    );
    expect(collapsed.filter((line) => line.includes("■"))).toHaveLength(10);
    expect(collapsed).toContain(
      "<muted>... (3 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );
  });

  test("expanded shows the full text with no extra hint", () => {
    const expanded = rendered(
      renderExitNotification(messageFor(notices), { expanded: true, outputPad: 1 }, theme),
    );
    expect(expanded).toContain(
      "<customMessageText>Last lines of final screen:</customMessageText>",
    );
    expect(expanded.join("\n")).not.toContain("to expand");
  });

  test("a message without details collapses its text to 10 lines", () => {
    const { details: _details, ...withoutDetails } = messageFor(notices);
    const message = {
      ...withoutDetails,
      content: Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n"),
    };
    const collapsed = rendered(
      renderExitNotification(message, { expanded: false, outputPad: 1 }, theme),
    );
    expect(collapsed).toContain("<customMessageText>line 10</customMessageText>");
    expect(collapsed).not.toContain("<customMessageText>line 11</customMessageText>");
    expect(collapsed.join("\n")).toContain("<muted>... (4 more lines,</muted>");
  });
});
