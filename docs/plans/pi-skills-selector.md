# Pi Skills Selector implementation plan

Status: implemented and verified, with the upstream RPC limitation below.

## Outcome

Create `@ian-pascoe/pi-skills-selector`: reference multiple Skills within user input using `$skill-name`, with Pi's native autocomplete experience. The model receives links to the selected instructions, not their full contents.

Vocabulary authority: [`packages/pi-skills-selector/CONTEXT.md`](../../packages/pi-skills-selector/CONTEXT.md).

## Agreed behavior

- Bare `$` opens the ordinary completion popup. Further typing fuzzy-filters Skill names; results show names and descriptions. Selecting inserts one `$skill-name`; another `$` adds another reference.
- Typed, pasted, and autocomplete-inserted references behave identically. The editor retains shorthand while composing.
- On submission, replace each recognized reference in place with a Markdown link to its absolute `SKILL.md` path. Preserve textual order and repeated occurrences. Example:

  ```text
  Review this using $code-review and $ponytail.
  → Review this using [$code-review](/skills/code-review/SKILL.md) and [$ponytail](/skills/ponytail/SKILL.md).
  ```

- Convert only exact, known names in ordinary prose. Preserve unknown names, ordinary dollar expressions such as `$HOME`, inline and fenced code, existing Markdown links, and escaped `\$skill-name`. A same-spelled literal variable can be escaped or code-formatted rather than interpreted as a Skill Reference.
- Use Pi's current Skill Catalogue, including Skills marked `disable-model-invocation`: the user is explicitly requesting them. Follow Pi's discovery, trust, and name-precedence decisions.
- Convert terminal and RPC user input, including steering and follow-ups. Preserve extension-generated input unchanged. Autocomplete is terminal-only.
- Preserve existing slash commands, file completion, custom editors, image attachments, and message-delivery behavior.

The submitted user message contains the links: Pi persists transformed input rather than retaining a separate raw shorthand message. Models choose when to read the linked documents; this package neither reads their full contents into the prompt nor guarantees model compliance.

## Verified integration points

Consult these seams before implementation; the installed Pi version is the runtime authority (investigated against 0.85.1):

| Need                          | Existing seam                                           | Constraint                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue on the first prompt | `pi.getCommands()`, filtering `source === "skill"`      | Strip the `skill:` prefix; use `description` and `sourceInfo.path`. Call after runtime binding, not in the extension factory body.                             |
| Current resources             | Re-query that catalogue when completing or transforming | No independent scan, cache invalidation scheme, or dependency on a prior agent turn. Includes Skills even when `enableSkillCommands` is false.                 |
| Native popup                  | `ctx.ui.addAutocompleteProvider(factory)`               | Stack over the current provider; preserve its triggers and delegate unrelated operations.                                                                      |
| Name matching                 | `fuzzyFilter` from `@earendil-works/pi-tui`             | Reuse native matching; exact matching still governs submission.                                                                                                |
| Submission                    | `pi.on("input", ...)`                                   | Inspect `source`; transform only interactive/RPC input. This hook runs before native Skill/template expansion and after extension-command dispatch.            |
| Markdown awareness            | Pi TUI exports `Marked`                                 | Prefer the existing tokenizer where it preserves source positions; verify literal protection and byte preservation before choosing the parsing implementation. |

Source references:

- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`: `ExtensionAPI.getCommands`, `ExtensionUIContext.addAutocompleteProvider`, `InputEvent`, `InputEventResult`.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.d.ts` and `source-info.d.ts`: catalogue metadata.
- `.repos/pi/packages/coding-agent/src/core/agent-session.ts`, `_bindExtensionCore`: commands derived from the loaded Skills, independent of slash-popup registration.
- `.repos/pi/packages/tui/src/autocomplete.ts`: provider contract and native completion behavior.
- `packages/pi-minimal-subagents/src/minimal-subagents-extension.ts`: existing editor wrapper to compose with, not replace.

