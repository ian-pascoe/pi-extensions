import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
const descendant = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'],
  {
    // Node's own Windows job kills non-detached direct children on exit; real
    // Python/native descendants need not join that job. Avoid a false-green fixture.
    detached: process.platform === "win32",
    stdio: [
      "ignore",
      process.env.PI_DAP_PROBE_MODE === "parent-exit-closed-stdio" ? "ignore" : "inherit",
      process.env.PI_DAP_PROBE_MODE === "parent-exit-closed-stdio" ? "ignore" : "inherit",
      "ipc",
    ],
  },
);
descendant.once("message", () => {
  writeFileSync(process.env.PI_DAP_PROBE_PIDS, JSON.stringify([process.pid, descendant.pid]));
  if (process.env.PI_DAP_PROBE_MODE?.startsWith("parent-exit")) process.exit(0);
  if (process.env.PI_DAP_PROBE_MODE === "overflow") {
    const output = Buffer.alloc(64 * 1024, "x");
    setInterval(() => process.stdout.write(output), 1);
  }
});
setInterval(() => {}, 1000);
