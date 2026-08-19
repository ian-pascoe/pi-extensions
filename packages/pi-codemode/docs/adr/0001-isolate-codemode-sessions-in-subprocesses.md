# Isolate CodeMode Sessions in pinned Deno subprocesses

Each live CodeMode Session owns one subprocess started from the exact
`deno@2.9.5` npm dependency. Deno executes the package's shipped TypeScript
process entry, which owns one QuickJS runtime/context. Registered Pi tools remain
in the parent Node process and execute through a strict, bounded,
line-delimited JSON bridge.

This process boundary costs IPC and a platform binary dependency, but it lets a
background Cell return immediately and lets Pi stop unbounded JavaScript without
moving or reimplementing registered tool handlers. QuickJS remains the guest
capability and memory boundary; Deno is only the trusted source-TypeScript host.
The parent can terminate the whole subprocess on timeout, cancellation, reload,
or shutdown.
