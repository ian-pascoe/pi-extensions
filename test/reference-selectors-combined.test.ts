/**
 * Pi Skills Selector (`$`), Pi MCP Selector (`+`), and Pi Issues Selector (`#`) each stack a
 * completion provider over the one below and each rewrites the user's message in an `input`
 * handler. None depends on the others, so any load order is valid; this proves each order still
 * completes `/`, `@file`, `+server`, `$skill`, and `#123`, and converts a message that holds every
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
import skillsSelector from "../packages/pi-skills-selector/src/index.js";

type Handler = (
  event: InputEvent | SessionStartEvent,
  context: ExtensionContext,
) => InputEventResult | void | Promise<InputEventResult | void>;

const SELECTORS = {
  skills: skillsSelector,
  mcp: mcpSelector,
  issues: issuesSelector,
} satisfies Record<string, ExtensionFactory>;
type SelectorName = keyof typeof SELECTORS;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}
const names: SelectorName[] = ["skills", "mcp", "issues"];
const orders = permutations(names);

const skillCommand = (name: string): SlashCommandInfo => ({
  name: `skill:${name}`,
  description: `Instructions for ${name}`,
  source: "skill",
  sourceInfo: {
    path: `/skills/${name}/SKILL.md`,
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

  constructor(order: readonly SelectorName[]) {
    for (const name of order) {
      const api = {
        on: (event: string, handler: Handler) => {
          (event === "input" ? this.handlers : this.sessionStarts).push(handler);
        },
        getCommands: () => [skillCommand("review"), skillCommand("ponytail")],
        getAllTools: () => [mcpTool("github", "Search code and issues")],
        exec: async (command: string) =>
          command === "git"
            ? {
                stdout: "remote.origin.url git@github.com:acme/widgets.git\n",
                stderr: "",
                code: 0,
                killed: false,
              }
            : { stdout: GH_ISSUES, stderr: "", code: 0, killed: false },
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
      // Servers have their own `+` trigger, so a file named like a server stays a plain file.
      expect(await complete(provider, "ask +gi", (item) => item.value === "+github")).toEqual({
        values: ["+github"],
        applied: "ask +github ",
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
    });

    test("no selector takes the others' prefixes", async () => {
      const provider = await new Host(order).provider();
      for (const line of [
        "mail a@gi",
        "C++",
        "a+gi",
        "echo $zzzz",
        "issue#1",
        "`#1`",
        "`@gi`",
        "`+gi`",
        "`$re`",
      ]) {
        const suggestions = await provider.getSuggestions([line], 0, line.length, { signal });
        // A mid-word sigil or code is no token, so no selector (and not the native files) answers.
        expect(suggestions?.items.map((item) => item.value) ?? []).toEqual([]);
      }
    });

    test("one message holding every kind of reference converts fully", async () => {
      const converted = await new Host(order).submit(
        "Use $review with +github to fix #12 and acme/other#1, not `$review` or `#12`.",
      );
      expect(converted).toBe(
        'Use [$review](/skills/review/SKILL.md) with [+github](mcp://github "MCP server mcp__github") to fix [#12](https://github.com/acme/widgets/issues/12) and [acme/other#1](https://github.com/acme/other/issues/1), not `$review` or `#12`.',
      );
    });

    test("converting is idempotent across the selectors", async () => {
      const host = new Host(order);
      const once = await host.submit("Use $review, +github, #12 and acme/other#1.");
      expect(await host.submit(once)).toBe(once);
    });
  },
);
