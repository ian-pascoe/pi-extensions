# Pi Skills Selector

Pi Skills Selector lets users reference multiple Skills within a user message.

## Language

**Skill**:
A named set of instructions described by a `SKILL.md` document.

**Skill Catalogue**:
The Skills available in the current Pi session under Pi's discovery and name-precedence rules. It includes Skills reserved for explicit user invocation.
_Avoid_: Separate registry

**Skill Reference**:
An explicit mention of a Skill in a user message, expressed as `$skill-name` or a Markdown link to its document. A Skill Reference points the model to instructions rather than including their full contents, and may be typed, pasted, or inserted through autocomplete.
_Avoid_: Embedded Skill, injected Skill
