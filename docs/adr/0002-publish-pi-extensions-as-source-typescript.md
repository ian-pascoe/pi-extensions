# Publish Pi extensions as source TypeScript

Pi extension packages publish their `src` directories and point `pi.extensions` directly to `./src/index.ts`; they do not generate or publish `dist`, `main`, `types`, or `exports` artifacts. Package TypeScript uses NodeNext semantics with explicit `.js` specifiers for local imports, while Pi-provided modules remain wildcard peer dependencies. The previous Rolldown and declaration builds added release complexity without serving Pi's runtime, which loads TypeScript extensions directly.

`@ian-pascoe/pi-utils` is a reusable library rather than a Pi extension. It therefore publishes compiled JavaScript and declarations from `dist` behind a conventional `exports` contract so installed extension packages can load it through Node without relying on Pi's TypeScript extension loader.

Pi DAP additionally bundles two ahead-of-time Windows runtime-preflight helpers
under `src/native`, a narrow native-asset exception rather than compiled extension
entrypoints. Atomic Job containment cannot be provided by Node's post-spawn
process APIs; checked-in x64/ARM64 payloads avoid requiring an end-user compiler,
SDK, or installation hook. Pinned build-time tools reproduce their bytes in CI,
package/Git-install checks retain those bytes and architectures, and native
Windows tests verify cleanup; Debug Session ownership and source TypeScript
loading remain unchanged. See the [helper contract](../../packages/pi-dap/native/README.md)
and [rejected alternatives](../research/windows-preflight-process-ownership.md).
