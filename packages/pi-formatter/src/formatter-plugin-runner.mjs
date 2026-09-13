import { readFile, writeFile } from "node:fs/promises";
import * as module from "node:module";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

// Keep the selected Prettier API and its native config/ignores. Resolve only
// curated plugin names, never write project config or acquire arbitrary imports.
const [mode, prettierPath, mapping, file, framework] = process.argv.slice(2);
const curated = JSON.parse(mapping);
const names = ["prettier-plugin-svelte", "prettier-plugin-astro"];
if (
  !Value.Check(Type.Record(Type.String(), Type.String()), curated) ||
  Object.keys(curated).some((name) => !names.includes(name))
)
  throw new Error("Invalid curated plugin paths");
const prettier = (await import(pathToFileURL(prettierPath).href)).default;
const ignores = prettier.version?.startsWith("2.")
  ? [".prettierignore"]
  : [".gitignore", ".prettierignore"];
const infos = await Promise.all(
  ignores.map((ignorePath) =>
    prettier.getFileInfo(file, { ignorePath, withNodeModules: false, resolveConfig: false }),
  ),
);
const ignored = infos.some((info) => info.ignored);
let needsHooks = false;
const requested = new Set();
let pending;
let config = {};
if (!ignored) {
  module.registerHooks?.({
    resolve(specifier, context, nextResolve) {
      if (!names.includes(specifier)) return nextResolve(specifier, context);
      requested.add(specifier);
      if (!curated[specifier]) {
        pending = specifier;
        throw new Error(`Curated plugin selection required: ${specifier}`);
      }
      return nextResolve(
        context.conditions.includes("require")
          ? curated[specifier]
          : pathToFileURL(curated[specifier]).href,
        context,
      );
    },
  });
  try {
    config = (await prettier.resolveConfig(file, { editorconfig: true })) ?? {};
    needsHooks =
      module.registerHooks === undefined &&
      (config.plugins ?? []).some((plugin) =>
        Value.Check(Type.String(), plugin)
          ? names.includes(plugin)
          : [framework, config.parser].some((parser) => parser === "svelte" || parser === "astro"),
      );
  } catch (error) {
    if (
      module.registerHooks === undefined &&
      error instanceof Error &&
      names.some((name) => error.message.includes(name))
    ) {
      needsHooks = true;
    } else if (!pending || mode !== "inspect") throw error;
  }
}
if (mode === "inspect") {
  console.log(
    `PI_FORMATTER_INFO=${JSON.stringify({
      ignored,
      plugins: [
        ...requested,
        ...(config.plugins ?? []).filter((plugin) => Value.Check(Type.String(), plugin)),
      ],
      node: process.versions.node,
      framework:
        config.parser === "svelte" || config.parser === "astro" ? config.parser : undefined,
      needsHooks,
      pending,
    })}`,
  );
} else if (mode === "format" && !ignored) {
  if (needsHooks) throw new Error("Curated config imports require Node module.registerHooks");
  const plugins = (config.plugins ?? []).map((plugin) =>
    Value.Check(Type.String(), plugin) ? (curated[plugin] ?? plugin) : plugin,
  );
  for (const path of Object.values(curated)) {
    if (plugins.includes(path)) continue;
    const imported = await import(pathToFileURL(path).href);
    if (!plugins.includes(imported) && !plugins.includes(imported.default)) plugins.push(path);
  }
  const input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    await readFile(file),
  );
  const output = await prettier.format(input, { ...config, plugins, filepath: file });
  if (output !== input) await writeFile(file, output);
}
