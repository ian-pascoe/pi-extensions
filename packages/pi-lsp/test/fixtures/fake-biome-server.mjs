import { existsSync, writeFileSync } from "node:fs";

// Observe only the executable boundary; routing and session-file ownership remain real.
writeFileSync(
  "biome-launch.json",
  JSON.stringify({ home: process.env.HOME, tmpdir: process.env.TMPDIR }),
);
process.on("exit", () => {
  writeFileSync("biome-exit.json", JSON.stringify({ homeExists: existsSync(process.env.HOME) }));
});
process.env.FAKE_BIOME_READY = "1";
process.env.FAKE_NO_PULL = "1";
process.env.FAKE_DIAGNOSTICS = "document";
await import("./fake-lsp-server.mjs");
