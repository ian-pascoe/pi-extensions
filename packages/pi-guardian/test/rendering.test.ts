import { beforeAll, describe, expect, it } from "vite-plus/test";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
  taggedTheme,
} from "@ian-pascoe/pi-utils/ui-testing";
import {
  guardianFooterText,
  guardianStatusHeadline,
  renderReviewEntry,
  renderStatusEntry,
} from "../src/guardian-rendering.js";

// Line breaks and truncation match a real theme under the escape-encoded theme (its styles are not
// re-opened after a wrap); the text-tagged theme is for exact strings from functions that never wrap.
const theme = escapeTaggedTheme;
const tagged = taggedTheme;

beforeAll(() =>
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } })),
);

/** Render at 40 and 120 columns, proving both fit, and return the 120-column lines as tags. */
function lines(component: { render(width: number): string[] } | undefined): string[] {
  if (!component) throw new Error("Expected a component");
  for (const width of [40, 120]) expectLinesFitWidth(component.render(width), width);
  // Decode all lines together: pi-tui does not re-open the encoded styles on later lines.
  return readableTags(component.render(120).join("\n"))
    .split("\n")
    .map((line) => line.trimEnd());
}

const withoutTags = (text: string) => text.replace(/<\/?[A-Za-z:]+>/g, "");
const plain = (rendered: string[]) => withoutTags(rendered.join("\n")).trim();

const label = "<customMessageLabel><b>[guardian]</b></customMessageLabel>";
const hintPattern =
  /<muted>\.\.\. \((\d+) more lines,<\/muted> <dim>ctrl\+o<\/dim><muted> to expand<\/muted><muted>\)<\/muted>/;

const review = {
  version: 1,
  toolName: "bash",
  toolCallId: "c",
  parentToolCallId: null,
  arguments: '{"command":"rm -rf dist"}',
  argumentsSha256: "0".repeat(64),
  risk: "high",
  authorization: "low",
  result: "rejected",
  rationale: "Deletes build output the user did not mention.",
  failure: null,
  userOverride: false,
  blocked: true,
  model: "p/m",
  durationMs: 1_500,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  cost: null,
};
const allowed = {
  ...review,
  toolName: "deploy",
  risk: "low",
  authorization: "high",
  result: "allowed",
  rationale: null,
  blocked: false,
};

describe("Guardian review entries", () => {
  it("draws a rejection in Pi's custom-message box, labelled `[guardian] ✗ rejected`", () => {
    const rendered = lines(renderReviewEntry(review, false, theme));
    expect(rendered.every((line) => line.startsWith("<bg:customMessageBg>"))).toBe(true);
    const text = rendered.join("\n");
    expect(text).toContain(
      `${label} <error>✗</error> <customMessageText>rejected</customMessageText>`,
    );
    expect(text).toContain(
      "<b><customMessageText>bash</customMessageText></b><dim> · </dim><muted>risk high · authorization low</muted>",
    );
    expect(text).toContain(
      "<customMessageText>Deletes build output the user did not mention.</customMessageText>",
    );
  });

  it("collapses a long rationale to ten lines and counts what it hides", () => {
    const rationale = Array.from({ length: 14 }, (_, index) => `Reason ${index + 1}`).join("\n");
    const collapsed = lines(renderReviewEntry({ ...review, rationale }, false, theme));
    const text = collapsed.join("\n");
    // The label line holds the result, so the ten body lines are the subject and nine reasons.
    expect(text).toContain("Reason 9");
    expect(text).not.toContain("Reason 10");
    // Five hidden rationale lines, plus the arguments and statistics lines.
    expect(Number(hintPattern.exec(text)?.[1])).toBe(7);
    expect(lines(renderReviewEntry({ ...review, rationale }, true, theme)).join("\n")).toContain(
      "Reason 14",
    );
  });

  it("hides allowed reviews unless verbose, but always shows overrides, drift, and downgrades", () => {
    expect(renderReviewEntry(allowed, true, theme)).toBeUndefined();
    expect(renderReviewEntry({ ...allowed, result: "unused" }, true, theme)).toBeUndefined();
    expect(renderReviewEntry(allowed, false, theme, true)).toBeDefined();
    expect(renderReviewEntry({ ...allowed, userOverride: true }, false, theme)).toBeDefined();
    expect(renderReviewEntry({ ...allowed, argumentDrift: true }, false, theme)).toBeDefined();
    expect(renderReviewEntry({ ...allowed, downgraded: true }, false, theme)).toBeDefined();
  });

  it("shows an unrecognised record raw", () => {
    expect(lines(renderReviewEntry({ bogus: true }, false, theme)).join("\n")).toContain(
      "Guardian Review",
    );
  });
});

const settings = {
  enabled: true,
  model: "p/reviewer",
  thinkingLevel: "low",
  onDeny: "block",
};
const statusData = {
  state: "enabled",
  settings,
  sources: { enabled: "global", model: "session" },
  followsRoot: null,
  totals: {
    reviews: 2,
    allowed: 1,
    rejected: 1,
    failed: 0,
    aborted: 0,
    overrides: 0,
    drift: 0,
    cost: 0.0033,
    lastError: null,
  },
  error: null,
};

describe("Guardian status entries", () => {
  it("shows the on mark, model, and totals in Pi's custom-message box", () => {
    const rendered = lines(renderStatusEntry(statusData, false, theme));
    expect(rendered.every((line) => line.startsWith("<bg:customMessageBg>"))).toBe(true);
    const text = rendered.join("\n");
    expect(text).toContain(`${label} <accent>●</accent> <customMessageText>on</customMessageText>`);
    expect(plain(rendered)).toContain("2 reviews · 1 allowed · 1 rejected · 0 failed");
  });

  it("hints at every setting while collapsed and lists them with sources when expanded", () => {
    const collapsed = lines(renderStatusEntry(statusData, false, theme));
    const expanded = lines(renderStatusEntry(statusData, true, theme));
    expect(plain(collapsed)).not.toContain("maxConsecutiveRejections");
    expect(plain(expanded)).toMatch(/maxConsecutiveRejections\s+inherit\s+\[default\]/);
    expect(plain(expanded)).toMatch(/thinkingLevel\s+low\s+\[default\]/);
    expect(plain(expanded)).toMatch(/model\s+p\/reviewer\s+\[session\]/);
  });

  it("shows an unrecognised record raw", () => {
    expect(lines(renderStatusEntry({ other: 1 }, false, theme)).join("\n")).toContain('"other": 1');
  });

  it("heads the settings menu with a bold name and the state mark", () => {
    expect(guardianStatusHeadline({ state: "disabled" }, tagged)).toEqual([
      "<b>Guardian</b> <dim>○</dim> off",
    ]);
    expect(guardianStatusHeadline({ state: "error", error: "boom" }, tagged)).toEqual([
      "<b>Guardian</b> <error>✗</error> error",
      "<error>✗</error> <error>boom</error>",
    ]);
  });
});

describe("Guardian footer", () => {
  const mark = "<accent>●</accent> <dim>guardian</dim>";

  it("is absent while disabled", () => {
    expect(guardianFooterText(false, [], tagged)).toBeUndefined();
  });

  it("counts repeated tools under review", () => {
    expect(guardianFooterText(true, ["deploy", "deploy"], tagged)).toBe(
      `${mark} reviewing deploy ×2`,
    );
  });
});
