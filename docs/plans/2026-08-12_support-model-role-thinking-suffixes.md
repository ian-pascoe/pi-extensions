# Support preferred thinking suffixes in Minimal Subagents model roles

**Status:** Ready for implementation

## Outcome

Allow both forms of `minimalSubagents.modelRoles` to append a recognized Pi thinking level to a fully qualified model ID:

```json
{
  "minimalSubagents": {
    "modelRoles": {
      "budget": "opencode-go/glm-5.2:low",
      "design": {
        "model": "opencode-go/kimi-k3:high",
        "hint": "UI design, visual critique, and frontend polish"
      }
    }
  }
}
```

Resolve each suffixed role into a canonical model plus an advisory thinking preference. Show those as separate `model` and `thinking_level` values in the `subagent` tool guidance; callers must continue passing the existing tool arguments separately.

Read before implementation:

- [`../../packages/pi-minimal-subagents/CONTEXT.md`](../../packages/pi-minimal-subagents/CONTEXT.md)
- [`../agents/domain.md`](../agents/domain.md)
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-capabilities.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-capabilities.ts)
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-config.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-config.ts)
- [`../../packages/pi-minimal-subagents/src/minimal-subagents-tools.ts`](../../packages/pi-minimal-subagents/src/minimal-subagents-tools.ts)

This extends existing advisory Model Roles without changing the Launch Contract or Runtime Profile. It is reversible and needs no ADR or domain-glossary change.

## Boundaries

- Keep Model Roles advisory: add no task classifier, role selector, router, role argument, or enforced launch default.
- Keep the `subagent` tool schema unchanged. Its `model` argument accepts canonical eligible IDs, and its `thinking_level` argument remains separate.
- Keep global/project role merging, expanded-object field merging, role deletion, `modelRoles: null`, validation limits, and consolidated startup warnings unchanged.
- Keep `enabledModels` responsible only for model eligibility. A thinking level pinned there neither supplies nor constrains a role's preference.
- Keep model-capability resolution at spawn time. `resolveThinkingLevel()` continues clamping the caller's explicit `thinking_level`; settings parsing does not inspect model reasoning metadata.
- Preserve exact model IDs containing colons, including IDs whose final component is itself a recognized thinking word.
- Add no Registry, persistence, restoration, session, status, rendering, or UI change.

## Implementation sequence

### 1. Preserve eligible model IDs verbatim

Update `minimal-subagents-capabilities.ts` so `buildEligibleModelIds()` constructs each canonical `${provider}/${id}` without removing a recognized final suffix. Pi already represents an `enabledModels` thinking pin separately as `ScopedModelReference.thinkingLevel`; the model object's `id` is the source of truth for identity.

Remove or replace `stripThinkingSuffix()`. A context-free stripping helper cannot distinguish a requested thinking suffix from a real model ID, so suffix interpretation belongs in role validation where the exact eligible-ID set is available. Keep `THINKING_LEVELS` as the single list shared by tool-schema validation and role-suffix recognition.

Update `test/capabilities.test.ts` to prove:

- a scoped entry such as `{ model: { provider: "openai", id: "gpt" }, thinkingLevel: "xhigh" }` yields `openai/gpt`;
- real IDs such as `ollama/llama3.1:8b` remain unchanged;
- a real ID ending in `:high` remains unchanged;
- duplicate canonical IDs are still removed in source order.

**Complete when:** eligibility reflects model identity only, scoped thinking pins stay out of canonical IDs, and no helper can silently truncate a colon-bearing model ID.

### 2. Parse optional role thinking preferences after exact matching

Update `minimal-subagents-config.ts` and `MinimalSubagentsModelRole` to retain an optional typed thinking preference alongside the canonical `model`. Use the codebase's TypeScript naming convention internally (for example, `thinkingLevel`) and render it as the tool argument name `thinking_level` at the prompt boundary.

For every validated model string, resolve in this order:

