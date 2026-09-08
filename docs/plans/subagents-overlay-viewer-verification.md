# Subagents overlay viewer verification

## Automated checks

Focused red/green runs cover the public widget, panel/controller, extension lifecycle, session-factory/runtime, and coordinator seams named in the plan.

- Final `pnpm test`: **948 tests across 100 files and 14 packages passed**. Pi Minimal Subagents: **195 tests across 19 files passed**.
- Workspace `pnpm typecheck`, package Oxlint and formatting checks, and `git diff --check` passed.

## Two-axis code review

Reviewed against pre-implementation commit `52de485607a2daf020584861634a6082737fdf04` with independent Standards and Spec reviewers.

- **Standards:** No hard documented-standard or ADR violations. One optional simplification remains: the image-placeholder mapping in `minimal-subagents-context.ts` repeats across user/custom and tool-result branches.
- **Spec:** Three consequential findings were reproduced with failing tests and fixed: finalized output disappearing while asynchronous `message_end` hooks await persistence; cached tool output surviving selected-branch retreat; and single-line Up scrolling getting stuck on native message padding. The reviewer independently reran the panel/session tests (**37 passed**) and confirmed all three fixes, with no remaining Spec findings.

## Native PTY evidence

Exercised Pi 0.85.1 through Terminal Control at 112×34 and 64×18. The [manual fixture](../../packages/pi-minimal-subagents/test/fixtures/subagents-viewer-pty.ts) loads the real extension, editor composition, command, widget, controller, overlay compositor, and transcript components. It supplies synthetic Child Agent snapshots and advancing Root Agent heartbeat messages; it makes no provider/model calls. Persisted-history ownership and streaming settlement are covered by the automated session/coordinator tests, not simulated as live model work here.

- `/subagents` displayed a centered, filled frame. The idle parent with a running descendant preceded the later running root and the originally first idle root. The compact widget retained that parent above its running child.
- Enter opened the selected transcript at the latest output. Page Up paused on earlier turns; updates continued. Resizing retained the same historical passage. End resumed following at `Live output 41` after the initial `Live output 0`.
- Old conversation content, visible reasoning, and an image placeholder remained accessible. Ctrl+O expanded historical tool output from a ten-line preview to all forty lines.
- Escape returned to the tree, then closed. Double Left reopened the same viewer.
- `/draft-viewer` restored `retained draft: do not clear me` after closing. Double Left in that draft did not open the viewer; typing `X` after the two cursor moves produced `retained draft: do not clear Xme`.
- Double Left while `/viewer-dialog` had focus left the native selection dialog open.
- All named Terminal Control sessions were stopped after verification.

The first PTY pass exposed native user-message OSC 133 prompt markers corrupting an embedded overlay. The viewer now removes those main-terminal markers while retaining native message rendering; a regression test covers the boundary.

[Full history, reasoning, image placeholder, and collapsed tool output](subagents-overlay-viewer-evidence/history-collapsed.png)

[Paused transcript after narrowing the terminal](subagents-overlay-viewer-evidence/narrow.png)

### Reproduce

From the repository root, with `pi` and `termctrl` installed:

```bash
agent_dir=$(mktemp -d)
termctrl start subagents-viewer --cols 112 --rows 34 -- \
  env PI_CODING_AGENT_DIR="$agent_dir" PI_OFFLINE=1 pi \
  --offline --no-approve --no-session --no-extensions --no-skills \
  --no-prompt-templates --no-context-files \
  -e "$PWD/packages/pi-minimal-subagents/test/fixtures/subagents-viewer-pty.ts"
termctrl wait subagents-viewer 'Viewer fixture ready'
termctrl send subagents-viewer text:/subagents enter
termctrl wait subagents-viewer 'Subagents status'
termctrl send subagents-viewer down enter
termctrl wait subagents-viewer 'Transcript · parent.worker'
termctrl send subagents-viewer page-up
termctrl wait subagents-viewer Paused
termctrl resize subagents-viewer --cols 64 --rows 18
termctrl show subagents-viewer
termctrl stop subagents-viewer
```

Wait for each transition before sending keys intended for the next view. Use the fixture-only `/draft-viewer` and `/viewer-dialog` commands for draft/focus checks.

## Compatibility and limitations

- The documented minimum Pi version is now **0.85.1**. Its native renderer-only tool definitions and collapsed generic tool fallback avoid duplicating Pi's tool renderer; the repository's 0.84.1 reference lacks those contracts.
- Kitty key-repeat reports are excluded from double-Left activation. Legacy terminal input encodes a held-key repeat identically to another press, so physical presses cannot be distinguished there.
- Images are text placeholders, not inline terminal images. Model-facing Recent Activity limits remain unchanged.
