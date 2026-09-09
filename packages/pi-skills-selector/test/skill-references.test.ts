import { describe, expect, it } from "vitest";
import {
  getSkillReferencePrefix,
  transformSkillReferences,
  type Skill,
} from "../src/skill-references.js";

const skills: Skill[] = [
  { name: "review", path: "/skills/review/SKILL.md" },
  { name: "test-first", path: "/skills/test-first/SKILL.md" },
];

describe("Skill References", () => {
  it("only replaces exact original spelling when Markdown removes an escape", () => {
    const text = "| $a\\|b |\n| --- |";
    expect(transformSkillReferences(text, [{ name: "a|b", path: "/skills/pipe/SKILL.md" }])).toBe(
      text,
    );
    expect(getSkillReferencePrefix(text, text.indexOf("b") + 1)).toBeNull();
  });

  it("maps table cells after escaped pipes without moving references between rows", () => {
    const text =
      "| a\\|b | $review |\n| --- | --- |\n| `a\\|$review` | $review |\n| row | extra | $review |\n| $review | last |";
    expect(transformSkillReferences(text, skills)).toBe(
      "| a\\|b | [$review](/skills/review/SKILL.md) |\n| --- | --- |\n| `a\\|$review` | [$review](/skills/review/SKILL.md) |\n| row | extra | $review |\n| [$review](/skills/review/SKILL.md) | last |",
    );
    expect(getSkillReferencePrefix(text, text.indexOf("$review") + 3)).toBe("$re");
  });
  it("links table prose while preserving literal cells", () => {
    expect(
      transformSkillReferences(
        "| $review | `$review` |\n| --- | --- |\n| [$review](/target) | $test-first |",
        skills,
      ),
    ).toBe(
      "| [$review](/skills/review/SKILL.md) | `$review` |\n| --- | --- |\n| [$review](/target) | [$test-first](/skills/test-first/SKILL.md) |",
    );
  });

  it("uses catalogue names even when Pi reports naming warnings", () => {
    const catalogue: Skill[] = [
      { name: "style.guide", path: "/skills/style/SKILL.md" },
      { name: "c++", path: "/skills/cpp/SKILL.md" },
    ];
    expect(transformSkillReferences("$style.guide and $c++.", catalogue)).toBe(
      "[$style.guide](/skills/style/SKILL.md) and [$c++](/skills/cpp/SKILL.md).",
    );
    expect(getSkillReferencePrefix("$style.gu", 9)).toBe("$style.gu");
    expect(transformSkillReferences("$review.extra", skills)).toBe("$review.extra");
  });

  it("projects tab-expanded list content and native single-tilde formatting", () => {
    expect(transformSkillReferences("- $review\n\ttext", skills)).toBe(
      "- [$review](/skills/review/SKILL.md)\n\ttext",
    );
    expect(transformSkillReferences("~$review~", skills)).toBe(
      "~[$review](/skills/review/SKILL.md)~",
    );
  });

  it("uses block-local inline contexts and strips link continuation prefixes", () => {
    for (const text of ["> [$review](\n> /target\n> )", "- [$review](\n  /target\n  )"]) {
      expect(transformSkillReferences(text, skills)).toBe(text);
      expect(getSkillReferencePrefix(text, text.indexOf("$review") + 7)).toBeNull();
    }
    expect(transformSkillReferences("`literal\n\n$review\n\n`", skills)).toBe(
      "`literal\n\n[$review](/skills/review/SKILL.md)\n\n`",
    );
    expect(transformSkillReferences("[text](\n\n$review)", skills)).toBe(
      "[text](\n\n[$review](/skills/review/SKILL.md))",
    );
  });

  it("handles a large pasted blockquote without overflowing source projection", () => {
    const prefix = `> ${"x".repeat(150_000)} `;
    expect(transformSkillReferences(`${prefix}$review`, skills)).toBe(
      `${prefix}[$review](/skills/review/SKILL.md)`,
    );
  });

  it("keeps token boundaries when Markdown splits adjacent escape tokens", () => {
    expect(transformSkillReferences(String.raw`\$$review`, skills)).toBe(String.raw`\$$review`);
    expect(transformSkillReferences(String.raw`\_$review $review\_extra`, skills)).toBe(
      String.raw`\_$review $review\_extra`,
    );
    expect(getSkillReferencePrefix(String.raw`\$$re`, 5)).toBeNull();
    expect(transformSkillReferences(String.raw`\\$review`, skills)).toBe(
      String.raw`\\[$review](/skills/review/SKILL.md)`,
    );
  });

  it("offers bare and partial references at the cursor using the same literal protection", () => {
    expect(getSkillReferencePrefix("😀 $", 4)).toBe("$");
    expect(getSkillReferencePrefix("$review then $te rest", 16)).toBe("$te");
    expect(getSkillReferencePrefix("first\r\n> **$re**", 14)).toBe("$re");
    for (const text of [
      "`$re`",
      "[$re](/target)",
      String.raw`\$re`,
      "é$re",
      "```\n$re",
      "- ```\n  $re",
      "    $re",
    ]) {
      const cursor = text.indexOf("$re") + 3;
      expect(getSkillReferencePrefix(text, cursor), text).toBeNull();
    }
  });

  it("encodes absolute link destinations without changing their target", () => {
    expect(
      transformSkillReferences("$review", [
        { name: "review", path: "/tmp/a b(1)#draft?%/語/SKILL.md" },
      ]),
    ).toBe("[$review](/tmp/a%20b%281%29%23draft%3F%25/%E8%AA%9E/SKILL.md)");
    expect(
      transformSkillReferences("$review", [{ name: "review", path: "relative/SKILL.md" }]),
    ).toBe("$review");
  });

  it("honors nested code containers without extending them into following prose", () => {
    const literal = "> ```\r\n> $review";
    expect(transformSkillReferences(`${literal}\r\n\r\n$review`, skills)).toBe(
      `${literal}\r\n\r\n[$review](/skills/review/SKILL.md)`,
    );
    expect(transformSkillReferences("- ```\n  $review", skills)).toBe("- ```\n  $review");
    expect(
      transformSkillReferences("- $review\n  - ```\n    $review\n    ```\n\n$test-first", skills),
    ).toBe(
      "- [$review](/skills/review/SKILL.md)\n  - ```\n    $review\n    ```\n\n[$test-first](/skills/test-first/SKILL.md)",
    );
  });

  it("preserves multiline, reference, shortcut and automatic links and their definitions", () => {
    const literal =
      '[$review](\r\n/target "$review")\r\n[$review][guide] [$review][]\r\n<https://example.test/$review>\r\n\r\n[guide]: /$review\r\n[$review]: /target\r\n  "$review"';
    expect(transformSkillReferences(`${literal}\r\n\r\n$review`, skills)).toBe(
      `${literal}\r\n\r\n[$review](/skills/review/SKILL.md)`,
    );
  });

  it("preserves fenced and indented code with original CRLF and tabs", () => {
    const literal =
      "```ts\r\n$review\r\n````\r\n\r\n    $review\r\n\t$review\r\n\r\n~~~\r\n$review\r\n~~~";
    expect(transformSkillReferences(`${literal}\r\n\r\n$test-first`, skills)).toBe(
      `${literal}\r\n\r\n[$test-first](/skills/test-first/SKILL.md)`,
    );
    const unfinished = "before\n~~~text\n$review";
    expect(transformSkillReferences(unfinished, skills)).toBe(unfinished);
  });

  it("preserves code, links, and escapes while linking formatted prose", () => {
    const literal = "`$review` ``a `$review` b`` [$review](/docs) ![$review](/image) \\$review";
    const result = transformSkillReferences(`${literal} **$review** and _$test-first_.`, skills);
    expect(result).toBe(
      `${literal} **[$review](/skills/review/SKILL.md)** and _[$test-first](/skills/test-first/SKILL.md)_.`,
    );
    expect(transformSkillReferences(result, skills)).toBe(result);
  });

  it("links known references in order without changing surrounding source", () => {
    expect(
      transformSkillReferences("😀 Use $review, then $test-first.\r\nAgain $review!", skills),
    ).toBe(
      "😀 Use [$review](/skills/review/SKILL.md), then [$test-first](/skills/test-first/SKILL.md).\r\nAgain [$review](/skills/review/SKILL.md)!",
    );
  });

  it("matches complete names and leaves dollar expressions and escaped references literal", () => {
    const text =
      "$unknown $HOME ${review} $$review $1 $review-extra $review_thing é$review $reviewé \\$review";
    expect(transformSkillReferences(text, skills)).toBe(text);
    expect(transformSkillReferences("($review).", skills)).toBe(
      "([$review](/skills/review/SKILL.md)).",
    );
  });
});
