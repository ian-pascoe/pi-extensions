---
"@ian-pascoe/pi-utils": minor
"@ian-pascoe/pi-advisor": patch
---

Add `@ian-pascoe/pi-utils/settings-menu` (`ValueInput`, `ModelPicker`, `nextCycleValue`, `errorText`) and `@ian-pascoe/pi-utils/settings-command` (`parseSettingsCommand`, `completeSettingsCommandArguments`), the settings menu widgets and `/command [on|off|status|inherit|set] [--global|--project]` parsing that Advisor and Guardian shared by copy. `./settings-menu` needs the optional `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` peers. Advisor now uses them internally without changing behavior.
