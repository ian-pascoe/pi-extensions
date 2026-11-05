import { describe, expect, test } from "vitest";
import {
  buildSubagentModelCatalogue,
  suggestSubagentModelReferences,
  transformSubagentModelReferences,
} from "../src/minimal-subagents-model-references.js";

const modelLink = (typed: string, model: string): string =>
  `[%${typed}](model://${model} "Subagent model: model=${model}")`;
const roleLink = (role: string): string =>
  `[%${role}](model-role://${role} "Subagent model role: role=${role}")`;

const catalogue = buildSubagentModelCatalogue({
  eligibleModelIds: ["anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5"],
  models: [],
  modelRoles: [],
});

describe("Subagent Model Reference completion", () => {
  const popup = buildSubagentModelCatalogue({
    eligibleModelIds: [
      "opencode-go/kimi-k3",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-haiku-5-5",
      "openai/gpt-6",
    ],
    models: [
      { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
      { provider: "openai", id: "gpt-6", name: "GPT-6" },
      { provider: "other", id: "unlisted", name: "Not eligible" },
    ],
    modelRoles: [
      { name: "small", model: "anthropic/claude-haiku-5-5" },
      {
        name: "design",
        model: "opencode-go/kimi-k3",
        thinkingLevel: "high",
        hint: "UI design, visual critique",
      },
    ],
  });

  test("lists roles first, then models, each alphabetical, inserting a name that converts", () => {
    expect(suggestSubagentModelReferences(popup, "")).toEqual([
      {
        value: "%design",
        label: "%design",
        description:
          "Subagent role \u00b7 opencode-go/kimi-k3:high \u00b7 UI design, visual critique",
      },
      {
        value: "%small",
        label: "%small",
        description: "Subagent role \u00b7 anthropic/claude-haiku-5-5",
      },
      {
        value: "%anthropic/claude-haiku-5-5",
        label: "%anthropic/claude-haiku-5-5",
        description: "Subagent model \u00b7 Claude Haiku 5.5",
      },
      {
        value: "%anthropic/claude-opus-5-5",
        label: "%anthropic/claude-opus-5-5",
        description: "Subagent model \u00b7 Claude Opus 5.5",
      },
      {
        value: "%openai/gpt-6",
        label: "%openai/gpt-6",
        description: "Subagent model \u00b7 GPT-6",
      },
      {
        value: "%opencode-go/kimi-k3",
        label: "%opencode-go/kimi-k3",
        description: "Subagent model",
      },
    ]);
  });

  test("filters case-insensitively by role name, provider/id, and display name", () => {
    const values = (query: string) =>
      suggestSubagentModelReferences(popup, query).map((item) => item.value);
    expect(values("OPUS")).toEqual(["%anthropic/claude-opus-5-5"]);
    expect(values("haiku 5.5")).toEqual(["%anthropic/claude-haiku-5-5"]);
    expect(values("open")).toEqual(["%openai/gpt-6", "%opencode-go/kimi-k3"]);
    expect(values("s")).toEqual(["%small", "%design", "%anthropic/claude-opus-5-5"]);
    expect(values("claude")).toEqual(["%anthropic/claude-haiku-5-5", "%anthropic/claude-opus-5-5"]);
    expect(values("kimi")).toEqual(["%opencode-go/kimi-k3"]);
    expect(values("visual")).toEqual([]);
  });
});

describe("Subagent Model References", () => {
  test("converts a full provider/id to a model link", () => {
    expect(
      transformSubagentModelReferences("Review with %anthropic/claude-opus-5-5 please.", catalogue),
    ).toBe(
      `Review with ${modelLink("anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5")} please.`,
    );
  });

  test("converts a bare id that exactly one Eligible Model has", () => {
    const shared = buildSubagentModelCatalogue({
      eligibleModelIds: [
        "anthropic/claude-opus-5-5",
        "anthropic/claude-haiku-5-5",
        "opencode-go/claude-haiku-5-5",
      ],
      models: [],
      modelRoles: [],
    });
    expect(transformSubagentModelReferences("Use %claude-opus-5-5.", shared)).toBe(
      `Use ${modelLink("claude-opus-5-5", "anthropic/claude-opus-5-5")}.`,
    );
    expect(transformSubagentModelReferences("Use %claude-haiku-5-5.", shared)).toBe(
      "Use %claude-haiku-5-5.",
    );
  });

  test("prefers a full id over another provider's bare id that spells the same text", () => {
    const colliding = buildSubagentModelCatalogue({
      eligibleModelIds: ["openrouter/anthropic/claude-fable-5", "anthropic/claude-fable-5"],
      models: [],
      modelRoles: [],
    });
    expect(transformSubagentModelReferences("%anthropic/claude-fable-5", colliding)).toBe(
      modelLink("anthropic/claude-fable-5", "anthropic/claude-fable-5"),
    );
    expect(
      transformSubagentModelReferences("%openrouter/anthropic/claude-fable-5", colliding),
    ).toBe(modelLink("openrouter/anthropic/claude-fable-5", "openrouter/anthropic/claude-fable-5"));
    expect(transformSubagentModelReferences("%claude-fable-5", colliding)).toBe(
      modelLink("claude-fable-5", "anthropic/claude-fable-5"),
    );
  });

  test("converts after sentence punctuation and leaves look-alike text literal", () => {
    const roles = buildSubagentModelCatalogue({
      eligibleModelIds: ["anthropic/claude-opus-5-5", "local/PATH", "local/s"],
      models: [],
      modelRoles: [{ name: "large", model: "anthropic/claude-opus-5-5" }],
    });
    const large = roleLink("large");
    for (const [input, output] of [
      ["(%large)", `(${large})`],
      ["%large's plan", `${large}'s plan`],
      ["%large: review this", `${large}: review this`],
      ["Use %large.", `Use ${large}.`],
      ["%large:high", "%large:high"],
      ["%large@x", "%large@x"],
      ["%large~foo", "%large~foo"],
      ["%large/x", "%large/x"],
      ["%large-ish", "%large-ish"],
      ["%large.json", "%large.json"],
      ["50%large", "50%large"],
      ["%PATH%", "%PATH%"],
      ["printf %s", `printf ${modelLink("s", "local/s")}`],
      ["a%20b", "a%20b"],
      ["\\%large", "\\%large"],
      ["`%large`", "`%large`"],
      ["```\n%large\n```", "```\n%large\n```"],
      ["%Large", "%Large"],
      ["100% done", "100% done"],
    ] as const) {
      expect(transformSubagentModelReferences(input, roles), input).toBe(output);
    }
  });

  test("leaves converted links unchanged when submitted again", () => {
    const roles = buildSubagentModelCatalogue({
      eligibleModelIds: ["anthropic/claude-opus-5-5"],
      models: [],
      modelRoles: [{ name: "large", model: "anthropic/claude-opus-5-5" }],
    });
    const once = transformSubagentModelReferences(
      "Compare %large with %claude-opus-5-5 and %anthropic/claude-opus-5-5.",
      roles,
    );
    expect(once).toBe(
      `Compare ${roleLink("large")} with ${modelLink("claude-opus-5-5", "anthropic/claude-opus-5-5")} and ${modelLink("anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5")}.`,
    );
    expect(transformSubagentModelReferences(once, roles)).toBe(once);
  });

  test("converts both ids that start with a tilde on one line", () => {
    const tilde = buildSubagentModelCatalogue({
      eligibleModelIds: [
        "openrouter/~anthropic/claude-fable-latest",
        "openrouter/~openai/gpt-latest",
      ],
      models: [],
      modelRoles: [],
    });
    // Single tildes do not pair into GFM strikethrough here, so both stay in one Prose Span.
    expect(
      transformSubagentModelReferences(
        "Try %~anthropic/claude-fable-latest or %~openai/gpt-latest.",
        tilde,
      ),
    ).toBe(
      `Try ${modelLink("~anthropic/claude-fable-latest", "openrouter/~anthropic/claude-fable-latest")} or ${modelLink("~openai/gpt-latest", "openrouter/~openai/gpt-latest")}.`,
    );
  });

  test("converts a Model Role, which outranks a bare id but not a full id", () => {
    const withRoles = buildSubagentModelCatalogue({
      eligibleModelIds: ["anthropic/claude-opus-5-5", "local/large"],
      models: [],
      modelRoles: [
        { name: "large", model: "anthropic/claude-opus-5-5", thinkingLevel: "high" },
        { name: "anthropic/claude-opus-5-5", model: "local/large" },
      ],
    });
    expect(transformSubagentModelReferences("Plan with %large.", withRoles)).toBe(
      `Plan with ${roleLink("large")}.`,
    );
    expect(transformSubagentModelReferences("%anthropic/claude-opus-5-5", withRoles)).toBe(
      modelLink("anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"),
    );
    expect(withRoles.roles.map((role) => role.name)).toEqual(["large"]);
  });

  test("leaves out names a link cannot carry verbatim and roles that cannot be typed", () => {
    const unsafe = buildSubagentModelCatalogue({
      eligibleModelIds: [
        "custom/my model",
        "custom/a(b)",
        'custom/q"x',
        "custom/trailing-",
        "cloudflare-workers-ai/@cf/meta/llama-3.1-8b",
        "openrouter/~anthropic/claude-fable-latest",
        "amazon-bedrock/amazon.nova-2-lite-v1:0",
      ],
      models: [],
      modelRoles: [
        { name: "UI design", model: "custom/trailing-" },
        { name: "-dash", model: "custom/trailing-" },
        { name: "fast", model: "custom/trailing-" },
      ],
    });
    expect(unsafe.models.map(({ model }) => model)).toEqual([
      "cloudflare-workers-ai/@cf/meta/llama-3.1-8b",
      "openrouter/~anthropic/claude-fable-latest",
      "amazon-bedrock/amazon.nova-2-lite-v1:0",
    ]);
    expect(unsafe.roles.map((role) => role.name)).toEqual(["fast"]);
    // A bare id shared with a left-out model is still ambiguous.
    const shared = buildSubagentModelCatalogue({
      eligibleModelIds: ["anthropic/claude-opus-5-5", "my proxy/claude-opus-5-5"],
      models: [],
      modelRoles: [],
    });
    expect(transformSubagentModelReferences("%claude-opus-5-5", shared)).toBe("%claude-opus-5-5");
    expect(transformSubagentModelReferences("%my model", unsafe)).toBe("%my model");
    expect(transformSubagentModelReferences("Use %amazon.nova-2-lite-v1:0 now", unsafe)).toBe(
      `Use ${modelLink("amazon.nova-2-lite-v1:0", "amazon-bedrock/amazon.nova-2-lite-v1:0")} now`,
    );
    expect(transformSubagentModelReferences("%@cf/meta/llama-3.1-8b", unsafe)).toBe(
      modelLink("@cf/meta/llama-3.1-8b", "cloudflare-workers-ai/@cf/meta/llama-3.1-8b"),
    );
  });
});
