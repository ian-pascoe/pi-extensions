# Windows DAP preflight process ownership

Research-only note for the remaining exited-parent/orphan gap. No product source, tests, acquisitions, or dependencies were changed. The installed mise probe was reported as `v2026.9.4`; the immutable upstream tag below was inspected. Scope is **preflight probe process lifetime only**, not ownership of the whole DAP debug session or debuggee launch architecture.

## Conclusion

Mise does contain one correct Windows Job Object launcher, but it is private to the Git-checkpoint history description-command path. It is not exposed through `mise exec`, and the ordinary `duct` path cannot provide the same pre-spawn ownership. Reuse therefore means an upstream/internal extraction or API change—not invoking `mise exec`, and not adding an arbitrary dependency.

## Source-wide ownership check (tag `v2026.9.4`)

A bounded source archive grep for `CreateJobObject`, `AssignProcessToJobObject`, `SetInformationJobObject`, `JOB_OBJECT`, and `JobObject` found only these two implementations:

1. **Correct preflight owner: `src/system/history/describe_command/windows_job.rs`.** It creates a Job, sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, starts the process with `CREATE_SUSPENDED`, assigns the suspended process, then finds/resumes its primary thread ([lines 1–19](https://github.com/jdx/mise/blob/v2026.9.4/src/system/history/describe_command/windows_job.rs#L1-L19), [lines 21–52](https://github.com/jdx/mise/blob/v2026.9.4/src/system/history/describe_command/windows_job.rs#L21-L52), [lines 54–106](https://github.com/jdx/mise/blob/v2026.9.4/src/system/history/describe_command/windows_job.rs#L54-L106)). Assignment failures are returned; spawn failure kills/waits the suspended child. The `Job` handle also has explicit `TerminateJobObject` ([lines 90–106](https://github.com/jdx/mise/blob/v2026.9.4/src/system/history/describe_command/windows_job.rs#L90-L106)). The thread snapshot is only to locate this known suspended child's primary thread, not a PID ownership scan.
2. **Post-spawn bounded probe owner: `src/cmd/bounded.rs`.** `read_isolated` starts through Tokio, then creates/configures a Job and assigns the already-running child ([lines 124–160](https://github.com/jdx/mise/blob/v2026.9.4/src/cmd/bounded.rs#L124-L160)). Its own comment explicitly records the race: a descendant can spawn between process creation and assignment; joining at creation would need `PROC_THREAD_ATTRIBUTE_JOB_LIST`, which Tokio does not expose ([lines 124–133](https://github.com/jdx/mise/blob/v2026.9.4/src/cmd/bounded.rs#L124-L133)). It is therefore **not sufficient** for the exited-parent preflight gap.

The correct helper is used only by `describe_command.rs`: that module declares `mod windows_job`, calls `windows_job::spawn(&mut shell)`, stores the private `Job` in an `Arc`, and kills through it ([lines 48–69](https://github.com/jdx/mise/blob/v2026.9.4/src/system/history/describe_command.rs#L48-L69), [lines 120–141](https://github.com/jdx/mise/blob/v2026.9.4/src/system/history/describe_command.rs#L120-L141)). `Job`, `spawn`, and `windows_job` are private/super-private, so Pi DAP cannot consume this implementation by calling `mise exec`.

`src/main.rs` startup has no Job Object setup ([tagged startup source](https://github.com/jdx/mise/blob/v2026.9.4/src/main.rs)); the `exec` path resolves the command, installs only a no-op Ctrl-C handler, then invokes `duct` ([tagged source, lines 510–688](https://github.com/jdx/mise/blob/v2026.9.4/src/cli/exec.rs#L510-L688); launch [lines 623–650](https://github.com/jdx/mise/blob/v2026.9.4/src/cli/exec.rs#L623-L650)). `src/cmd.rs`'s ordinary Windows cleanup remains `taskkill /F /T /PID` ([lines 143–151](https://github.com/jdx/mise/blob/v2026.9.4/src/cmd.rs#L143-L151)). The Windows `windows_posix.rs` Toolhelp code is parent-image/path inspection, not ownership.

## Why `duct`/`shared_child` do not close it

The locked mise dependency is `duct 1.1.2`, whose `ChildHandle::start` runs optional `before_spawn` hooks and then calls `SharedChild::spawn(&mut command)` ([duct 1.1.2 source](https://docs.rs/duct/1.1.2/src/duct/lib.rs.html#1242-1281)). The hook can mutate `std::process::Command`, but receives no spawned child/job handle ([`before_spawn`, lines 881–918](https://docs.rs/duct/1.1.2/src/duct/lib.rs.html#881-918)). `shared_child 1.1.2` simply calls `command.spawn()` ([source](https://docs.rs/shared_child/1.1.2/src/shared_child/lib.rs.html#94-110)); its Windows support is wait/handle plumbing, not Job Objects. Duct documents that `Handle::kill` does not kill grandchildren ([lines 1052–1070](https://docs.rs/duct/1.1.2/src/duct/lib.rs.html#1052-1070)). Thus `duct`/`shared_child` are not a hidden containment seam; the existing private `windows_job` helper is the relevant implementation to extract or upstream.

## Decision for the preflight probe

- **Reusable implementation found:** yes—mise's private `windows_job` launcher is already the required native pattern (create Job, kill-on-close, suspended process, assign-before-resume, explicit failure/kill).
- **Reusable public/runtime seam found:** no—`mise exec` uses ordinary `duct`, and the helper is private to history descriptions.
- **Smallest credible next step:** ask for an upstream mise extraction/API that exposes this launcher to the needed probe command, or implement the same narrowly scoped native helper in the owning component. Do not use `read_isolated`, PID scans, PowerShell/Add-Type compilation, hidden SDKs, or arbitrary new dependencies as substitutes.

## Accepted implementation follow-up

The user subsequently approved a narrow package-owned native preflight helper.
[`windows-runtime-probe.c`](../../packages/pi-dap/native/windows-runtime-probe.c)
uses `PROC_THREAD_ATTRIBUTE_JOB_LIST` at `CreateProcessW` time instead of the
suspended-spawn/assign sequence, eliminating the additional orphan window if the
helper itself dies between creation and assignment. Microsoft's
[API contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
explicitly supports this attribute on Windows 10+/Server 2016+, within the Node 22
platform baseline. The Job is noninheritable and kill-on-close; only standard
handles are inherited through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.

The [build/distribution note](../../packages/pi-dap/native/README.md) records
checked-in x64/ARM64 assets in the existing source-TypeScript package, no runtime
compiler/dependencies, and native CI reproduction/operation gates. This is an
implementation choice, not a claim that artifact reproduction or Windows runtime
verification has already passed. Ownership remains confined to preflight probes.
