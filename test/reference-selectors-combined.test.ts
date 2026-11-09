/**
 * Pi Skills Selector (`$`), Pi MCP Selector (`&`), Pi Issues Selector (`#`, and `!` on GitLab), and
 * Minimal Subagents' Subagent Model References (`%`) each stack a completion provider over the one
 * below and each rewrites the user's message in an `input` handler. None depends on the others, so
 * any load order is valid; this proves each order still completes `/`, `@file`, `&server`,
 * `$skill`, `#123`, `%role`, and on a GitLab remote `!7`, and converts a message that holds every
 * kind of reference without one package damaging another's links.
 *
 * Why this lives at the repository root: see `formatter-lsp-combined-order.test.ts`. The harness
 * mirrors how Pi's interactive mode and extension runner combine extensions: autocomplete
 * factories wrap the provider in registration order (the last loaded is outermost), and `input`
 * handlers run in load order, each seeing the text the earlier ones produced.
 */
import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
  SlashCommandInfo,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import issuesSelector from "../packages/pi-issues-selector/src/index.js";
import mcpSelector from "../packages/pi-mcp-selector/src/index.js";
import {
  buildSubagentModelCatalogue,
  registerSubagentModelReferences,
} from "../packages/pi-minimal-subagents/src/minimal-subagents-model-references.js";
import skillsSelector from "../packages/pi-skills-selector/src/index.js";

type Handler = (
  event: InputEvent | SessionStartEvent,
  context: ExtensionContext,
) => InputEventResult | void | Promise<InputEventResult | void>;

/** A Subagent Model Catalogue whose `%28x` would convert in prose, as a skill link encodes `(`. */
const SUBAGENT_MODELS = buildSubagentModelCatalogue({
  eligibleModelIds: ["anthropic/claude-opus-5-5", "local/28x"],
  models: [],
  modelRoles: [{ name: "large", model: "anthropic/claude-opus-5-5" }],
});

const SELECTORS = {
  skills: skillsSelector,
  mcp: mcpSelector,
  issues: issuesSelector,
  subagentModels: (pi) => registerSubagentModelReferences(pi, () => SUBAGENT_MODELS),
} satisfies Record<string, ExtensionFactory>;
type SelectorName = keyof typeof SELECTORS;

/**
 * Each selector only wraps the provider below it and rewrites what the earlier input handlers
 * produced, so interaction is pairwise: the load order, its reverse, and one interleaving prove it.
 */
const orders: SelectorName[][] = [
  ["skills", "mcp", "issues", "subagentModels"],
  ["subagentModels", "issues", "mcp", "skills"],
  ["mcp", "subagentModels", "skills", "issues"],
];

const skillCommand = (name: string, path = `/skills/${name}/SKILL.md`): SlashCommandInfo => ({
  name: `skill:${name}`,
  description: `Instructions for ${name}`,
  source: "skill",
  sourceInfo: {
    path,
    source: "local",
    scope: "user",
    origin: "top-level",
  },
});

function mcpTool(name: string, description: string): ToolInfo {
  const namespace = `mcp__${name}`;
  const tool = {
    name: `${namespace}__search`,
    description: "Search",
    parameters: { type: "object", properties: {} },
    exposure: "codemode",
    namespace: { name: namespace, aliases: [name], description },
  };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The selector reads only the namespace and exposure of a tool; the schema is never inspected.
  return tool as unknown as ToolInfo;
}

const FILES = ["notes.txt", "github"];
const GITHUB_REMOTE = "remote.origin.url git@github.com:acme/widgets.git\n";
const GITLAB_REMOTE = "remote.origin.url git@gitlab.com:group/sub/project.git\n";
const GITLAB_ISSUES = JSON.stringify([
  { id: 901, iid: 123, title: "Fix login redirect", state: "opened" },
  { id: 902, iid: 12, title: "Add dark mode", state: "closed" },
]);
const GITLAB_MERGE_REQUESTS = JSON.stringify([
  { id: 801, iid: 7, title: "Login rewrite", state: "opened", draft: false },
  { id: 802, iid: 70, title: "Dark mode", state: "merged", draft: false },
]);
const GH_ISSUES = JSON.stringify([
  { number: 123, title: "Fix login redirect", state: "open" },
  { number: 12, title: "Add dark mode", state: "closed" },
]);

