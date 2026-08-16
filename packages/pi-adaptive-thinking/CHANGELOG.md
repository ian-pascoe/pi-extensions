# pi-adaptive-thinking

## 0.2.1

### Patch Changes

- 00e8819: Refactor AI overengineering

## 0.2.0

### Minor Changes

- fe56c9f: Keep prompt caching stable by replacing per-turn system-prompt mutation with static tool guidance. Add `get_thinking_level` for inspecting native current and model-supported levels, plus `guidance` and `statusToolName` configuration. The former `systemPrompt` field remains a deprecated alias during the `0.x` release line.

## 0.1.2

### Patch Changes

- 1c87f4a: Migrate the extension to the shared source-TypeScript monorepo package contract.

## 0.1.1

### Patch Changes

- [#3](https://github.com/ian-pascoe/pi-adaptive-thinking/pull/3) [`e7f983c`](https://github.com/ian-pascoe/pi-adaptive-thinking/commit/e7f983c73b8c0e7616d1b19f789811206bd96fc6) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Keep thinking level changes scoped to the active session instead of persisting them as the global default thinking level.

## 0.1.0

### Minor Changes

- [#1](https://github.com/ian-pascoe/pi-adaptive-thinking/pull/1) [`24cbfb9`](https://github.com/ian-pascoe/pi-adaptive-thinking/commit/24cbfb9da48027d65f4e91807cdd2f06ae187af2) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Add the initial Pi adaptive thinking extension with configurable reasoning-effort tool, TypeBox config validation, documentation, CI, and Changesets release automation.