Read Pi's installed `docs/extensions.md` (autocomplete and input events), `docs/skills.md`, and their relevant TUI/example references before wiring the extension. Reference repositories are read-only.

## Implementation sequence

### 1. Establish the package and reference-recognition seam

Follow the source-TypeScript package convention in [`ADR-0002`](../adr/0002-publish-pi-extensions-as-source-typescript.md), using `packages/pi-todo/package.json` and `tsconfig.json` as packaging references. Add only the peers actually imported, retaining the repository's wildcard Pi-peer convention.

Start with `src/index.ts`, an extension module, and a small pure reference-recognition/conversion module. Separate autocomplete into another file only if its size warrants it. Keep the existing glossary; behavioral requirements live in this plan and the eventual README, not in `CONTEXT.md`.

Write failing reference-conversion tests before implementation. Recognize complete tokens, not prefixes of longer names. Share literal-context recognition between submission and completion so the menu does not offer a reference that submission will ignore.

Use the existing Markdown tokenizer if it supports source-preserving edits at this seam. Establish that with tests before integrating it. Apply replacements to the original source rather than rendering or reserializing Markdown. Preserve whitespace, line endings, punctuation, and unrelated text. Link destinations must safely represent spaces, parentheses, fragments, and other Markdown-significant path characters without changing the target.

**Complete when:** focused tests turn green for multiple references, exact-name matching, literal protection, path escaping, and unchanged surrounding bytes. The conversion is idempotent: a second pass leaves existing links unchanged. No new parsing dependency is necessary unless the existing facility is demonstrably insufficient.

### 2. Wire catalogue lookup and input transformation

Derive the catalogue from `pi.getCommands()` after binding. Use Pi's winning entries and paths directly rather than reconstructing filesystem discovery or collision resolution. Missing usable path metadata means no reference can be produced for that entry; never invent a path.

Register an input handler that returns `continue` for extension-originated or unchanged input and `transform` for changed interactive/RPC text. Preserve attachments and let Pi retain the original steering/follow-up routing. Perform one in-place conversion pass; send no additional messages and invoke no tools.

**Complete when:** tests exercise the registered handler with first-prompt, interactive, RPC, steering, follow-up, and extension-source cases. They verify attachments survive, unknown references remain literal, current catalogue changes are observed, and there is no duplicate message or delivery-mode change.

### 3. Add native autocomplete

In TUI mode, register a stacked provider through the documented lifecycle. Add `$` to the current trigger characters. For an eligible token at the cursor, return native items containing the Skill name and description; bare `$` lists the catalogue, and subsequent characters use native fuzzy matching.

Selection inserts shorthand and follows ordinary completion spacing/cursor behavior. Preserve text after the cursor and other lines. Delegate non-Skill suggestions, completions, and explicit file-completion checks to the prior provider, including cancellation options. Retain native keyboard navigation, acceptance, dismissal, list-height settings, and theming.

**Complete when:** provider tests cover bare/partial tokens, a second reference, middle-of-line and multiline editing, protected literal contexts, no matches, native-provider delegation, and lifecycle re-registration. A reload does not accumulate duplicate providers. Normal `/` and `@` completions and the subagent editor wrapper continue to work.

### 4. Finish repository integration and user documentation

- Add package metadata, `LICENSE`, `README.md`, and package-local test/typecheck scripts consistent with neighboring extensions. Publish `src`, not generated extension bundles.
- Add a concise diagnostic skill at `skills/pi-skills-selector/SKILL.md` and declare `pi.skills`. Current package checks require one support skill per extension. Its trigger branches should cover missing autocomplete and missing/wrong link conversion; point to the README instead of copying the behavioral contract.
- Register the extension and support-skill directories in root `package.json`; update root README discovery/install lists and promote the planned entry in `CONTEXT-MAP.md` into the package table.
- Refresh the lockfile and use the existing Changesets workflow for the initial release. Do not publish as part of implementation verification.
- Update fixed package/extension counts in `scripts/check-package-packs.mjs` and `scripts/check-git-install.mjs`, including their diagnostics: this addition takes the current 14 packages / 13 extensions to 15 packages / 14 extensions, with 14 support skills. Reconcile against the checkout if other packages have landed meanwhile; retain the integrity checks.

