# Isolate CodeMode Sessions in pinned Deno subprocesses

Each live CodeMode Session owns one subprocess started from the exact
`deno@2.9.5` npm dependency. Deno itself transpiles and executes the Session's
TypeScript Cells. Registered Pi tools remain in the parent Node process and
execute through a strict, bounded, line-delimited JSON bridge.

The process boundary costs IPC and a platform binary dependency, but permits
background Cells and lets Pi stop unbounded guest execution without moving or
reimplementing registered tool handlers. The parent terminates the complete
subprocess on timeout, cancellation, reload, or shutdown. Deno starts with every
operating-system permission class denied; the worker withholds raw process,
standard streams, `console`, `Worker`, timers, and module loading from Cells.
Deno/V8 launch flags bound each Session to 128 MiB of old-space heap and a 1 MiB
stack.