1. If the complete authored value is in the eligible-ID set, accept it verbatim with no role thinking preference.
2. Otherwise, inspect only the text after the final colon. If it is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` and the prefix is eligible, store the prefix as `model` and the suffix as the role's thinking preference.
3. If the prefix is eligible but the final token is not recognized, omit the role and emit a targeted warning such as `unknown thinking level suffix: turbo`.
4. Otherwise, omit the role with the existing model-not-eligible diagnostic.

Apply the same resolution after global/project merging to shorthand strings and expanded role objects. Exact matching must win even when both `provider/model:high` and `provider/model` are eligible; this is the ambiguity rule that protects real model IDs.

Update `test/config.test.ts` with focused cases covering:

- recognized suffixes in both shorthand and expanded forms;
- all seven values in `THINKING_LEVELS`;
- preservation of hints and existing project-over-global merge behavior;
- exact eligible colon-bearing IDs, including an exact ID ending in `:high`;
- a targeted unknown-suffix warning when the unsuffixed prefix is eligible;
- the existing unavailable-model warning when neither the full value nor its prefix is eligible;
- unsuffixed roles remaining structurally unchanged apart from the optional field being absent.

**Complete when:** every valid role resolves to one canonical eligible model plus at most one thinking preference, exact IDs always win, and invalid entries remain isolated from valid roles.

### 3. Render model and thinking guidance as separate tool arguments

Update `buildModelRolePromptGuidelines()` in `minimal-subagents-tools.ts` so each role names the actual `subagent` fields instead of displaying a combined model reference:

```text
  - budget → model=opencode-go/glm-5.2, thinking_level=low
  - design → model=opencode-go/kimi-k3, thinking_level=high — UI design, visual critique, and frontend polish
```

Render unsuffixed roles with `model=...` and no fabricated thinking value. State once that a listed `thinking_level` is a preference rather than a constraint and that callers choose `thinking_level` independently for roles without one. Keep the existing statement that configured roles are guidance rather than constraints.

Update `test/tools.test.ts` to inspect the generated `subagent` definition's `promptGuidelines` and assert:

- suffixed settings produce separate `model=` and `thinking_level=` guidance;
- the combined `provider/model:thinking` string is absent from guidance;
- hints retain their placement;
- unsuffixed roles instruct independent thinking selection;
- an empty role list still contributes no role-specific prompt guidelines.

Use the public tool-definition output as the test seam; do not export a prompt-only helper solely for tests.

**Complete when:** a caller can copy the advertised values directly into the existing separate tool fields, while the prompt still permits overriding every advisory preference.

### 4. Document the settings contract and release it

Update the Model Roles section of `packages/pi-minimal-subagents/README.md`:

- show suffixes in both shorthand and expanded examples;
- define a suffix as a preferred `thinking_level`, not part of the canonical model passed to `subagent`;
- state that unsuffixed roles leave thinking selection independent;
- document exact-model-first handling for real colon-bearing IDs;
- state that `enabledModels` thinking pins do not constrain role preferences and that normal spawn-time clamping still applies;
- replace the current sentence that declares thinking suffixes invalid.

Keep the README as the single user-facing source for configuration behavior. Add a patch Changeset for `@ian-pascoe/pi-minimal-subagents` describing preferred thinking suffixes in Model Roles. Do not edit the package version directly; retain the existing unrelated Changeset.

**Complete when:** the examples can be translated directly into valid settings, the advisory and ambiguity semantics are explicit, and `pnpm changeset:status` includes the intended package bump.

### 5. Verify package and repository behavior

Run in order:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-minimal-subagents typecheck
pnpm --filter @ian-pascoe/pi-minimal-subagents test
pnpm changeset:status
pnpm verify

git status --short
```

Inspect the final diff and test output. Confirm that:

- every recognized suffix works in both role forms;
- exact colon-bearing model IDs survive eligibility and configuration unchanged;
- prompt guidance never suggests a suffixed value for `subagent.model`;
- `createCoordinatorToolSchemas()`, `MinimalSubagentsCoordinator.spawn()`, `LaunchContract`, and `resolveThinkingLevel()` have no behavioral changes;
- no unrelated formatting or package-version change entered the diff.

**Complete when:** all commands pass and the final diff is confined to model-role eligibility/parsing, advisory prompt guidance, tests, README documentation, and one patch Changeset.
