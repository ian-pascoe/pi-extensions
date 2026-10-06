// A deterministic fake formatter for the combined Formatter + LSP test: it collapses runs of spaces
// and prepends a `// formatted` header, which moves every line down by one.
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const text = readFileSync(path, "utf8");
if (!text.startsWith("// formatted\n")) {
  writeFileSync(path, `// formatted\n${text.replaceAll(/ +/g, " ")}`);
}