/** A stand-in for Pi's native completion: `/` commands and `@file` mentions. */
const nativeProvider: AutocompleteProvider = {
  async getSuggestions(lines, cursorLine, cursorCol): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const command = /^(\/[a-z]*)$/.exec(before)?.[1];
    if (command !== undefined) {
      const items = [{ value: "help", label: "help", description: "Native help" }];
      return {
        prefix: command,
        items: items.filter((item) => `/${item.value}`.startsWith(command)),
      };
    }
    const mention = /(?:^|\s)(@[^\s]*)$/.exec(before)?.[1];
    if (mention === undefined) return null;
    const items = FILES.filter((file) => file.includes(mention.slice(1))).map((file) => ({
      value: `@${file}`,
      label: file,
    }));
    return items.length === 0 ? null : { prefix: mention, items };
  },
  applyCompletion(lines, cursorLine, cursorCol, item: AutocompleteItem, prefix) {
    const line = lines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;
    const inserted = prefix.startsWith("/") ? `/${item.value}` : item.value;
    const completed = [...lines];
    completed[cursorLine] = `${line.slice(0, start)}${inserted} ${line.slice(cursorCol)}`;
    return { lines: completed, cursorLine, cursorCol: start + inserted.length + 1 };
  },
};

class Host {
  readonly factories: AutocompleteProviderFactory[] = [];
  private readonly handlers: Handler[] = [];
  private readonly sessionStarts: Handler[] = [];

  constructor(
    order: readonly SelectorName[],
    private readonly remote = GITHUB_REMOTE,
  ) {
    for (const name of order) {
      const api = {
        on: (event: string, handler: Handler) => {
          (event === "input" ? this.handlers : this.sessionStarts).push(handler);
        },
        getCommands: () => [
          skillCommand("review"),
          skillCommand("ponytail"),
          skillCommand("odd", "/skills/(x)/SKILL.md"),
        ],
        getAllTools: () => [mcpTool("github", "Search code and issues")],
        exec: async (command: string, args: string[]) => {
          if (command === "git") {
            return { stdout: this.remote, stderr: "", code: 0, killed: false };
          }
          if (command === "glab") {
            const merge = args.some((arg) => arg.includes("/merge_requests?"));
            const stdout = merge ? GITLAB_MERGE_REQUESTS : GITLAB_ISSUES;
            return { stdout, stderr: "", code: 0, killed: false };
          }
          return { stdout: GH_ISSUES, stderr: "", code: 0, killed: false };
        },
      };
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This boundary harness supplies every ExtensionAPI member the selectors use.
      SELECTORS[name](api as unknown as ExtensionAPI);
    }
  }

  private context(): ExtensionContext {
    const context = {
      mode: "tui",
      cwd: "/work/project",
      hasUI: true,
      ui: {
        addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
          this.factories.push(factory);
        },
        notify: () => undefined,
      },
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This context provides the mode, cwd, and UI members the selectors read.
    return context as unknown as ExtensionContext;
  }

  async provider(): Promise<AutocompleteProvider> {
    for (const handler of this.sessionStarts) {
      await handler({ type: "session_start", reason: "startup" }, this.context());
    }
    return this.factories.reduce((current, wrap) => wrap(current), nativeProvider);
  }

  /** Pi's `emitInput`: each handler sees the text the earlier ones produced. */
  async submit(text: string): Promise<string> {
    let current = text;
    for (const handler of this.handlers) {
      const event: InputEvent = { type: "input", source: "interactive", text: current };
      const result = await handler(event, this.context());
      if (result?.action === "transform") current = result.text;
    }
    return current;
  }
}

const signal = new AbortController().signal;
async function complete(
  provider: AutocompleteProvider,
  line: string,
  choose: (item: AutocompleteItem) => boolean,
): Promise<{ values: string[]; applied: string }> {
  const suggestions = await provider.getSuggestions([line], 0, line.length, { signal });
  if (suggestions === null) throw new Error(`No suggestions for ${JSON.stringify(line)}`);
  const item = suggestions.items.find(choose);
  if (item === undefined) throw new Error(`No matching item for ${JSON.stringify(line)}`);
  const applied = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
  return {
    values: suggestions.items.map((candidate) => candidate.value),
    applied: applied.lines[0] ?? "",
  };
}

