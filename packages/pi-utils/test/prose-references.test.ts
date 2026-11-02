import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  findProseReferencePrefix,
  replaceProseReferences,
  stackProseReferenceAutocomplete,
} from "../src/prose-references.js";

const partialName = "[^\\s$[\\]()`*~<>]*";
const catalogue = new Map([
  ["review", "/skills/review/SKILL.md"],
  ["test-first", "/skills/test-first/SKILL.md"],
  ["style.guide", "/skills/style/SKILL.md"],
  ["c++", "/skills/cpp/SKILL.md"],
  ["a|b", "/skills/pipe/SKILL.md"],
]);
const names = [...catalogue.keys()]
  .sort((left, right) => right.length - left.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

// Cases are written with `$`; every Reference Sigil must behave the same way in a Prose Span.
describe.each(["$", "@", "#"])("prose references with the %s Reference Sigil", (sigil) => {
  const at = (text: string): string => text.replaceAll("$", sigil);
  const link = (name: string): string => `[${sigil}${name}](${catalogue.get(name) ?? ""})`;
  const replace = (text: string): string =>
    replaceProseReferences(at(text), {
      sigil,
      name: names,
      resolve: (name) => {
        const path = catalogue.get(name);
        return path === undefined ? undefined : `[${sigil}${name}](${path})`;
      },
    });
  const prefixAt = (text: string, cursor: number): string | null =>
    findProseReferencePrefix(at(text), cursor, { sigil, partialName });

  it("only replaces exact original spelling when Markdown removes an escape", () => {
    const text = at("| $a\\|b |\n| --- |");
    expect(replace(text)).toBe(text);
    expect(prefixAt(text, text.indexOf("b") + 1)).toBeNull();
  });

  it("maps table cells after escaped pipes without moving references between rows", () => {
    const text =
      "| a\\|b | $review |\n| --- | --- |\n| `a\\|$review` | $review |\n| row | extra | $review |\n| $review | last |";
    expect(replace(text)).toBe(
      `| a\\|b | ${link("review")} |\n| --- | --- |\n| \`a\\|${sigil}review\` | ${link("review")} |\n| row | extra | ${sigil}review |\n| ${link("review")} | last |`,
    );
    expect(prefixAt(text, at(text).indexOf(`${sigil}review`) + 3)).toBe(`${sigil}re`);
  });

  it("links table prose while preserving literal cells", () => {
    expect(
      replace("| $review | `$review` |\n| --- | --- |\n| [$review](/target) | $test-first |"),
    ).toBe(
      at(
        `| ${link("review")} | \`$review\` |\n| --- | --- |\n| [$review](/target) | ${link("test-first")} |`,
      ),
    );
  });

  it("uses names exactly as the caller's grammar spells them", () => {
    expect(replace("$style.guide and $c++.")).toBe(`${link("style.guide")} and ${link("c++")}.`);
    expect(prefixAt("$style.gu", 9)).toBe(at("$style.gu"));
    expect(replace("$review.extra")).toBe(at("$review.extra"));
  });

  it("projects tab-expanded list content and native single-tilde formatting", () => {
    expect(replace("- $review\n\ttext")).toBe(`- ${link("review")}\n\ttext`);
    expect(replace("~$review~")).toBe(`~${link("review")}~`);
  });

  it("uses block-local inline contexts and strips link continuation prefixes", () => {
    for (const text of ["> [$review](\n> /target\n> )", "- [$review](\n  /target\n  )"]) {
      expect(replace(text)).toBe(at(text));
      expect(prefixAt(text, at(text).indexOf(`${sigil}review`) + 7)).toBeNull();
    }
    expect(replace("`literal\n\n$review\n\n`")).toBe(`\`literal\n\n${link("review")}\n\n\``);
    expect(replace("[text](\n\n$review)")).toBe(`[text](\n\n${link("review")})`);
  });

  it("handles a large pasted blockquote without overflowing source projection", () => {
    const prefix = `> ${"x".repeat(150_000)} `;
    expect(replace(`${prefix}$review`)).toBe(`${prefix}${link("review")}`);
  });

  it("keeps token boundaries when Markdown splits adjacent escape tokens", () => {
    expect(replace(String.raw`\$$review`)).toBe(at(String.raw`\$$review`));
    expect(replace(String.raw`\_$review $review\_extra`)).toBe(
      at(String.raw`\_$review $review\_extra`),
    );
    expect(prefixAt(String.raw`\$$re`, 5)).toBeNull();
    expect(replace(String.raw`\\$review`)).toBe(String.raw`\\` + link("review"));
  });

  it("offers bare and partial references at the cursor using the same literal protection", () => {
    expect(prefixAt("😀 $", 4)).toBe(sigil);
    expect(prefixAt("$review then $te rest", 16)).toBe(`${sigil}te`);
    expect(prefixAt("first\r\n> **$re**", 14)).toBe(`${sigil}re`);
    for (const text of [
      "`$re`",
      "[$re](/target)",
      String.raw`\$re`,
      "é$re",
      "```\n$re",
      "- ```\n  $re",
      "    $re",
    ]) {
      const cursor = at(text).indexOf(`${sigil}re`) + 3;
      expect(prefixAt(text, cursor), text).toBeNull();
    }
  });

  it("honors nested code containers without extending them into following prose", () => {
    const literal = "> ```\r\n> $review";
    expect(replace(`${literal}\r\n\r\n$review`)).toBe(`${at(literal)}\r\n\r\n${link("review")}`);
    expect(replace("- ```\n  $review")).toBe(at("- ```\n  $review"));
    expect(replace("- $review\n  - ```\n    $review\n    ```\n\n$test-first")).toBe(
      `- ${link("review")}\n  - \`\`\`\n    ${sigil}review\n    \`\`\`\n\n${link("test-first")}`,
    );
  });

  it("preserves multiline, reference, shortcut and automatic links and their definitions", () => {
    const literal =
      '[$review](\r\n/target "$review")\r\n[$review][guide] [$review][]\r\n<https://example.test/$review>\r\n\r\n[guide]: /$review\r\n[$review]: /target\r\n  "$review"';
    expect(replace(`${literal}\r\n\r\n$review`)).toBe(`${at(literal)}\r\n\r\n${link("review")}`);
  });

  it("preserves fenced and indented code with original CRLF and tabs", () => {
    const literal =
      "```ts\r\n$review\r\n````\r\n\r\n    $review\r\n\t$review\r\n\r\n~~~\r\n$review\r\n~~~";
    expect(replace(`${literal}\r\n\r\n$test-first`)).toBe(
      `${at(literal)}\r\n\r\n${link("test-first")}`,
    );
    const unfinished = "before\n~~~text\n$review";
    expect(replace(unfinished)).toBe(at(unfinished));
  });

  it("preserves code, links, and escapes while linking formatted prose", () => {
    const literal = "`$review` ``a `$review` b`` [$review](/docs) ![$review](/image) \\$review";
    const result = replace(`${literal} **$review** and _$test-first_.`);
    expect(result).toBe(`${at(literal)} **${link("review")}** and _${link("test-first")}_.`);
    expect(replace(result)).toBe(result);
  });

  it("links known references in order without changing surrounding source", () => {
    expect(replace("😀 Use $review, then $test-first.\r\nAgain $review!")).toBe(
      `😀 Use ${link("review")}, then ${link("test-first")}.\r\nAgain ${link("review")}!`,
    );
  });

  it("matches complete names and leaves unknown and escaped references literal", () => {
    const text =
      "$unknown $HOME ${review} $$review $1 $review-extra $review_thing é$review $reviewé \\$review";
    expect(replace(text)).toBe(at(text));
    expect(replace("($review).")).toBe(`(${link("review")}).`);
  });
});

describe("replaceProseReferences", () => {
  it("resolves each matched name through the caller's grammar and leaves undefined literal", () => {
    const resolved: string[] = [];
    const result = replaceProseReferences("Ask @github and @gitlab, not `@github` or @git hub.", {
      sigil: "@",
      name: "[A-Za-z0-9_-]+",
      resolve: (name) => {
        resolved.push(name);
        return name === "github" ? `[@${name}](mcp://${name})` : undefined;
      },
    });
    expect(result).toBe("Ask [@github](mcp://github) and @gitlab, not `@github` or @git hub.");
    expect(resolved).toEqual(["github", "gitlab", "git"]);
  });

  it("calls resolve only for matches that can convert", () => {
    const resolved: string[] = [];
    replaceProseReferences("`@code` [@link](/x) \\@escaped a@mail @@twice @real", {
      sigil: "@",
      name: "[a-z]+",
      resolve: (name) => {
        resolved.push(name);
        return undefined;
      },
    });
    expect(resolved).toEqual(["real"]);
  });

  it("does not match a sigil that follows a word character or another copy of itself", () => {
    const options = { name: "[a-z]+", resolve: (name: string) => `<${name}>` };
    expect(replaceProseReferences("a@b @@b @b", { ...options, sigil: "@" })).toBe("a@b @@b <b>");
  });

  it("rejects a sigil that is not one visible character", () => {
    for (const sigil of ["", "$$", " ", "\\"]) {
      expect(() =>
        replaceProseReferences("text", { sigil, name: "a", resolve: () => undefined }),
      ).toThrow(TypeError);
      expect(() => findProseReferencePrefix("text", 0, { sigil, partialName: "a*" })).toThrow(
        TypeError,
      );
      expect(() =>
        stackProseReferenceAutocomplete(
          {
            getSuggestions: async () => null,
            applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }),
          },
          { sigil, partialName: "a*", suggest: () => [] },
        ),
      ).toThrow(TypeError);
    }
  });
});

