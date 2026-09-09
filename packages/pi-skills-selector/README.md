# Pi Skills Selector

Reference Skills with `$skill-name` anywhere in a user message. Type `$` to open
Pi's native completion popup, then fuzzy-filter by name. Each result shows its
description; selecting one leaves shorthand in the editor. Repeat to reference
several Skills.

```bash
pi install npm:@ian-pascoe/pi-skills-selector
```

Requires Pi `>=0.85.1` and Node `>=22.19.0`. There are no settings or extra tools.

## Submission

Typed, pasted, and selected references are equivalent. On submission:

```text
Review with $code-review and $ponytail.
→ Review with [$code-review](/skills/code-review/SKILL.md) and [$ponytail](/skills/ponytail/SKILL.md).
```

Paths come from the current Pi Skill Catalogue. The model receives links, not
full instructions, and chooses when to read them. The submitted transcript stores
the links rather than a separate raw shorthand message.

Only exact known names in prose expand. Unknown names and expressions such as
`$HOME` stay literal, as do escaped `\$skill-name`, code, and existing Markdown
links. Escape or code-format a literal variable whose name matches a Skill.
Multiple and repeated references retain their order; path characters are escaped
for Markdown links.

The catalogue follows Pi's discovery, trust, and name precedence, including
Skills marked `disable-model-invocation` because selection is an explicit user
request. It is available on the first prompt, refreshes with Pi's resources, and
works with `enableSkillCommands: false`.

## Integration

Completion stacks over the current provider, retaining ordinary slash/file
completion, keyboard controls, and custom editors. Conversion applies to terminal
and RPC `prompt` input, including steering and follow-ups, without changing
attachments or message routing. Extension-generated input is unchanged.

**Pi 0.85.1 RPC limitation:** direct `steer` and `follow_up` commands bypass Pi's
input hooks, so their shorthand stays literal. Send `prompt` with
`streamingBehavior: "steer"` or `"followUp"` while streaming to get conversion.
This extension uses public hooks rather than patching Pi's message pipeline.

## Troubleshooting

- **No popup:** confirm the extension loaded, use an interactive terminal, and
  type `$` at a prose token boundary. Check that the expected Skill is in Pi's
  discovered resources; reload after changing resource configuration.
- **No link:** check the exact case-sensitive name, its discovered document path,
  and whether the reference is escaped, in code, or already inside a link.
- **Wrong target:** inspect Pi's resource origins and duplicate-name precedence.
  The selector uses the winning catalogue entry rather than scanning separately.
- **The model did not read the Skill:** inspect the submitted user message first.
  A correct link verifies conversion; reading the document is the model's choice.