describe.each(orders.map((order) => [order.join(" → "), order] as const))(
  "selectors loaded in the order %s",
  (_label, order) => {
    test("stacked over a base provider, each completes its own prefix and leaves the others'", async () => {
      const provider = await new Host(order).provider();

      expect(await complete(provider, "/he", (item) => item.value === "help")).toMatchObject({
        applied: "/help ",
      });
      expect(await complete(provider, "see @no", (item) => item.value === "@notes.txt")).toEqual({
        values: ["@notes.txt"],
        applied: "see @notes.txt ",
      });
      // Servers have their own `&` trigger, so a file named like a server stays a plain file.
      expect(await complete(provider, "ask &gi", (item) => item.value === "&github")).toEqual({
        values: ["&github"],
        applied: "ask &github ",
      });
      expect(await complete(provider, "see @gi", (item) => item.value === "@github")).toEqual({
        values: ["@github"],
        applied: "see @github ",
      });
      expect(await complete(provider, "use $re", (item) => item.value === "$review")).toEqual({
        values: ["$review"],
        applied: "use $review ",
      });
      expect(await complete(provider, "fix #1", (item) => item.value === "#123")).toEqual({
        values: ["#123", "#12"],
        applied: "fix #123 ",
      });
      expect(await complete(provider, "fix #login", (item) => item.value === "#123")).toMatchObject(
        {
          applied: "fix #123 ",
        },
      );
      expect(await complete(provider, "plan with %la", (item) => item.value === "%large")).toEqual({
        values: ["%large", "%anthropic/claude-opus-5-5"],
        applied: "plan with %large ",
      });
    });

    test("no selector takes the others' prefixes", async () => {
      const provider = await new Host(order).provider();
      for (const line of ["mail a@gi", "a&gi", "echo $zzzz", "issue#1", "50%la", "`$re`"]) {
        const suggestions = await provider.getSuggestions([line], 0, line.length, { signal });
        // A mid-word sigil or code is no token, so no selector (and not the native files) answers.
        expect(suggestions?.items.map((item) => item.value) ?? []).toEqual([]);
      }
    });

    test("one message holding every kind of reference converts fully", async () => {
      const host = new Host(order);
      const converted = await host.submit(
        "Use $review with &github and %large to fix #12 and acme/other#1, not `$review`, `#12`, 50%, &#123 or R&D.",
      );
      expect(converted).toBe(
        'Use [$review](/skills/review/SKILL.md) with [&github](mcp://github "MCP server mcp__github") and [%large](model-role://large "Subagent model role: role=large") to fix [#12](https://github.com/acme/widgets/issues/12) and [acme/other#1](https://github.com/acme/other/issues/1), not `$review`, `#12`, 50%, &#123 or R&D.',
      );
      // Converting again leaves every link alone.
      expect(await host.submit(converted)).toBe(converted);
    });

    test("a model reference leaves another selector's percent-encoded link alone", async () => {
      const host = new Host(order);
      expect(await host.submit("Follow $odd, then %28x")).toBe(
        'Follow [$odd](/skills/%28x%29/SKILL.md), then [%28x](model://local/28x "Subagent model: model=local/28x")',
      );
    });

    describe("on a GitLab remote", () => {
      test("! completes merge requests beside # completions", async () => {
        const provider = await new Host(order, GITLAB_REMOTE).provider();

        expect(await complete(provider, "see !7", (item) => item.value === "!7")).toEqual({
          values: ["!7", "!70"],
          applied: "see !7 ",
        });
        expect(await complete(provider, "see !dark", (item) => item.value === "!70")).toMatchObject(
          { applied: "see !70 " },
        );
        expect(await complete(provider, "fix #1", (item) => item.value === "#123")).toEqual({
          values: ["#123", "#12"],
          applied: "fix #123 ",
        });
      });

      test("no selector takes ! where it is no token, and bash mode keeps its own completion", async () => {
        const provider = await new Host(order, GITLAB_REMOTE).provider();
        for (const line of ["a != b", "wow!7", "`!7`", "R&!7"]) {
          const suggestions = await provider.getSuggestions([line], 0, line.length, { signal });
          expect(suggestions?.items.map((item) => item.value) ?? []).toEqual([]);
        }
        // A message starting with `!` is a bash command: `!7` is not offered, `@file` still is.
        const bash = await provider.getSuggestions(["!cat @no"], 0, 8, { signal });
        expect(bash?.items.map((item) => item.value)).toEqual(["@notes.txt"]);
        const bashMergeRequest = await provider.getSuggestions(["!echo !7"], 0, 8, { signal });
        expect(bashMergeRequest?.items.map((item) => item.value) ?? []).toEqual([]);
      });

      test("one message holding every kind of reference converts fully", async () => {
        const host = new Host(order, GITLAB_REMOTE);
        const converted = await host.submit(
          "Use $review with &github to fix #12 and !7, see other/team/proj!3, not `!7`, a != b or &!7.",
        );
        expect(converted).toBe(
          'Use [$review](/skills/review/SKILL.md) with [&github](mcp://github "MCP server mcp__github") to fix [#12](https://gitlab.com/group/sub/project/-/issues/12) and [!7](https://gitlab.com/group/sub/project/-/merge_requests/7), see [other/team/proj!3](https://gitlab.com/other/team/proj/-/merge_requests/3), not `!7`, a != b or &!7.',
        );
        // Converting again leaves every link alone.
        expect(await host.submit(converted)).toBe(converted);
      });
    });
  },
);
