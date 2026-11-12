import { describe, expect, it } from "vite-plus/test";
import { transformSkillReferences, type Skill } from "../src/skill-references.js";

// Prose Span handling is proven in pi-utils; these cover how the Skill Catalogue feeds it.
const skills: Skill[] = [
  { name: "review", path: "/skills/review/SKILL.md" },
  { name: "test-first", path: "/skills/test-first/SKILL.md" },
];

describe("Skill References", () => {
  it("uses catalogue names even when Pi reports naming warnings", () => {
    const catalogue: Skill[] = [
      { name: "style.guide", path: "/skills/style/SKILL.md" },
      { name: "c++", path: "/skills/cpp/SKILL.md" },
      { name: "a|b", path: "/skills/pipe/SKILL.md" },
    ];
    expect(transformSkillReferences("$style.guide and $c++.", catalogue)).toBe(
      "[$style.guide](/skills/style/SKILL.md) and [$c++](/skills/cpp/SKILL.md).",
    );
    expect(transformSkillReferences("| $a\\|b |\n| --- |", catalogue)).toBe("| $a\\|b |\n| --- |");
    expect(transformSkillReferences("$review.extra", skills)).toBe("$review.extra");
  });

  it("prefers the longest of overlapping names", () => {
    const catalogue: Skill[] = [
      { name: "review", path: "/skills/review/SKILL.md" },
      { name: "review.deep", path: "/skills/deep/SKILL.md" },
    ];
    expect(transformSkillReferences("$review.deep", catalogue)).toBe(
      "[$review.deep](/skills/deep/SKILL.md)",
    );
  });

  it("encodes absolute link destinations without changing their target", () => {
    expect(
      transformSkillReferences("$review", [
        { name: "review", path: "/tmp/a b(1)#draft?%/語/SKILL.md" },
      ]),
    ).toBe("[$review](/tmp/a%20b%281%29%23draft%3F%25/%E8%AA%9E/SKILL.md)");
  });

  it("leaves relative, ill-formed, and unknown references literal", () => {
    expect(
      transformSkillReferences("$review", [{ name: "review", path: "relative/SKILL.md" }]),
    ).toBe("$review");
    expect(
      transformSkillReferences("$review", [{ name: "review", path: "/tmp/\ud800/SKILL.md" }]),
    ).toBe("$review");
    expect(transformSkillReferences("$unknown $HOME", skills)).toBe("$unknown $HOME");
    expect(transformSkillReferences("$review", [])).toBe("$review");
  });
});
