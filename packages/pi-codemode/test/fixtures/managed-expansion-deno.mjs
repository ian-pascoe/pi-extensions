// Offline external Deno boundary, not a replacement for native Deno support proofs.
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

// The shared installation also supplies NODE_OPTIONS to js-debug's Node process.
// Only the copied deno executable enters this protocol fixture.
if (["deno", "deno.exe"].includes(basename(process.execPath))) {
  const [entry, ...args] = process.argv.slice(1);
  const command = basename(entry);
  if (command === "lsp") {
    await import("../../../pi-lsp/test/fixtures/fake-lsp-server.mjs");
    await new Promise(() => {});
  } else if (command === "fmt") {
    appendFileSync(args.at(-1), "// formatted-by-managed-deno\n");
    process.exit(0);
  } else {
    throw new Error(`Unexpected Deno fixture command ${command}`);
  }
}
