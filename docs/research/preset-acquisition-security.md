# Preset acquisition security findings

Date: 2026-09-12. Investigation during implementation of the
[accepted expansion](../plans/language-tool-preset-expansion.md).
The user approved the exact Svelte exception on 2026-09-13. It is now enabled
only for the Svelte language-server preset; other acquisition policies are unchanged.

## Svelte maintenance release

Private mise 2026.9.5 acquisition of `svelte-language-server@0.18.4` fails on its
transitive `svelte@4.2.20` dependency. Embedded aube 2.2.13 compares publishing
chronology across major versions: provenance-bearing Svelte 5.0.0 was published
on 2024-10-19, before the manually published 4.2.20 maintenance release on
2025-05-20. This is a genuine loss of provenance metadata, not a platform failure.

Independent read-only checks found no tampering in the investigated artifacts:

- The official release documents the event-listener removal fix in
  [PR #13556](https://github.com/sveltejs/svelte/pull/13556).
- The npm tarball's SHA-512 matches its registry integrity, and the npm ECDSA
  registry signature verifies. Registry signing is not build provenance.
- All 233 packaged `src/` files byte-match the official release tag.
- Against 4.2.19, 246 files are unchanged; other differences are version literals,
  the documented fix, and declaration-map offsets. No new scripts/dependencies.
- The annotated release tag is unsigned; no Git-signature claim is made.

Verified tarball integrity:

```text
sha512-eeEgGc2DtiUil5ANdtd8vPwt9AgaMdnuUFnPft9F5oMvU/FHu5IHFic+p1dR/UOB7XU2mX2yHW+NcTch4DCh5Q==
```

Mise offers a narrow native selector:

```text
npm:svelte-language-server[trust_policy_excludes=svelte@4.2.20]
```

It exempts only that package/version from this private installation's publishing
trust comparison. Integrity verification, lifecycle-script denial, and other
package checks remain. It is **not independently digest-bound** and does not
exempt future Svelte versions. The user explicitly approved this exception before
it was enabled. A native Linux x64 regression first reproduced the trust failure
without it, then acquired Svelte language server 0.18.4 with the exact exception
using mise 2026.9.6, Node 26.8.2 and TypeScript SDK 6.0.3. Script hover returned the
expected symbol/type without creating project dependencies. The same native test
checks that both the installed selector and the explicit update plan retain only
`svelte@4.2.20` as the exception. Other platforms remain subject to the matrix gate.

Primary sources:

- [Official release](https://github.com/sveltejs/svelte/releases/tag/svelte%404.2.20),
  commit `49d1f1d2655c376b6b59fb7934958a566790b055`.
- [npm metadata](https://registry.npmjs.org/svelte) and
  [registry signing keys](https://registry.npmjs.org/-/npm/v1/keys).
- [Mise npm backend](https://github.com/jdx/mise/blob/v2026.9.5/src/backend/npm.rs)
  and [dependency pin](https://github.com/jdx/mise/blob/v2026.9.5/Cargo.lock).
- [Aube trust comparison and exceptions](https://github.com/jdx/aube/blob/v2.2.13/crates/aube-resolver/src/trust.rs).

## HTTP artifacts and immutable identity

Mise can natively extract the official ESLint VSIX through its HTTP backend. Its
`checksum_url` option is resolved during locking, not ordinary installation;
installation must receive the resolved native `checksum=sha256:...` option.

An additional native proof found that an already-installed HTTP name/version skips
verification even when URL/checksum options change. With ESLint 3.0.34 already
present, an all-zero checksum reported "already installed". A renamed corrupt
installation does not exercise this case.

The shared installer now isolates HTTP acquisition by resolved concrete artifact
options/checksum and prerequisite graph, using the existing native namespace
pattern rather than destructive `--force` replacement. A public-API regression
first reproduced acceptance of changed checksum options for the same name/version,
then passed after isolation. Native package-level re-verification remains part of
the expansion gates; this document is not a six-platform support claim.

Sources:

- [Native HTTP installation checks](https://github.com/jdx/mise/blob/v2026.9.5/src/backend/http.rs).
- [Official ESLint VSIX metadata](https://open-vsx.org/api/dbaeumer/vscode-eslint/3.0.34).
- [Official published SHA-256](https://open-vsx.org/api/dbaeumer/vscode-eslint/3.0.34/file/dbaeumer.vscode-eslint-3.0.34.sha256):
  `ca5334d46f6a39079e751ef4601bfc9f86bc3a46483e87291ec609239d161308`.
