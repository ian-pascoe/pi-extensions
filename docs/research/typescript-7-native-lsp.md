# TypeScript 7 native LSP

## Finding

For managed TypeScript tooling, resolve the latest stable `typescript` npm package
(`7.0.2` at probe time) and launch its single `tsc` entry point with private Node:

```text
<private-node> <typescript-package>/bin/tsc --lsp --stdio
```

Do **not** use `typescript-language-server` (6.0.0) for this path: it expects the
removed `lib/tsserver.js`. The TypeScript 7 package has no `tsserver` bin; its
published `bin` map contains only `tsc`.

The TypeScript 7 release announcement says the native compiler is installed as
`typescript`, provides LSP support, and is intended for modern editors. The
published package's `lib/tsc.js` is a small launcher: it resolves the platform
binary and forwards all arguments, including `--lsp --stdio`. The release source
selects the LSP mode from `--lsp`; its LSP command accepts `--stdio` and uses
stdin/stdout for JSON-RPC (stderr remains available for diagnostics).

The repository's native probe drove the published `typescript@7.0.2` launcher
through Pi's real LSP client on Linux x64. `initialize` and a document-symbol
request succeeded for both a TypeScript file and a JavaScript file. This is direct
protocol evidence for the recipe, not merely a version or executable check.

## Native package coverage

`typescript@7.0.2` declares these platform packages (all at exactly `7.0.2`):

| Platform      | npm package                           |
| ------------- | ------------------------------------- |
| Linux x64     | `@typescript/typescript-linux-x64`    |
| Linux ARM64   | `@typescript/typescript-linux-arm64`  |
| macOS x64     | `@typescript/typescript-darwin-x64`   |
| macOS ARM64   | `@typescript/typescript-darwin-arm64` |
| Windows x64   | `@typescript/typescript-win32-x64`    |
| Windows ARM64 | `@typescript/typescript-win32-arm64`  |

Each platform package is an OS/CPU-scoped Microsoft package containing `lib/tsc`
(or `lib/tsc.exe` on Windows). Registry metadata marks the six packages with the
corresponding `os`/`cpu` pair and supplies an npm integrity digest. This proves
that release assets are declared and published; it is not a substitute for native
execution evidence on every cell. The six-cell native matrix remains a release
gate.

## Limits

The stable native LSP is the correct TS7 integration seam, but TypeScript 7.0 has
no stable programmatic compiler API yet. Workflows that embed TypeScript (for
example template-language integrations or LSP plugins requiring the old API) may
still require TypeScript 6. The native repository also describes LSP as nearly
complete rather than claiming old `tsserver` protocol parity. The managed-tool
probe should therefore test the LSP operations Pi actually relies on, rather than
assuming every legacy command is available.

`@typescript/native-preview` is not required for this stable release. Microsoft’s
native-preview documentation describes it as the earlier preview package; the
stable release announcement says the native implementation is now published as
`typescript` and uses `tsc`.

## Primary sources

- [TypeScript npm `7.0.2` registry metadata](https://registry.npmjs.org/typescript/7.0.2) — version, one `tsc` bin, Node engine, and platform-package dependencies.
- [Linux x64 package metadata](https://registry.npmjs.org/@typescript%2ftypescript-linux-x64/7.0.2), [Linux ARM64](https://registry.npmjs.org/@typescript%2ftypescript-linux-arm64/7.0.2), [macOS x64](https://registry.npmjs.org/@typescript%2ftypescript-darwin-x64/7.0.2), [macOS ARM64](https://registry.npmjs.org/@typescript%2ftypescript-darwin-arm64/7.0.2), [Windows x64](https://registry.npmjs.org/@typescript%2ftypescript-win32-x64/7.0.2), and [Windows ARM64](https://registry.npmjs.org/@typescript%2ftypescript-win32-arm64/7.0.2) — OS/CPU declarations and tarball integrity metadata.
- [Published `lib/tsc.js` launcher](https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz) — package tarball containing the launcher and native-binary forwarding implementation.
- [Microsoft: Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) — stable npm installation, native `tsc`, LSP support, and API/embedded-language limitations.
- [Microsoft TypeScript 7 native source (`tsc/cmd/tsgo/lsp.go`)](https://github.com/microsoft/TypeScript/blob/v7.0.2/tsc/cmd/tsgo/lsp.go) — release source for `--stdio` and stdio transport.
- [Microsoft TypeScript native-port source README](https://github.com/microsoft/TypeScript/blob/v7.0.2/tsc/README.md) — native LSP status and preview-to-stable transition.
