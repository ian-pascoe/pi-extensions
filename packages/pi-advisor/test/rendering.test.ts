import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  advisorFooterText,
  renderAdvisorAskCall,
  renderAdvisorAskResult,
  renderAdvisorChildEntry,
  renderAdvisorIntervention,
  renderAdvisorStatus,
  type AdvisorRenderTheme,
} from "../src/advisor-rendering.js";

const plainTheme: AdvisorRenderTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function lines(component: { render(width: number): string[] } | undefined): string[] {
  if (!component) throw new Error("Expected a component");
  return component.render(120).map((line) => stripVTControlCharacters(line).trimEnd());
}

beforeAll(() => initTheme("dark"));

const collapsed = { expanded: false, outputPad: 0 };
const longMessage = Array.from({ length: 7 }, (_, index) => `Line ${index + 1}`).join("\n\n");

describe("Advisor Interventions", () => {
  it("attributes each severity to the Advisor", () => {
    for (const severity of ["nit", "concern", "blocker"] as const) {
      const rendered = lines(
        renderAdvisorIntervention({ severity, message: "Run the tests" }, collapsed, plainTheme),
      );
      expect(rendered.join("\n")).toContain(`Advisor ${severity}`);
      expect(rendered.join("\n")).toContain("Run the tests");
    }
  });

  it("always shows Concerns and Blockers in full but collapses long Nits", () => {
    for (const severity of ["concern", "blocker"] as const) {
      const text = lines(
        renderAdvisorIntervention({ severity, message: longMessage }, collapsed, plainTheme),
      ).join("\n");
      expect(text).toContain("Line 7");
      expect(text).not.toContain("to expand");
    }
    const nit = lines(
      renderAdvisorIntervention({ severity: "nit", message: longMessage }, collapsed, plainTheme),
    ).join("\n");
    expect(nit).toContain("Line 1");
    expect(nit).not.toContain("Line 7");
    expect(nit).toContain("to expand");
    const expanded = lines(
      renderAdvisorIntervention(
        { severity: "nit", message: longMessage },
        { expanded: true, outputPad: 0 },
        plainTheme,
      ),
    ).join("\n");
    expect(expanded).toContain("Line 7");
  });

  it("labels Child Agent findings with their agent", () => {
    const text = lines(
      renderAdvisorIntervention(
        { severity: "concern", message: "Scope drift" },
        collapsed,
        plainTheme,
        "worker",
      ),
    ).join("\n");
    expect(text).toContain("Advisor concern");
    expect(text).toContain("↳ worker");
  });

  it("leaves unrecognised details to Pi's default rendering", () => {
    expect(
      renderAdvisorIntervention({ severity: "veto", message: "x" }, collapsed, plainTheme),
    ).toBeUndefined();
    expect(renderAdvisorIntervention(undefined, collapsed, plainTheme)).toBeUndefined();
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
const status = (data: StatusData, expanded = false) =>
  lines(renderAdvisorStatus(data, expanded, plainTheme)).join("\n");

describe("Advisor status", () => {
  it("summarizes state, model, backlog, usage, children, and problems when collapsed", () => {
    const text = status({ ...snapshot, error: "Model unavailable" });
    expect(text).toContain("Advisor \u25cf reviewing");
    expect(text).toContain("anthropic/claude-sonnet (inherited) \u00b7 high");
    expect(text).toContain("backlog 2");
    expect(text).toContain("tokens 41.2k \u00b7 cost $0.18 \u00b7 2 children");
    expect(text).toContain("\u26a0 unavailable tools: lsp_diagnostics");
    expect(text).toContain("\u2716 Model unavailable");
    expect(text).not.toContain("maxToolCalls");
  });

  it("never presents unknown cost as zero and omits empty problem lines", () => {
    const text = status({
      ...snapshot,
      cost: null,
      unavailableTools: [],
      children: [],
      settings: { ...settings, model: "openai/gpt" },
    });
    expect(text).toContain("tokens 41.2k \u00b7 cost unknown");
    expect(text).not.toContain("$0");
    expect(text).toContain("anthropic/claude-sonnet \u00b7 high");
    expect(text).not.toContain("(inherited)");
    expect(text).not.toContain("\u26a0");
    expect(text).not.toContain("\u2716");
    expect(text).not.toContain("children");
  });

  it("lists every setting with its source and each child when expanded", () => {
    const text = status(snapshot, true);
    expect(text).toMatch(/enabled\s+true\s+\[session\]/);
    expect(text).toMatch(/model\s+inherit\s+\[default\]/);
    expect(text).toMatch(/allowedTools\s+read, grep\s+\[project\]/);
    expect(text).toMatch(/catchUpThreshold\s+3\s+\[default\]/);
    expect(text).toMatch(/reviewTimeoutMs\s+120s\s+\[default\]/);
    expect(text).toMatch(
      /prompt\s+Review carefully for scope drift and un\u2026 \(69 chars\)\s+\[default\]/,
    );
    expect(text).not.toContain("Second line");
    expect(text).toMatch(/\u21b3 worker\s+\u25cf paused/);
    expect(text).toMatch(/\u21b3 scout\s+\u25cf reviewing\s+backlog 3/);
  });

  it("leads with the configuration changes that produced it", () => {
    expect(
      status({
        ...snapshot,
        changes: [
          { scope: "session", key: "model", options: { model: "openai/gpt" } },
          { scope: "project", key: "enabled", options: {} },
        ],
      }),
    ).toMatch(
      /^\u2713 model \u2192 openai\/gpt \[session\]\n\u2713 enabled \u2192 inherit \[project\]\n.*Advisor/,
    );
  });

  it("renders recognised fields from older or minimal entries", () => {
    const text = status({
      state: "private",
      error: "Private Advisor Sessions cannot create another Advisor",
    });
    expect(text).toContain("Advisor \u25cb private");
    expect(text).toContain("\u2716 Private Advisor Sessions cannot create another Advisor");
    expect(status({ state: "paused", error: "boom", usage: null, cost: null })).toContain(
      "\u2716 boom",
    );
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
    expect(text).toContain("Advisor \u25cf reviewing");
    expect(text).toContain("anthropic/claude-sonnet");
    expect(text).toContain("tokens 41.2k \u00b7 cost $0.18");
    expect(text).toContain("\u26a0 unavailable tools: lsp_diagnostics");
    expect(text).not.toContain("retiredOption");
    expect(text).not.toContain("children");
  });

  it("falls back to the raw record when even the state is missing", () => {
    expect(status({ unexpected: 1 })).toContain('"unexpected": 1');
  });
});

describe("Child Agent Advisor entries", () => {
  it("render findings as labelled Interventions", () => {
    const text = lines(
      renderAdvisorChildEntry(
        { agentId: "worker", severity: "blocker", message: "Stop editing tests" },
        false,
        plainTheme,
      ),
    ).join("\n");
    expect(text).toContain("Advisor blocker");
    expect(text).toContain("\u21b3 worker");
    expect(text).toContain("Stop editing tests");
  });

  it("render a paused child as an error line", () => {
    expect(
      lines(
        renderAdvisorChildEntry(
          { agentId: "worker", state: "paused", error: "Deadline exceeded" },
          false,
          plainTheme,
        ),
      ),
    ).toEqual(["\u2716 Advisor \u21b3 worker paused: Deadline exceeded"]);
  });

  it("fall back to the raw record when unrecognised", () => {
    expect(lines(renderAdvisorChildEntry({ other: true }, false, plainTheme)).join("\n")).toContain(
      '"other": true',
    );
  });
});

describe("advisor_ask rendering", () => {
  const question = "Is this migration safe?\nConsider the rollback path.";
  const answer = Array.from({ length: 12 }, (_, index) => `- Point ${index + 1}`).join("\n");

  it("shows the question, first line only while collapsed", () => {
    expect(lines(renderAdvisorAskCall({ message: question }, false, plainTheme))).toEqual([
      "Ask Advisor Is this migration safe?",
    ]);
    expect(
      lines(renderAdvisorAskCall({ message: question }, true, plainTheme)).join("\n"),
    ).toContain("Consider the rollback path.");
  });

  it("previews the answer while collapsed and shows it all when expanded", () => {
    const preview = lines(
      renderAdvisorAskResult(
        answer,
        { expanded: false, isPartial: false, isError: false },
        plainTheme,
      ),
    ).join("\n");
    expect(preview).toContain("Point 1");
    expect(preview).not.toContain("Point 12");
    expect(preview).toContain("to expand");
    const full = lines(
      renderAdvisorAskResult(
        answer,
        { expanded: true, isPartial: false, isError: false },
        plainTheme,
      ),
    ).join("\n");
    expect(full).toContain("Point 12");
  });

  it("shows progress and errors plainly", () => {
    expect(
      lines(
        renderAdvisorAskResult(
          "",
          { expanded: false, isPartial: true, isError: false },
          plainTheme,
        ),
      ),
    ).toEqual(["Consulting\u2026"]);
    expect(
      lines(
        renderAdvisorAskResult(
          "Advisor is disabled",
          { expanded: false, isPartial: false, isError: true },
          plainTheme,
        ),
      ),
    ).toEqual(["Advisor is disabled"]);
  });
});

describe("Advisor footer", () => {
  it("is absent while the Advisor is disabled", () => {
    expect(advisorFooterText({ state: "disabled", backlog: 0 }, [], plainTheme)).toBeUndefined();
    expect(advisorFooterText(undefined, [], plainTheme)).toBeUndefined();
  });

  it("stays quiet while armed and reports review progress", () => {
    expect(advisorFooterText({ state: "armed", backlog: 0 }, [], plainTheme)).toBe("advisor");
    expect(advisorFooterText({ state: "armed", backlog: 1 }, [], plainTheme)).toBe("advisor");
    expect(advisorFooterText({ state: "reviewing", backlog: 2 }, [], plainTheme)).toBe(
      "advisor: reviewing · backlog 2",
    );
    expect(advisorFooterText({ state: "consulting", backlog: 0 }, [], plainTheme)).toBe(
      "advisor: consulting",
    );
  });

  it("reports a pause without its reason", () => {
    expect(advisorFooterText({ state: "paused", backlog: 3 }, [], plainTheme)).toBe(
      "advisor: paused",
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
        plainTheme,
      ),
    ).toBe("advisor");
    expect(
      advisorFooterText(
        { state: "reviewing", backlog: 1 },
        [
          { state: "reviewing", backlog: 4 },
          { state: "paused", backlog: 0 },
          { state: "paused", backlog: 0 },
        ],
        plainTheme,
      ),
    ).toBe("advisor: reviewing · backlog 1 · 1 child reviewing · 2 children paused");
  });
});
