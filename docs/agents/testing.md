# Tests

A test earns its place by catching a regression no other test catches. Size the suite by behaviours, not by inputs: every test costs CI time and an edit each time the behaviour it pins legitimately changes.

## Before adding a test

1. Name what it protects: a user- or model-visible contract, a required contract from `AGENTS.md`, a branch of our source, or a bug that shipped.
2. Search the package's tests, and the root `test/` for combined modes, for one that already reaches it. When one does, add the missing assertion there.
3. Test at one **seam**: the highest layer that observes the behaviour cheaply. Drop to a lower layer only for logic the higher one can't reach cheaply, such as parser branches and edge cases.

## Shape

- **Tables:** one row per branch the source takes, with the row label naming the branch. Security tables (command safety, tool policy, redaction, integrity) follow the same rule; read the source to find the branches.
- **Rendering:** one representative test per component, plus one per state with logic (collapse and expand, truncation, width fitting). Match the meaningful fragment with `toContain` or a regex.
- **Text the model or user reads** (descriptions, prompts, help, labels, notices): assert the dynamic parts. Static prose changes freely in source. Cache-prefix proofs compare outputs across turns, reloads, and modes rather than against a stored literal or hash.
- **Expected values** come from an independent literal or worked example, never recomputed the way the code computes them or copied from source data.
- **Observation:** assert results through the public surface, with fakes only at system boundaries (network, child processes, clock, filesystem). Assert call counts or ordering only when they are the contract, such as one provider request or a concurrency cap.
- **Ownership:** test our code. Pi, TypeBox validation, Node, git, and other dependencies are trusted; a test that loads none of our code tests a dependency. A test lives in the package that owns the behaviour; root `test/` holds combined modes only.
- **Lifecycle:** removing a feature removes its tests. `pack:check` guards shipped files such as skills and docs.
- **Speed:** use the smallest fixture that reaches the branch. Real processes, multi-megabyte inputs, and timeouts above the 20 s default carry a reason in the test name or a comment, and each real external tool gets one integration test per behaviour no fake can show.

## Review

Review added tests against this doc as a coding standard: a test that duplicates another, restates static text, recomputes its expected value, or tests a dependency is a finding.
