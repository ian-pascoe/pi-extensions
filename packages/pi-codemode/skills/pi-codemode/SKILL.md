---
name: pi-codemode
description: Configure or diagnose Pi CodeMode when tools disappear, Cells fail, Sessions reach capacity, or Exposure Modes route tools incorrectly.
license: MIT
---

# Pi CodeMode

1. Read the relevant Cell, Session, or Exposure Mode section of [`../../README.md`](../../README.md).
2. Inspect disable warnings and call `codemode_sessions`.
3. When an unused slot exists, run `return { ok: true, deno: Deno.version.deno };` in a new Cell and inspect the generated exposed-tool declarations.
4. Classify any stable error code using that reference. Verify nested execution only with a declared, non-mutating tool.
5. For an Exposure Mode change, compute the winning rule for the affected tool, edit the intended layer, and list live Sessions before `/reload`.
6. Finish when the minimal Cell succeeds and the affected tool has the intended direct and CodeMode availability.

Direct availability does not imply CodeMode exposure. `/reload` destroys live Sessions and their Notebook Bindings.
