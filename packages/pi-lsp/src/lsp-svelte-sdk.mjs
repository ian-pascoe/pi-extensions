import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { join } from "node:path";

const [server, sdk] = process.argv.slice(2);
if (!server || !sdk) throw new Error("Svelte requires server and TypeScript SDK paths");
const requireServer = createRequire(realpathSync(server));
const sdkEntry = requireServer.resolve(join(sdk, "typescript.js"));
requireServer(sdkEntry);
// Svelte's CommonJS server imports its TypeScript peer eagerly and has no tsdk
// option. Bind that peer to the selected compatible SDK in this process only.
requireServer.cache[requireServer.resolve("typescript")] = requireServer.cache[sdkEntry];
requireServer(server);
