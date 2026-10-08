import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import type { DurationContext } from "@ian-pascoe/pi-utils/ui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
  taggedTheme,
} from "@ian-pascoe/pi-utils/ui-testing";
import {
  advisorFooterText,
  advisorStatusHeadline,
  renderAdvisorAskCall,
  renderAdvisorAskResult,
  renderAdvisorChildEntry,
  renderAdvisorIntervention,
  renderAdvisorStatus,
} from "../src/advisor-rendering.js";

// Components wrap and truncate at real widths under the escape-encoded theme; the text-tagged
// theme is for exact strings from functions that never wrap.
const theme = escapeTaggedTheme;
const tagged = taggedTheme;

beforeAll(() => {
  initTheme("dark");
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

afterEach(() => vi.useRealTimers());

/**
 * Render at 40 and 120 columns, proving both fit (Markdown bodies follow Pi's global theme), and
 * return the 120-column lines as readable tags.
 */
function lines(component: { render(width: number): string[] } | undefined): string[] {
  if (!component) throw new Error("Expected a component");
  for (const width of [40, 120])
    expectLinesFitWidth(component.render(width), width, { piThemedBody: true });
  // Decode all lines together: pi-tui does not re-open the encoded styles on later lines.
  const rendered = component.render(120);
  if (rendered.length === 0) return [];
  return readableTags(rendered.join("\n"))
    .split("\n")
    .map((line) => line.trimEnd());
}

const withoutTags = (text: string) => text.replace(/<\/?[A-Za-z:]+>/g, "");
const plainText = (rendered: string[]) => withoutTags(rendered.join("\n")).trim();

const label = "<customMessageLabel><b>Advisor</b></customMessageLabel>";
const hintPattern =
  /<muted>\.\.\. \((\d+) more lines,<\/muted> <dim>ctrl\+o<\/dim><muted> to expand<\/muted><muted>\)<\/muted>/;

function durationContext(overrides: Partial<DurationContext> = {}): DurationContext {
  return {
    state: {},
    executionStarted: false,
    isPartial: false,
    durationMs: undefined,
    invalidate: () => {},
    ...overrides,
  };
}

const collapsed = { expanded: false, outputPad: 1 };
const longMessage = Array.from({ length: 14 }, (_, index) => `Line ${index + 1}`).join("\n\n");

describe("Advisor Interventions", () => {
  it("labels each severity with a coloured word, never a glyph", () => {
    const colors = { nit: "dim", concern: "warning", blocker: "error" } as const;
    for (const severity of ["nit", "concern", "blocker"] as const) {
      const rendered = lines(
        renderAdvisorIntervention({ severity, message: "Run the tests" }, collapsed, theme),
      ).join("\n");
      expect(rendered).toContain(`${label} <${colors[severity]}>${severity}</${colors[severity]}>`);
      expect(rendered).toContain("Run the tests");
      expect(rendered).not.toMatch(/[▲✖]/);
    }
  });

  it("draws Pi's custom-message box with the configured output padding", () => {
    const rendered = lines(
      renderAdvisorIntervention(
        { severity: "concern", message: "Run the tests" },
        { expanded: false, outputPad: 3 },
        theme,
      ),
    );
    expect(rendered.every((line) => line.startsWith("<bg:customMessageBg>"))).toBe(true);
    expect(withoutTags(rendered[1] ?? "").trimEnd()).toBe(`   ${withoutTags(`${label} concern`)}`);
  });

  it("always shows Concerns and Blockers in full but collapses long Nits to ten lines", () => {
    for (const severity of ["concern", "blocker"] as const) {
      const text = lines(
        renderAdvisorIntervention({ severity, message: longMessage }, collapsed, theme),
      ).join("\n");
      expect(text).toContain("Line 14");
      expect(text).not.toContain("to expand");
    }
    const nit = lines(
      renderAdvisorIntervention({ severity: "nit", message: longMessage }, collapsed, theme),
    );
    const nitText = nit.join("\n");
    expect(nitText).toContain("Line 1");
    expect(nitText).not.toContain("Line 14");
    const hidden = Number(hintPattern.exec(nitText)?.[1]);
    const expanded = lines(
      renderAdvisorIntervention(
        { severity: "nit", message: longMessage },
        { expanded: true, outputPad: 1 },
        theme,
      ),
    );
    expect(expanded.join("\n")).toContain("Line 14");
    expect(expanded.join("\n")).not.toContain("to expand");
    // Header, spacer, ten body lines, and the hint, inside one row of padding top and bottom.
    expect(nit).toHaveLength(2 + 1 + 1 + 10 + 1);
    expect(expanded).toHaveLength(nit.length - 1 + hidden);
  });

  it("labels Child Agent findings with their agent", () => {
    const text = lines(
      renderAdvisorIntervention(
        { severity: "concern", message: "Scope drift" },
        collapsed,
        theme,
        "worker",
      ),
    ).join("\n");
    expect(text).toContain(
      `${label} <warning>concern</warning><dim> · </dim><accent>worker</accent>`,
    );
  });

  it("leaves unrecognised details to Pi's default rendering", () => {
    expect(
      renderAdvisorIntervention({ severity: "veto", message: "x" }, collapsed, theme),
    ).toBeUndefined();
    expect(renderAdvisorIntervention(undefined, collapsed, theme)).toBeUndefined();
  });
});

const settings = {
  enabled: true,
  includeSubagents: true,
  prompt: "Review carefully for scope drift and unsupported claims.\nSecond line.",
  allowedTools: ["read", "grep"],
  catchUpThreshold: 3,
  reviewTimeoutMs: 120_000,
  maxToolCalls: 8,
  maxCorrectiveTurns: 1,
  maxFindingsPerReview: 4,
  maxNitsPerRequest: 3,
  seedBudgetTokens: "auto",
  reviewEvery: "turn",
  maxSessionTokens: "auto",
};
const snapshot = {
  state: "reviewing",
  settings,
  sources: {
    enabled: "session",
    includeSubagents: "global",
    prompt: "default",
    model: "default",
    thinkingLevel: "default",
    allowedTools: "project",
    catchUpThreshold: "default",
    reviewTimeoutMs: "default",
    maxToolCalls: "default",
    maxCorrectiveTurns: "default",
    maxFindingsPerReview: "default",
    maxNitsPerRequest: "default",
    seedBudgetTokens: "default",
    reviewEvery: "default",
    maxSessionTokens: "default",
  },
  backlog: 2,
  effectiveModel: "anthropic/claude-sonnet",
  effectiveThinkingLevel: "high",
  usage: { input: 40_000, output: 1_200, cacheRead: 0, cacheWrite: 0, total: 41_200 },
  cost: 0.18,
  lastError: null,
  unavailableTools: ["lsp_diagnostics"],
  children: [
    { agentId: "worker", state: "paused", backlog: 0 },
    { agentId: "scout", state: "reviewing", backlog: 3 },
  ],
  error: null,
};
type StatusData = Parameters<typeof renderAdvisorStatus>[0];
const statusLines = (data: StatusData, expanded = false) =>
  lines(renderAdvisorStatus(data, expanded, theme));
const status = (data: StatusData, expanded = false) => plainText(statusLines(data, expanded));

describe("Advisor status", () => {
  it("draws the label and state mark in Pi's custom-message box", () => {
    const rendered = statusLines(snapshot);
    expect(rendered.every((line) => line.startsWith("<bg:customMessageBg>"))).toBe(true);
    expect(rendered.join("\n")).toContain(
      `${label} <accent>●</accent> <customMessageText>reviewing</customMessageText>`,
    );
  });

  it("summarizes state, model, backlog, usage, children, and problems when collapsed", () => {
    const text = status({ ...snapshot, error: "Model unavailable" });
    expect(text).toContain("Advisor ● reviewing");
    expect(text).toContain("anthropic/claude-sonnet (inherited) · high");
    expect(text).toContain("backlog 2");
    expect(text).toContain("tokens 41.2k · cost $0.18 · 2 children");
    expect(text).toContain("! unavailable tools: lsp_diagnostics");
    expect(text).toContain("✗ Model unavailable");
    expect(text).not.toContain("maxToolCalls");
    expect(statusLines({ ...snapshot, error: "Model unavailable" }).join("\n")).toContain(
      "<error>✗</error> <error>Model unavailable</error>",
    );
  });

  it("hints at what the Collapsed View hides, and the Expanded View shows it without a hint", () => {
    const collapsedLines = statusLines(snapshot);
    const expandedLines = statusLines(snapshot, true);
    const hidden = Number(hintPattern.exec(collapsedLines.join("\n"))?.[1]);
    expect(hidden).toBeGreaterThan(0);
    expect(expandedLines).toHaveLength(collapsedLines.length - 1 + hidden);
    expect(expandedLines.join("\n")).not.toContain("to expand");
  });

  it("shows the last Review's cost and the running total across Reviews", () => {
    const text = status({ ...snapshot, reviewCost: { reviews: 3, last: 0.0045, total: 0.0123 } });
    expect(text).toContain("3 Reviews $0.01 · last Review $0.0045");
    expect(status({ ...snapshot, reviewCost: { reviews: 1, last: 0.25, total: 0.25 } })).toContain(
      "1 Review $0.25 · last Review $0.25",
    );
    expect(status({ ...snapshot, reviewCost: { reviews: 2, last: null, total: null } })).toContain(
      "2 Reviews cost unknown · last Review cost unknown",
    );
    expect(status({ ...snapshot, reviewCost: null })).not.toContain("Review $");
  });

  it("shows each Child Agent's Review cost when expanded", () => {
    const text = status(
      {
        ...snapshot,
        children: [
          {
            agentId: "worker",
            state: "armed",
            backlog: 0,
            reviewCost: { reviews: 2, last: 0.02, total: 0.05 },
          },
        ],
      },
      true,
    );
    expect(text).toMatch(/└─ worker\s+● armed\s+2 Reviews \$0\.05 · last Review \$0\.02/);
  });

  it("counts findings awaiting re-validation and findings dropped, only when there are any", () => {
    const text = status({
      ...snapshot,
      deferredFindings: 2,
      droppedFindings: { overNitCap: 1, unsupported: 3, superseded: 2, invalidReviews: 1 },
    });
    for (const count of [
      "2 findings awaiting re-validation",
      "1 Nit over the request cap dropped",
      "3 findings without valid evidence dropped",
      "2 Nits from a superseded re-validating Review dropped",
      "1 Review ended by invalid reports",
    ])
      expect(text.replace(/\s+/g, " ")).toContain(count);
    expect(
      status({
        ...snapshot,
        deferredFindings: 0,
        droppedFindings: { overNitCap: 4, unsupported: 0 },
      }),
    ).toContain("dropped");
    const quiet = status({
      ...snapshot,
      deferredFindings: 0,
      droppedFindings: { overNitCap: 0, unsupported: 0 },
    });
    expect(quiet).not.toContain("re-validation");
    expect(quiet).not.toContain("dropped");
  });

  it("never presents unknown cost as zero and omits empty problem lines", () => {
    const text = status({
      ...snapshot,
      cost: null,
      unavailableTools: [],
      children: [],
      settings: { ...settings, model: "openai/gpt" },
    });
    expect(text).toContain("tokens 41.2k · cost unknown");
    expect(text).not.toContain("$0");
    expect(text).toContain("anthropic/claude-sonnet · high");
    expect(text).not.toContain("(inherited)");
    expect(text).not.toContain("!");
    expect(text).not.toContain("✗");
    expect(text).not.toContain("children");
  });

  it("lists every setting with its source and each child as a tree when expanded", () => {
    const text = status(snapshot, true);
    expect(text).toMatch(/enabled\s+true\s+\[session\]/);
    expect(text).toMatch(/model\s+inherit\s+\[default\]/);
    expect(text).toMatch(/allowedTools\s+read, grep\s+\[project\]/);
    expect(text).toMatch(/catchUpThreshold\s+3\s+\[default\]/);
    expect(text).toMatch(/reviewTimeoutMs\s+120s\s+\[default\]/);
    expect(text).toMatch(/seedBudgetTokens\s+auto\s+\[default\]/);
    expect(text).toMatch(
      /prompt\s+Review carefully for scope drift and \.\.\. \(69 chars\)\s+\[default\]/,
    );
    expect(text).not.toContain("Second line");
    expect(text).toMatch(/├─ worker\s+! paused/);
    expect(text).toMatch(/└─ scout\s+● reviewing\s+backlog 3/);
  });

  it("leads with the state, then the configuration changes that produced it", () => {
    expect(
      status({
        ...snapshot,
        changes: [
          { scope: "session", key: "model", options: { model: "openai/gpt" } },
          { scope: "project", key: "enabled", options: {} },
        ],
      }),
    ).toMatch(
      /^Advisor ● reviewing.*\n\s*✓ model → openai\/gpt \[session\]\s*\n\s*✓ enabled → inherit \[project\]\s*\n/,
    );
  });

  it("renders recognised fields from older or minimal entries", () => {
    const text = status({
      state: "private",
      error: "Private Advisor Sessions cannot create another Advisor",
    });
    expect(text).toContain("Advisor ○ private");
    expect(text).toContain("✗ Private Advisor Sessions cannot create another Advisor");
    expect(status({ state: "paused", error: "boom", usage: null, cost: null })).toContain("✗ boom");
  });

  it("keeps every recognisable field when one field no longer matches", () => {
    const text = status(
      {
        ...snapshot,
        settings: { ...settings, retiredOption: true },
        children: "not a list",
      },
      true,
    );
    expect(text).toContain("Advisor ● reviewing");
    expect(text).toContain("anthropic/claude-sonnet");
    expect(text).toContain("tokens 41.2k · cost $0.18");
    expect(text).toContain("! unavailable tools: lsp_diagnostics");
    expect(text).not.toContain("retiredOption");
    expect(text).not.toContain("children");
  });

  it("falls back to the raw record when even the state is missing", () => {
    expect(status({ unexpected: 1 })).toContain('"unexpected": 1');
  });

  it("heads the settings menu with a bold name, the state mark, and the error", () => {
    expect(advisorStatusHeadline({ state: "paused", error: "Deadline exceeded" }, tagged)).toEqual([
      "<b>Advisor</b> <warning>!</warning> paused",
      "<error>✗</error> <error>Deadline exceeded</error>",
    ]);
  });
});

describe("Child Agent Advisor entries", () => {
  it("render findings as labelled Interventions", () => {
    const text = lines(
      renderAdvisorChildEntry(
        { agentId: "worker", severity: "blocker", message: "Stop editing tests" },
        false,
        theme,
      ),
    ).join("\n");
    expect(text).toContain(`${label} <error>blocker</error><dim> · </dim><accent>worker</accent>`);
    expect(text).toContain("Stop editing tests");
  });

  it("render a paused child with its agent, a warning mark, and the error", () => {
    const rendered = lines(
      renderAdvisorChildEntry(
        { agentId: "worker", state: "paused", error: "Deadline exceeded" },
        false,
        theme,
      ),
    );
    expect(rendered.every((line) => line.startsWith("<bg:customMessageBg>"))).toBe(true);
    const text = rendered.join("\n");
    expect(text).toContain(
      `${label}<dim> · </dim><accent>worker</accent><dim> · </dim><warning>!</warning> <customMessageText>paused</customMessageText>`,
    );
    expect(text).toContain("<error>Deadline exceeded</error>");
  });

  it("fall back to the raw record when unrecognised", () => {
    expect(lines(renderAdvisorChildEntry({ other: true }, false, theme)).join("\n")).toContain(
      '"other": true',
    );
  });
});

describe("advisor_ask rendering", () => {
  const question = "Is this migration safe?\nConsider the rollback path.";
  const answer = Array.from({ length: 12 }, (_, index) => `- Point ${index + 1}`).join("\n");
  const header = "<toolTitle><b>advisor_ask</b></toolTitle>";
  const resultOptions = { expanded: false, isPartial: false, isError: false };

  it("heads the call with the lowercase tool name and the question's first line", () => {
    expect(
      lines(renderAdvisorAskCall({ message: question }, false, theme, durationContext())),
    ).toEqual([`${header} <accent>Is this migration safe?</accent><dim> (ctrl+o to expand)</dim>`]);
    expect(
      lines(renderAdvisorAskCall({ message: "Is this safe?" }, false, theme, durationContext())),
    ).toEqual([`${header} <accent>Is this safe?</accent>`]);
  });

  it("lists the whole question as an argument when expanded, without a hint", () => {
    const rendered = lines(
      renderAdvisorAskCall({ message: question }, true, theme, durationContext()),
    );
    expect(rendered).toEqual([
      header,
      "<muted>message: Is this migration safe?",
      "Consider the rollback path.</muted>",
    ]);
  });

  it("shows Elapsed under the call while it runs, from the call row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const context = durationContext({ executionStarted: true, isPartial: true });
    const component = renderAdvisorAskCall({ message: "Is this safe?" }, false, theme, context);
    vi.advanceTimersByTime(2500);
    expect(lines(component).at(-1)).toBe("<muted>Elapsed 2.5s</muted>");
  });

  it("previews the answer to ten lines with Pi's Expand Hint, then shows it all when expanded", () => {
    const preview = lines(
      renderAdvisorAskResult(answer, resultOptions, theme, durationContext({ durationMs: 1234 })),
    );
    const previewText = preview.join("\n");
    expect(previewText).toContain("Point 1");
    expect(previewText).toContain("Point 10");
    expect(previewText).not.toContain("Point 11");
    expect(previewText).toContain(
      "<muted>... (2 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );
    const full = lines(
      renderAdvisorAskResult(
        answer,
        { ...resultOptions, expanded: true },
        theme,
        durationContext({ durationMs: 1234 }),
      ),
    ).join("\n");
    expect(full).toContain("Point 12");
    expect(full).not.toContain("to expand");
  });

  it("ends the result with Pi's Took footer from the recorded duration", () => {
    const rendered = lines(
      renderAdvisorAskResult(answer, resultOptions, theme, durationContext({ durationMs: 1234 })),
    );
    expect(rendered.at(-1)).toBe("<muted>Took 1.2s</muted>");
  });

  it("shows no placeholder while there is nothing to show", () => {
    expect(
      lines(
        renderAdvisorAskResult(
          "",
          { expanded: false, isPartial: true, isError: false },
          theme,
          durationContext(),
        ),
      ),
    ).toEqual([]);
  });

  it("shows errors as error text, ten lines when collapsed", () => {
    const failure = Array.from({ length: 12 }, (_, index) => `Failure ${index + 1}`).join("\n");
    const context = () => durationContext({ durationMs: 50 });
    const brief = lines(
      renderAdvisorAskResult(
        "Advisor is disabled",
        { ...resultOptions, isError: true },
        theme,
        context(),
      ),
    );
    expect(brief).toContain("<error>Advisor is disabled</error>");
    const long = lines(
      renderAdvisorAskResult(failure, { ...resultOptions, isError: true }, theme, context()),
    ).join("\n");
    expect(long).toContain("<error>Failure 10</error>");
    expect(long).not.toContain("Failure 11");
    expect(long).toContain("<muted>... (2 more lines,</muted>");
    const expanded = lines(
      renderAdvisorAskResult(
        failure,
        { ...resultOptions, isError: true, expanded: true },
        theme,
        context(),
      ),
    ).join("\n");
    expect(expanded).toContain("<error>Failure 12</error>");
    expect(expanded).not.toContain("to expand");
  });
});

describe("Advisor footer", () => {
  const mark = "<accent>●</accent> <dim>advisor</dim>";

  it("is absent while the Advisor is disabled", () => {
    expect(advisorFooterText({ state: "disabled", backlog: 0 }, [], tagged)).toBeUndefined();
    expect(advisorFooterText(undefined, [], tagged)).toBeUndefined();
  });

  it("shows the state while armed and reports review progress", () => {
    expect(advisorFooterText({ state: "armed", backlog: 0 }, [], tagged)).toBe(`${mark} armed`);
    expect(advisorFooterText({ state: "armed", backlog: 1 }, [], tagged)).toBe(`${mark} armed`);
    expect(advisorFooterText({ state: "reviewing", backlog: 2 }, [], tagged)).toBe(
      `${mark} reviewing<dim> · </dim>backlog 2`,
    );
    expect(advisorFooterText({ state: "consulting", backlog: 0 }, [], tagged)).toBe(
      `${mark} consulting`,
    );
  });

  it("reports a pause without its reason", () => {
    expect(advisorFooterText({ state: "paused", backlog: 3 }, [], tagged)).toBe(
      "<warning>!</warning> <dim>advisor</dim> <warning>paused</warning>",
    );
  });

  it("adds Child Agent activity only when a child is reviewing or paused", () => {
    expect(
      advisorFooterText(
        { state: "armed", backlog: 0 },
        [
          { state: "armed", backlog: 0 },
          { state: "disabled", backlog: 0 },
          { state: "consulting", backlog: 0 },
        ],
        tagged,
      ),
    ).toBe(`${mark} armed`);
    expect(
      advisorFooterText(
        { state: "reviewing", backlog: 1 },
        [
          { state: "reviewing", backlog: 4 },
          { state: "paused", backlog: 0 },
          { state: "paused", backlog: 0 },
        ],
        tagged,
      ),
    ).toBe(
      `${mark} reviewing<dim> · </dim>backlog 1<dim> · </dim>1 child reviewing<dim> · </dim><warning>2 children paused</warning>`,
    );
  });
});
