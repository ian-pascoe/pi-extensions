# Windows runtime-preflight owner

`windows-runtime-probe.c` owns only Python/.NET runtime preflight processes, not
Debug Sessions. The TypeScript caller retains its five-second deadline, combined
1 MiB stdout/stderr limit, and cancellation policy. POSIX still uses a dedicated
process group.

## Ownership and forwarding

The helper creates an unnamed, noninheritable Job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, with neither breakaway flag enabled. It adds
that Job through `PROC_THREAD_ATTRIBUTE_JOB_LIST` in the same `CreateProcessW`
call that starts the runtime. No child runs before containment, and killing the
helper during process creation cannot leave an unassigned suspended child.
`PROC_THREAD_ATTRIBUTE_HANDLE_LIST` permits only duplicated stdin/stdout/stderr
handles to reach the runtime; the Job handle never leaves the helper.

The helper waits for the runtime leader. On normal exit it terminates remaining
Job members, checks Job accounting for at most one second, closes all handles,
and returns the leader's full Windows exit code unless cleanup failed. On abort,
deadline, or output overflow, Node terminates the helper; kernel handle closure
terminates its Job, including descendants of an exited runtime. The JavaScript
promise observes helper/process-pipe closure. Cleanup is not a security sandbox
against privileged processes launching work through unrelated system services.

The helper forwards the raw UTF-16 command-line tail already quoted by Node,
rather than reconstructing arguments or invoking a shell. Only the helper's own
argv[0] is removed. Native lookup checks cwd then PATH with Node's per-directory
literal-extension/.com/.exe order. Explicit path candidates remain relative to
the supplied cwd; PATH entries can also be relative or quoted. Each parsed PATH
entry stays one literal directory: `GetFullPathNameW` normalizes the joined file
path, rather than `SearchPathW` reparsing a quoted directory containing `;` as a
list. A Windows-only regression places a valid distractor in the split directory
and asserts the actual executable image path; this new native control remains
unverified until Windows CI runs the rebuilt payloads. The helper excludes
Win32's default search through its own installation/system directories. Cwd and
environment are inherited unchanged from the Node spawn. Standard handles are
forwarded without buffering or text conversion.

Failures before creation never start a child. Failures after creation close the
Job and report a nonzero result. There is no post-spawn assignment, PID scan,
PowerShell, `taskkill`, runtime compilation, or uncontained fallback.

## Build and distribution

The existing `@ian-pascoe/pi-dap` package bundles both:

- `src/native/win32-x64/dap-runtime-probe.exe`
- `src/native/win32-arm64/dap-runtime-probe.exe`

These are checked-in, ahead-of-time payloads, not binaries built by installation
hooks. The existing `files: ["src", ...]` includes both in npm tarballs; Git installs
carry the same files. No new package, `bin`, `dist`, `main`, `types`, or `exports`
entrypoint is introduced. This narrowly necessary native runtime asset leaves
[ADR-0002](../../../docs/adr/0002-publish-pi-extensions-as-source-typescript.md)'s
source-TypeScript extension loading intact.

From the repository root, with Zig **0.16.0** and `llvm-readobj` on PATH:

```sh
node scripts/build-dap-native.mjs --write # regenerate both payloads after source review
node scripts/build-dap-native.mjs         # require byte equality; do not modify payloads
```

The script cross-compiles serially with `zig cc -target <target> -municode -Os -s
-Wall -Wextra -Werror`, inspects import descriptors, and rejects any dependency
outside KERNEL32 and the enumerated Windows 10+ Universal CRT API sets. It does
not require a VC redistributable or MinGW DLL installation. These compiler and
inspection tools, and their caches, are build-time-only prerequisites. Bundled
runtime notices live in `src/native/THIRD-PARTY-NOTICES.txt`; tarball and Git-install
gates require that file and preserve its bytes alongside both payloads.

CI downloads the official Linux x64 Zig archive with pinned SHA-256
`70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00`, reproduces both
checked-in payloads, and separately executes the shipped architecture on each
Windows runner. Local Linux cross-build and repeat byte-equality checks pass;
Windows runtime verification is still pending. Build success or a PE machine
field alone is not runtime verification. No artifact is considered verified until
those CI gates pass.

Equivalent MSVC build command, run from `packages/pi-dap` in the matching x64 or
ARM64 Developer Command Prompt with a Windows 10+ SDK:

```bat
cl /nologo /TC /std:c17 /O2 /W4 /WX /MT /D_CRT_SECURE_NO_WARNINGS native/windows-runtime-probe.c /Fe:src/native/win32-x64/dap-runtime-probe.exe /link /INCREMENTAL:NO /SUBSYSTEM:CONSOLE /DYNAMICBASE /NXCOMPAT
```

For ARM64, use the ARM64 target compiler and output directory. `/MT` avoids a
Visual C++ redistributable dependency; an equivalent cross-build must likewise
prove its import closure uses only OS-supplied DLLs. MSVC is an alternative build
check, not an end-user prerequisite or a promise of byte equality with Zig.

Native tests in `test/dap-runtime-probe.test.ts` require the bundled payload on
Windows (they do not skip a missing helper). Public Python/.NET launch tests cover
abort, deadline, overflow, and an exited leader. Direct helper checks cover
Unicode/space/empty/quoted/backslash arguments, relative/PATH lookup, cwd/env,
stdio, exit code, missing/invalid executables, exited leaders with inherited or
closed stdio, and abrupt owner termination. Tests are serialized with other
native verification work. Payload hash/architecture presence checks also belong
in npm tarball and production Git-install gates.

## Primary API references

- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute):
  `JOB_LIST` requires Windows 10+/Server 2016+; `HANDLE_LIST` requires inheritable
  handles and `CreateProcessW`'s inheritance flag.
- [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw):
  extended startup, Unicode command line, inherited environment/cwd, handle cleanup.
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects):
  nested jobs, kill-on-close, default descendant membership, and breakaway flags.
- [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject):
  termination covers nested child jobs; members cannot postpone termination.
- [libuv Windows process implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c):
  Node's executable-search and argument-quoting semantics. Ordinary Node Job
  assignment is post-spawn and allows descendant breakaway, so it cannot replace
  the preflight Job.
