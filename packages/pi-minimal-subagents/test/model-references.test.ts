import { describe, expect, test } from "vite-plus/test";
import {
  buildSubagentModelCatalogue,
  suggestSubagentModelReferences,
  transformSubagentModelReferences,
} from "../src/minimal-subagents-model-references.js";

const modelLink = (typed: string, model: string): string =>
  `[%${typed}](model://${model} "Subagent model: model=${model}")`;
const roleLink = (role: string): string =>
  `[%${role}](model-role://${role} "Subagent model role: role=${role}")`;

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
    const items = suggestSubagentModelReferences(popup, "");
    expect(items.map((item) => item.value)).toEqual([
      "%design",
      "%small",
      "%anthropic/claude-haiku-5-5",
      "%anthropic/claude-opus-5-5",
      "%openai/gpt-6",
      "%opencode-go/kimi-k3",
    ]);
    expect(items[0]?.description).toBe(
      "Subagent role \u00b7 opencode-go/kimi-k3:high \u00b7 UI design, visual critique",
    );
    expect(items[2]?.description).toBe("Subagent model \u00b7 Claude Haiku 5.5");
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
      ["Use %large.", `Use ${large}.`],
      ["%large:high", "%large:high"],
      ["%large@x", "%large@x"],
      ["%large-ish", "%large-ish"],
      ["50%large", "50%large"],
      ["%PATH%", "%PATH%"],
      ["printf %s", `printf ${modelLink("s", "local/s")}`],
      ["\\%large", "\\%large"],
      ["`%large`", "`%large`"],
      ["```\n%large\n```", "```\n%large\n```"],
      ["%Large", "%Large"],
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

describe("Subagent Model References with a thinking level", () => {
  const ALL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const levels = buildSubagentModelCatalogue({
    eligibleModelIds: [
      "anthropic/claude-opus-5-5",
      "openai/gpt-4o",
      "amazon-bedrock/amazon.nova-2-lite-v1:0",
      "local/m",
      "local/m:high",
    ],
    models: [
      { provider: "anthropic", id: "claude-opus-5-5", thinkingLevels: ALL },
      { provider: "openai", id: "gpt-4o", thinkingLevels: ["off"] },
      { provider: "local", id: "m", thinkingLevels: ALL },
    ],
    modelRoles: [{ name: "large", model: "anthropic/claude-opus-5-5", thinkingLevel: "high" }],
  });
  const levelLink = (typed: string, model: string, level: string): string =>
    `[%${typed}](model://${model} "Subagent model: model=${model}, thinking_level=${level}")`;

  test("converts a supported level after a full id, a bare id, or a role", () => {
    expect(transformSubagentModelReferences("Use %anthropic/claude-opus-5-5:high.", levels)).toBe(
      `Use ${levelLink("anthropic/claude-opus-5-5:high", "anthropic/claude-opus-5-5", "high")}.`,
    );
    expect(transformSubagentModelReferences("Use %claude-opus-5-5:max, %gpt-4o:off", levels)).toBe(
      `Use ${levelLink("claude-opus-5-5:max", "anthropic/claude-opus-5-5", "max")}, ${levelLink("gpt-4o:off", "openai/gpt-4o", "off")}`,
    );
    expect(transformSubagentModelReferences("Plan with %large:low: go", levels)).toBe(
      'Plan with [%large:low](model-role://large "Subagent model role: role=large, thinking_level=low"): go',
    );
  });

  test("leaves an unsupported or unknown level literal", () => {
    for (const text of ["%gpt-4o:high", "%large:ultra"]) {
      expect(transformSubagentModelReferences(text, levels), text).toBe(text);
    }
  });

  test("reads an id that already ends in a colon suffix as that id first", () => {
    expect(transformSubagentModelReferences("%local/m:high", levels)).toBe(
      modelLink("local/m:high", "local/m:high"),
    );
    expect(transformSubagentModelReferences("%local/m:low", levels)).toBe(
      levelLink("local/m:low", "local/m", "low"),
    );
    expect(transformSubagentModelReferences("%amazon.nova-2-lite-v1:0", levels)).toBe(
      modelLink("amazon.nova-2-lite-v1:0", "amazon-bedrock/amazon.nova-2-lite-v1:0"),
    );
  });

  test("lists a name's supported levels after a colon, in Pi's order", () => {
    const values = (query: string) =>
      suggestSubagentModelReferences(levels, query).map((item) => item.value);
    expect(values("claude-opus-5-5:")).toEqual(ALL.map((level) => `%claude-opus-5-5:${level}`));
    expect(values("large:m")).toEqual(["%large:minimal", "%large:medium", "%large:max"]);
    expect(values("gpt-4o:")).toEqual(["%gpt-4o:off"]);
    expect(values("gpt-4o:h")).toEqual([]);
    expect(values("Large:")).toEqual([]);
    expect(suggestSubagentModelReferences(levels, "gpt")[0]?.description).toBe(
      "Subagent model \u00b7 off",
    );
    expect(suggestSubagentModelReferences(levels, "large:hi")).toEqual([
      {
        value: "%large:high",
        label: "%large:high",
        description: "Subagent role \u00b7 anthropic/claude-opus-5-5:high",
      },
    ]);
  });

  test("offers an id that already ends in a colon suffix instead of a level that spells it", () => {
    const values = suggestSubagentModelReferences(levels, "local/m:h").map((item) => item.value);
    expect(values).toEqual(["%local/m:high"]);
    expect(
      suggestSubagentModelReferences(levels, "local/m:h").map((item) => item.description),
    ).toEqual(["Subagent model"]);
  });

  test("never reads an ambiguous id that ends in a colon suffix as another name with a level", () => {
    const ambiguous = buildSubagentModelCatalogue({
      eligibleModelIds: ["one/m", "one/m:high", "two/m:high"],
      models: [{ provider: "one", id: "m", thinkingLevels: ALL }],
      modelRoles: [],
    });
    expect(transformSubagentModelReferences("%m:high", ambiguous)).toBe("%m:high");
    expect(transformSubagentModelReferences("%m:low", ambiguous)).toBe(
      levelLink("m:low", "one/m", "low"),
    );
    expect(suggestSubagentModelReferences(ambiguous, "m:").map((item) => item.value)).not.toContain(
      "%m:high",
    );
  });
});