describe("findProseReferencePrefix", () => {
  it("applies the caller's partial-name grammar to the prefix", () => {
    const grammar = { sigil: "@", partialName: "[A-Za-z0-9_-]*" };
    expect(findProseReferencePrefix("ask @git", 8, grammar)).toBe("@git");
    expect(findProseReferencePrefix("ask @", 5, grammar)).toBe("@");
    expect(findProseReferencePrefix("ask @git.", 9, grammar)).toBeNull();
    expect(findProseReferencePrefix("mail a@git", 10, grammar)).toBeNull();
  });
});

describe.each(["$", "@", "#"])("stacked autocomplete with the %s Reference Sigil", (sigil) => {
  const signal = new AbortController().signal;
  const items = [
    { value: `${sigil}alpha`, label: `${sigil}alpha`, description: "first" },
    { value: `${sigil}beta`, label: `${sigil}beta`, description: "second" },
  ];
  const queries: string[] = [];
  const stack = (
    current: AutocompleteProvider = new CombinedAutocompleteProvider(
      [{ name: "help", description: "Native help" }],
      "/tmp",
      null,
    ),
  ): AutocompleteProvider =>
    stackProseReferenceAutocomplete(current, {
      sigil,
      partialName: "[a-z]*",
      suggest: (query) => {
        queries.push(query);
        return items.filter((item) => item.value.slice(1).startsWith(query));
      },
    });

  it("owns the popup at the sigil's prefix and passes the typed name to suggest", async () => {
    queries.length = 0;
    const provider = stack();
    expect(await provider.getSuggestions([`use ${sigil}al`], 0, 7, { signal })).toEqual({
      prefix: `${sigil}al`,
      items: [items[0]],
    });
    expect(queries).toEqual(["al"]);
    expect((await provider.getSuggestions([`see ${sigil}`], 0, 5, { signal }))?.items).toEqual(
      items,
    );
  });

  it("shows no popup, and does not ask the provider below, when nothing matches or it is cancelled", async () => {
    let delegated = 0;
    const provider = stack({
      getSuggestions: async () => {
        delegated++;
        return null;
      },
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    });
    expect(await provider.getSuggestions([`${sigil}zzz`], 0, 4, { signal })).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(
      await provider.getSuggestions([`see ${sigil}`], 0, 5, { signal: controller.signal }),
    ).toBeNull();
    expect(delegated).toBe(0);
  });

  it("delegates everything outside a Prose Span prefix to the provider below", async () => {
    const options = { signal, force: true };
    const item = { value: `${sigil}path`, label: `${sigil}path` };
    const result = { lines: ["`x`"], cursorLine: 0, cursorCol: 3 };
    const current: AutocompleteProvider = {
      triggerCharacters: ["!"],
      async getSuggestions(lines, cursorLine, cursorCol, received) {
        expect([lines, cursorLine, cursorCol]).toEqual([[`\`${sigil}p\``], 0, 3]);
        expect(received).toBe(options);
        return { prefix: `${sigil}p`, items: [item] };
      },
      applyCompletion: () => result,
      shouldTriggerFileCompletion: () => false,
    };
    const provider = stack(current);
    expect(provider.triggerCharacters).toEqual(["!", sigil]);
    expect(await provider.getSuggestions([`\`${sigil}p\``], 0, 3, options)).toEqual({
      prefix: `${sigil}p`,
      items: [item],
    });
    expect(provider.applyCompletion([`\`${sigil}p\``], 0, 3, item, `${sigil}p`)).toBe(result);
    expect(provider.shouldTriggerFileCompletion?.(["x"], 0, 1)).toBe(false);
    const native = stack();
    expect(native.shouldTriggerFileCompletion?.(["x"], 0, 1)).toBe(true);
    const slash = await native.getSuggestions(["/he"], 0, 3, { signal });
    expect(slash?.items).toEqual([{ value: "help", label: "help", description: "Native help" }]);
    const help = slash?.items[0];
    if (!help) throw new Error("Missing native suggestion");
    expect(native.applyCompletion(["/he"], 0, 3, help, "/he")).toEqual({
      lines: ["/help "],
      cursorLine: 0,
      cursorCol: 6,
    });
  });

  it("inserts one shorthand with native spacing and keeps the rest of the editor", () => {
    const provider = stack();
    const lines = ["first", `see ${sigil}al, more`, "last"];
    expect(provider.applyCompletion(lines, 1, 7, items[0] ?? never(), `${sigil}al`)).toEqual({
      lines: ["first", `see ${sigil}alpha , more`, "last"],
      cursorLine: 1,
      cursorCol: 11,
    });
  });

  it("leaves an item to the provider below when its prefix is stale", () => {
    const result = { lines: ["x"], cursorLine: 0, cursorCol: 1 };
    const provider = stack({
      getSuggestions: async () => null,
      applyCompletion: () => result,
    });
    expect(provider.applyCompletion([`${sigil}be`], 0, 3, items[1] ?? never(), `${sigil}b`)).toBe(
      result,
    );
  });
});

function never(): never {
  throw new Error("Missing fixture item");
}