**Complete when:** both npm-package and root Git-install manifests discover the extension and its support skill, documentation describes the accepted behavior, and package integrity checks pass.

### 5. Verify the actual user experience

Use the existing Vitest setup and repository checks. Run:

```sh
pnpm --filter @ian-pascoe/pi-skills-selector test
pnpm --filter @ian-pascoe/pi-skills-selector typecheck
pnpm verify
pnpm pack:check
pnpm git-install:check
```

Drive a real Pi TUI with the terminal-control workflow, using isolated fixture skills and a controlled session. Record evidence for:

1. `$` opening a native popup; fuzzy filtering, descriptions, keyboard selection, dismissal, and adding a second reference.
2. Typing/pasting and cursor edits retaining shorthand; submission producing the correct links without full Skill contents. Inspect the stored user message rather than relying on the model to claim it received them.
3. Unknown variables, escaped references, inline/fenced code, and existing links remaining unchanged. Include indented code, multiline links, CRLF, and Unicode surrounding text in automated literal-preservation tests.
4. Ordinary slash/path completion and the existing subagent editor wrapper working alongside the selector.
5. First prompt and `/reload` seeing the correct catalogue, with no duplicate popup entries. Include `disable-model-invocation` Skills and `enableSkillCommands: false`.
6. Steering/follow-up and RPC messages containing exactly one transformed user message, with attachments and delivery semantics preserved; extension-generated messages remain unchanged.

Use deterministic fixtures or a stub model for message-path checks rather than spending live model calls to infer transformation behavior. Clean up fixture sessions/files after collecting evidence.

**Complete when:** automated checks and real-editor evidence cover the accepted behaviors. A missing live verification is an explicitly reported gap, not a passing result.

## Boundaries

This package adds reference selection and conversion only. It reuses Pi's editor, resource catalogue, and input pipeline. Separate discovery settings, a custom multi-select UI, hidden mention metadata, sticky Skill activation, automatic content injection, and Codex backend integration are outside scope.

## Current handoff

The user authorized implementation, verification, review, and a commit on the current branch.

### Upstream RPC limitation

Live verification against Pi 0.85.1 found that direct RPC `steer` and `follow_up` bypass `input` hooks. RPC `prompt` with `streamingBehavior: "steer"` or `"followUp"` does pass through the hook and supports conversion. The implementation retains the public-API boundary; direct RPC commands remain an unmet portion of the original routing requirement rather than being silently patched through private Pi internals.

### Verification record

- Package tests cover reference conversion, source preservation, native autocomplete, and the registered input handler. Review regressions include quoted multiline links, paragraph boundaries, tabbed lists, single-tilde formatting, catalogue names with punctuation, and escaped table pipes.
- `pnpm verify`, `pnpm pack:check`, `pnpm git-install:check`, and `pnpm changeset:status` passed. Packaging discovers 15 packages, 14 extensions, and 14 support skills.
- Real Pi 0.85.1 PTY checks used an isolated local stub model. Verified first-prompt completion, fuzzy matching/descriptions, multiple references, paste, dismissal, native slash/path completion, reload, explicit-only Skills, and the subagent editor wrapper.
- Stored user messages were inspected directly. Terminal and RPC `prompt` steering/follow-ups retain routing and attachments; extension input remains unchanged. Direct RPC bypasses were reproduced separately rather than counted as successes.
- Two-axis review resolved the metadata naming and parser findings. The documented upstream RPC gap is the only remaining review finding.
- Local verification scripts and bounded screenshots/transcript evidence are retained under `.scratch/skill-selector-live/`; named PTYs were stopped and isolated fixture data cleaned. No remote model requests or publishing were performed.
