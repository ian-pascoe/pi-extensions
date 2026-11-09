import { KeybindingsManager, setKeybindings, type Component } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme as taggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  renderListResult,
  renderSendCall,
  renderStartCall,
  renderStopResult,
  renderTerminalResult,
  renderWaitResult,
  type ResultContext,
} from "../src/terminal-render.js";
import type { ListResult, StopResult, TerminalResult, WaitResult } from "../src/terminal-tools.js";

beforeAll(() => {
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

afterEach(() => {
  vi.useRealTimers();
});

function context(overrides: Partial<ResultContext> = {}): ResultContext {
  return {
    state: {},
    executionStarted: true,
    isPartial: false,
    durationMs: 1_234,
    invalidate: () => {},
    isError: false,
    ...overrides,
  };
}

const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };

/** Check the component fits at 40 and 120 columns, and return its readable 120-column lines. */
function lines(component: Component): string[] {
  expectLinesFitWidth(component.render(40), 40);
  const wide = component.render(120);
  expectLinesFitWidth(wide, 120);
  return wide.map((line) => readableTags(line).trimEnd());
}

function textResult<TDetails>(details: TDetails | undefined, text = "") {
  return { content: [{ type: "text", text }], details };
}

function terminalDetails(overrides: Partial<TerminalResult> = {}): TerminalResult {
  return {
    id: "t1",
    state: "running",
    settle_reason: "quiet",
    changed: true,
    cursor: { row: 2, column: 4 },
    screen: "one\ntwo",
    scrolled_off: "",
    ...overrides,
  };
}

const numbered = (count: number, prefix = "row") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");

describe("call rows", () => {
  test("terminal_start shows the registered name and the command like bash", () => {
    const rendered = lines(
      renderStartCall({ command: "python3 -q", cwd: "/tmp", wait_ms: 500 }, taggedTheme, {
        ...context(),
        executionStarted: false,
      }),
    );
    expect(rendered[0]).toBe(
      "<toolTitle><b>terminal_start</b></toolTitle> <accent>$ python3 -q</accent> <muted>in /tmp wait 500ms</muted>",
    );
  });

  test("terminal_send shows the id with what is typed, pressed and waited for", () => {
    const rendered = lines(
      renderSendCall(
        {
          id: "t1",
          text: "ls\n",
          keys: ["Enter", "Control+C"],
          wait_for_text: "done",
          wait_ms: 900,
        },
        taggedTheme,
        context({ executionStarted: false }),
      ),
    );
    expect(rendered[0]).toBe(
      '<toolTitle><b>terminal_send</b></toolTitle> <accent>t1</accent> <muted>type "ls\\n" press Enter Control+C wait_for "done" 900ms</muted>',
    );
  });
});

describe("terminal_start and terminal_send results", () => {
  test("a short screen shows fully with a status line and Took footer", () => {
    const rendered = lines(
      renderTerminalResult(textResult(terminalDetails()), collapsed, taggedTheme, context()),
    );
    expect(rendered).toEqual([
      "",
      "<muted>t1 running</muted><dim> · </dim><muted>settled: quiet</muted>",
      "<toolOutput>one</toolOutput>",
      "<toolOutput>two</toolOutput>",
      "",
      "<muted>Took 1.2s</muted>",
    ]);
  });

  test("a tall screen keeps its last 5 lines and counts the earlier ones in the hint", () => {
    const rendered = lines(
      renderTerminalResult(
        textResult(terminalDetails({ screen: numbered(12) })),
        collapsed,
        taggedTheme,
        context(),
      ),
    );
    expect(rendered[2]).toBe(
      "<muted>... (7 earlier lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );
    expect(rendered.slice(3, 8)).toEqual(
      [8, 9, 10, 11, 12].map((n) => `<toolOutput>row ${n}</toolOutput>`),
    );
  });

  test("the Expanded View shows every line, labels scrolled-off lines, and has no hint", () => {
    const rendered = lines(
      renderTerminalResult(
        textResult(terminalDetails({ screen: numbered(12), scrolled_off: "old 1\nold 2" })),
        expanded,
        taggedTheme,
        context(),
      ),
    );
    expect(rendered).toContain("<muted>--- scrolled off ---</muted>");
    expect(rendered).toContain("<muted>--- screen ---</muted>");
    expect(rendered).toContain("<toolOutput>old 2</toolOutput>");
    expect(rendered).toContain("<toolOutput>row 1</toolOutput>");
    expect(rendered.join("\n")).not.toContain("to expand");
  });

  test("an exited Terminal names how it ended, a repeated screen is noted, and cuts are warned", () => {
    const rendered = lines(
      renderTerminalResult(
        textResult(
          terminalDetails({
            state: "exited",
            exit_code: 2,
            settle_reason: "exited",
            changed: false,
            screen: "",
            output_missing: true,
            full_output_path: "/tmp/out.txt",
          }),
        ),
        collapsed,
        taggedTheme,
        context(),
      ),
    );
    expect(rendered[1]).toBe(
      "<warning>t1 exited with code 2</warning><dim> · </dim><muted>settled: exited</muted><dim> · </dim><muted>screen unchanged</muted>",
    );
    expect(rendered).toContain("<toolOutput>(blank)</toolOutput>");
    expect(rendered).toContain("<warning>[Earlier output is missing]</warning>");
    expect(rendered).toContain("<warning>[Full output: /tmp/out.txt]</warning>");
  });
});

describe("terminal_stop results", () => {
  test("shows the stop line and the final screen's last 5 lines", () => {
    const details: StopResult = {
      id: "t1",
      kind: "terminal",
      state: "exited",
      exit_code: 0,
      changed: true,
      screen: numbered(8),
      scrolled_off: "",
    };
    const rendered = lines(
      renderStopResult(
        textResult(details, "Terminal t1 stopped.\n--- final screen ---\nrow"),
        collapsed,
        taggedTheme,
        context(),
      ),
    );
    expect(rendered[1]).toBe("<muted>Terminal t1 stopped.</muted>");
    expect(rendered[2]).toContain("<muted>... (3 earlier lines,</muted>");
    expect(rendered).toContain("<toolOutput>row 8</toolOutput>");
  });
});

describe("terminal_list results", () => {
  const entry = (id: string, command: string) => ({
    id,
    command,
    state: "running" as const,
    age_seconds: 75,
  });

  test("lists one row per entry, with a Background job's log in the Expanded View", () => {
    const details: ListResult = {
      terminals: [entry("t1", "python3")],
      background_jobs: [{ ...entry("b1", "npm run build"), log_path: "/tmp/b1.log" }],
    };
    const rows = lines(renderListResult(textResult(details), collapsed, taggedTheme, context()));
    expect(rows[1]).toBe(
      "<accent>t1</accent> <toolOutput>running</toolOutput><dim> · </dim><muted>1m 15s</muted><dim> · </dim><toolOutput>python3</toolOutput>",
    );
    expect(rows.join("\n")).not.toContain("/tmp/b1.log");
    const full = lines(renderListResult(textResult(details), expanded, taggedTheme, context()));
    expect(full.join("\n")).toContain("<muted>(log /tmp/b1.log)</muted>");
  });
});

describe("terminal_wait results", () => {
  const details: WaitResult = {
    reason: "exited",
    exited: [
      {
        id: "t1",
        kind: "terminal",
        command: "make",
        exit_code: 1,
        duration_ms: 65_000,
        output: "boom\nfailed",
      },
    ],
    running: [{ id: "b2", kind: "background_job", command: "sleep 100", age_seconds: 4 }],
  };

  test("lists what exited and what still runs, with exit output in the Expanded View", () => {
    const rows = lines(renderWaitResult(textResult(details), collapsed, taggedTheme, context()));
    expect(rows[1]).toBe(
      "<accent>t1</accent> <toolOutput>exited with code 1</toolOutput><dim> · </dim><muted>1m 5s</muted><dim> · </dim><toolOutput>make</toolOutput>",
    );
    expect(rows[2]).toContain("<accent>b2</accent> <toolOutput>running</toolOutput>");
    expect(rows.join("\n")).not.toContain("boom");
    const full = lines(renderWaitResult(textResult(details), expanded, taggedTheme, context()));
    expect(full).toContain("  <toolOutput>failed</toolOutput>");
  });
});
