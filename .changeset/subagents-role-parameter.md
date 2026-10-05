---
"@ian-pascoe/pi-minimal-subagents": minor
---

`subagent` now accepts an optional `role` naming a configured model role (`minimalSubagents.modelRoles`), so the agent no longer translates each role into `model` and `thinking_level` by hand. The role resolves to its model and, when it has a suffix, its thinking level; an explicit `model` or `thinking_level` overrides the role's value, and an unknown role fails before any child is created, listing the configured role names. The Launch Contract records the resolved model and thinking level plus the `role` used, and `subagent_status` and the expanded `subagent` result show it; Registry V2 persists `role` as an optional Launch Contract field, so existing sessions and V1 records load unchanged. `role` is a plain string, not an enum of the configured names, so the tool definition stays byte-identical when `modelRoles` changes; only the role list in the system prompt changes, and only at reload.
