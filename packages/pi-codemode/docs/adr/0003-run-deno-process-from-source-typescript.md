# Run source TypeScript and Cells with pinned Deno

Node 22.19 can erase supported TypeScript in the workspace, but both Node and
Deno's manual `node_modules` compatibility mode intentionally reject type
stripping for entrypoints below `node_modules`. CodeMode therefore starts the
shipped `src/codemode-worker.ts` with the official exact `deno@2.9.5` npm runtime
and `--node-modules-dir=none`.

Repository packages normally write local source imports with `.js` specifiers.
The Deno worker's transitive local imports use explicit `.ts` specifiers because
this source-executed graph runs directly under Deno rather than Node's package
loader.

The worker imports each generated Cell as a unique `Blob` whose media type is
`application/typescript`. Deno transpiles that Cell without type checking and
executes the resulting module. The package-local `typescript@6.0.3` parser
matches Deno's bundled compiler and only plans source-range Notebook Binding
rewrites; it does not transpile or type-check guest code. Blob URLs also keep
generated helper source out of ordinary source locations.

No import map, guest filesystem grant, WASM asset, build output, generated
runtime file, or download is required. Network, environment, system
information, subprocess, write, FFI, and remote import permissions are denied,
and permission prompts are disabled.

The Node 22 tarball smoke check copies the launch module to a temporary directory
before importing it because Node intentionally refuses to strip TypeScript below
`node_modules`. Workspace, actual tarball-install, and clean production Git-copy
checks execute the shipped worker under parent Node 22.19.0. The supported
operating-system and CPU set is therefore the set shipped by the pinned official
Deno npm package.
