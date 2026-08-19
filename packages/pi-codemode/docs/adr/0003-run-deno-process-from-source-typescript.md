# Run the shipped TypeScript process with pinned Deno

Node 22.19 can erase supported TypeScript in the workspace, but both Node and
Deno's manual `node_modules` compatibility mode intentionally reject type
stripping for entrypoints under `node_modules`. CodeMode therefore starts the
shipped `src/codemode-worker.ts` with the official exact `deno@2.9.5` npm
runtime and `--node-modules-dir=none`.

One package module resolves Deno's installed platform package and QuickJS's
installed ES-module entrypoints with Node's package resolver. It supplies those
QuickJS entrypoints as an in-memory `data:` import map, so Deno can execute
source TypeScript from a tarball installation without downloading, transpiling,
bundling, or writing generated runtime files. The release-sync QuickJS package
directory is the only filesystem read grant needed for its WASM asset. Network,
environment, system information, subprocess, write, FFI, and remote import
capabilities are denied and permission prompts are disabled.

The Node 22 tarball smoke check copies that same launch module to a temporary
directory before importing it, because Node intentionally refuses to strip
TypeScript located under `node_modules`. The copy is test-only and keeps Deno
launch policy in one source module.

The repository does not trust Deno's convenience postinstall script; it runs the
platform binary already delivered by Deno's optional dependency. Workspace,
actual tarball-install, and clean production Git-copy checks execute the shipped
process under parent Node 22.19.0. The supported operating-system and CPU set is
therefore the set shipped by the pinned official Deno npm package.
