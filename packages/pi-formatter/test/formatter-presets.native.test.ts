import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import { subset } from "semver";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  biomeFormatterEligible,
  resolvePresetDefinition,
  selectFormatterPreset,
} from "../src/formatter-presets.js";

const execute = promisify(execFile);
let directory = "";
let installer: ToolInstaller;

async function selectNativeFormatter(path: string) {
  return selectFormatterPreset(path, new Set(), async (root) => {
    const definition = await resolvePresetDefinition(
      "biome",
      dirname(path),
      installer,
      { allowDownload: true, signal: AbortSignal.timeout(240_000) },
      root,
      path,
      root,
    );
    return biomeFormatterEligible(definition, path, root, 30_000);
  });
}

async function expectSvelteCompatibility(args: readonly string[], range: string) {
  const paths: unknown = JSON.parse(args[3]!);
  if (!Value.Check(Type.Record(Type.String(), Type.String()), paths))
    throw new Error("Invalid plugin arguments");
  expect(paths["prettier-plugin-svelte"]).toBeDefined();
  const metadata: unknown = JSON.parse(
    await readFile(
      createRequire(paths["prettier-plugin-svelte"]!).resolve(
        "prettier-plugin-svelte/package.json",
      ),
      "utf8",
    ),
  );
  if (
    !Value.Check(
      Type.Object({
        name: Type.Literal("prettier-plugin-svelte"),
        peerDependencies: Type.Object({ svelte: Type.String() }),
      }),
      metadata,
    )
  )
    throw new Error("Invalid selected Svelte plugin metadata");
  expect(subset(range, metadata.peerDependencies.svelte)).toBe(true);
  return paths;
}

describe.skipIf(process.env.PI_FORMATTER_NATIVE !== "1")(
  "native expanded formatter operations",
  { timeout: 300_000 },
  () => {
    beforeAll(async () => {
      directory = await realpath(await mkdtemp(join(tmpdir(), "pi-formatter-native-")));
      installer = new ToolInstaller(
        process.env.PI_FORMATTER_NATIVE_DIR ?? join(directory, "managed"),
      );
      vi.stubEnv("PATH", "");
    });
    afterAll(async () => {
      try {
        if (installer)
          process.stdout.write(
            `${JSON.stringify({
              platform: process.platform,
              arch: process.arch,
              installations: (await installer.list()).filter((installation) =>
                installation.id.startsWith("formatter-"),
              ),
            })}\n`,
          );
      } finally {
        vi.unstubAllEnvs();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });

    test.each([
      ["deno", "example.html", "<p  >answer</p>", "<p>answer</p>\n", "deno.json", '{"fmt":{}}'],
      [
        "deno",
        "example.scss",
        "a{color:red;}",
        "a {\n  color: red;\n}\n",
        "deno.json",
        '{"fmt":{}}',
      ],
      [
        "deno",
        "example.less",
        "a{color:red;}",
        "a {\n  color: red;\n}\n",
        "deno.json",
        '{"fmt":{}}',
      ],
      [
        "deno",
        "example.md",
        "# Title\n\n-   answer",
        "# Title\n\n- answer\n",
        "deno.json",
        '{"fmt":{}}',
      ],
      [
        "deno",
        "example.jsonc",
        '// note\n{"answer":42}',
        '// note\n{ "answer": 42 }\n',
        "deno.json",
        '{"fmt":{}}',
      ],
      ["prettier", "example.scss", "a{color:red;}", "a {\n  color: red;\n}\n", ".prettierrc", "{}"],
      ["prettier", "example.less", "a{color:red;}", "a {\n  color: red;\n}\n", ".prettierrc", "{}"],
      [
        "prettier",
        "example.mdx",
        "# Title\n\n<Component  />",
        "# Title\n\n<Component />\n",
        ".prettierrc",
        "{}",
      ],
      ["prettier", "example.yaml", "answer:    42", "answer: 42\n", ".prettierrc", "{}"],
      [
        "prettier",
        "example.md",
        "# Title\n\n-   answer",
        "# Title\n\n- answer\n",
        ".prettierrc",
        "{}",
      ],
      ["biome", "example.css", "a{color:red;}", "a {\n\tcolor: red;\n}\n", "biome.json", "{}"],
      ["biome", "example.graphql", "query{answer}", "query {\n\tanswer\n}\n", "biome.json", "{}"],
      ["shfmt", "example.sh", "if true;then echo hi;fi\n", "if true; then echo hi; fi\n", "", ""],
      [
        "terraform",
        "example.tf",
        "locals {\nanswer=42\n}\n",
        "locals {\n  answer = 42\n}\n",
        "",
        "",
      ],
      [
        "deno",
        "example.yaml",
        "answer:    42\n",
        "answer: 42\n",
        "deno.jsonc",
        '{// formatter only\n"fmt":{},"nodeModulesDir":"auto","vendor":true,"imports":{"missing":"npm:missing-package-for-no-download-proof"}}',
      ],
      ["prettier", "example.html", "<p  >answer</p>", "<p>answer</p>\n", ".prettierrc", "{}"],
      [
        "prettier",
        "example.css",
        ".answer{color:red}",
        ".answer {\n  color: red;\n}\n",
        ".prettierrc",
        "{}",
      ],
      ["prettier", "example.json5", "{answer:42}", "{ answer: 42 }\n", ".prettierrc", "{}"],
      [
        "prettier",
        "example.graphql",
        "query{answer}",
        "query {\n  answer\n}\n",
        ".prettierrc",
        "{}",
      ],
      [
        "prettier",
        "example.vue",
        "<template><p>answer</p></template>",
        "<template><p>answer</p></template>\n",
        ".prettierrc",
        "{}",
      ],
      ["biome", "example.json", '{"answer":42}', '{ "answer": 42 }\n', "biome.json", "{}"],
    ])(
      "%s privately acquires and formats %s without project setup writes",
      async (id, filename, input, output, marker, config) => {
        const root = join(directory, `${id}-${filename}`);
        await mkdir(root);
        if (marker) await writeFile(join(root, marker), config);
        const path = join(root, filename);
        await writeFile(path, input);
        const selected = await selectNativeFormatter(path);
        expect(selected?.id).toBe(id);
        const definition = await resolvePresetDefinition(
          selected!.id,
          root,
          installer,
          { allowDownload: true, signal: AbortSignal.timeout(240_000), onProgress: console.info },
          root,
          path,
          root,
        );
        const env = { ...process.env };
        for (const [name, value] of Object.entries(definition.environment)) {
          if (value === null) delete env[name];
          else env[name] = value;
        }
        await execute(
          definition.command,
          definition.args.map((arg) => arg.replaceAll("$FILE", path)),
          { cwd: root, env, timeout: 30_000 },
        );
        expect(await readFile(path, "utf8")).toBe(output);
        expect((await readdir(root)).sort()).toEqual(
          [filename, ...(marker ? [marker] : [])].sort(),
        );
        if (marker) expect(await readFile(join(root, marker), "utf8")).toBe(config);
        console.info(
          JSON.stringify({
            platform: process.platform,
            arch: process.arch,
            tool: id,
            installation: await installer.installed(`formatter-${id}`),
          }),
        );
      },
    );

    test.each([
      ["style-only", '{"formatter":{"indentStyle":"space"}}', false, "biome"],
      ["lint-only", '{"formatter":{"enabled":false},"linter":{"enabled":true}}', true, "prettier"],
    ] as const)(
      "native Biome %s inheritance selects and formats without setup writes",
      async (name, base, prettier, expected) => {
        const root = join(directory, `biome-${name}`);
        await mkdir(root);
        const config = '{"extends":["./base.json"]}';
        await writeFile(join(root, "biome.json"), config);
        await writeFile(join(root, "base.json"), base);
        if (prettier) await writeFile(join(root, ".prettierrc"), "{}");
        const path = join(root, "example.ts");
        await writeFile(path, "const answer=42");
        const selected = await selectNativeFormatter(path);
        expect(selected?.id).toBe(expected);
        const definition = await resolvePresetDefinition(
          selected!.id,
          root,
          installer,
          { allowDownload: false },
          root,
          path,
          root,
        );
        const env = { ...process.env };
        for (const [key, value] of Object.entries(definition.environment)) {
          if (value === null) delete env[key];
          else env[key] = value;
        }
        await execute(
          definition.command,
          definition.args.map((arg) => arg.replaceAll("$FILE", path)),
          { cwd: root, env, timeout: 30_000 },
        );
        expect(await readFile(path, "utf8")).toBe("const answer = 42;\n");
        expect(await readFile(join(root, "biome.json"), "utf8")).toBe(config);
        expect(await readFile(join(root, "base.json"), "utf8")).toBe(base);
        expect((await readdir(root)).sort()).toEqual([
          ...(prettier ? [".prettierrc"] : []),
          "base.json",
          "biome.json",
          "example.ts",
        ]);
      },
    );

    test.each([
      ["enabled-clean", "{}", "const answer = 42;\n", false, "biome"],
      ["enabled-diff-conflict", "{}", "const answer=42", true, "conflict"],
      ["enabled-parse-conflict", "{}", "const =", true, "conflict"],
      ["enabled-parse", "{}", "const =", false, "biome"],
      ["disabled", '{"formatter":{"enabled":false}}', "const answer=42", true, "prettier"],
      [
        "ignored",
        '{"files":{"includes":["**","!example.ts"]}}',
        "const answer=42",
        true,
        "prettier",
      ],
      [
        "override-disabled",
        '{"overrides":[{"includes":["**/*.ts"],"formatter":{"enabled":false}}]}',
        "const answer=42",
        true,
        "prettier",
      ],
      [
        "override-enabled",
        '{"formatter":{"enabled":false},"overrides":[{"includes":["**/*.ts"],"formatter":{"enabled":true}}]}',
        "const answer=42",
        true,
        "conflict",
      ],
      ["invalid-config", '{"extends":["./missing.json"]}', "const answer=42", true, "invalid"],
      ["oversized", '{"files":{"maxSize":1}}', "const answer=42", true, "invalid"],
    ] as const)("native Biome eligibility: %s", async (name, config, input, prettier, expected) => {
      const root = join(directory, name);
      await mkdir(root);
      await writeFile(join(root, "biome.json"), config);
      if (prettier) await writeFile(join(root, ".prettierrc"), "{}");
      const path = join(root, "example.ts");
      await writeFile(path, input);
      if (expected === "conflict")
        await expect(selectNativeFormatter(path)).rejects.toThrow("Conflicting Formatter Markers");
      else if (expected === "invalid")
        await expect(selectNativeFormatter(path)).rejects.toThrow(
          "Cannot determine Biome formatter eligibility",
        );
      else expect((await selectNativeFormatter(path))?.id).toBe(expected);
      expect(await readFile(path, "utf8")).toBe(input);
      expect(await readFile(join(root, "biome.json"), "utf8")).toBe(config);
      expect((await readdir(root)).sort()).toEqual([
        ...(prettier ? [".prettierrc"] : []),
        "biome.json",
        "example.ts",
      ]);
    });

    test.each(["strings", "mjs", "cjs", "ts"])(
      "curated private plugins (%s) honor Svelte 4, mixed config, and ignores with the same Prettier",
      async (kind) => {
        const root = join(directory, `frameworks-${kind}`);
        await mkdir(root);
        const manifest = '{"devDependencies":{"svelte":"^4.0.0","astro":"^5.0.0"}}';
        const configName = kind === "strings" ? ".prettierrc" : `prettier.config.${kind}`;
        const config =
          kind === "strings"
            ? '{"plugins":["prettier-plugin-svelte","prettier-plugin-astro"]}'
            : kind === "cjs"
              ? "module.exports={plugins:[require('prettier-plugin-svelte'),require('prettier-plugin-astro')]}"
              : `import svelte from 'prettier-plugin-svelte';import * as astro from 'prettier-plugin-astro';const config${kind === "ts" ? ": {plugins: unknown[]}" : ""}={plugins:[svelte,astro]};export default config;`;
        await writeFile(join(root, "package.json"), manifest);
        await writeFile(join(root, configName), config);
        for (const [filename, input, output] of [
          [
            "Example.svelte",
            "<script>let answer=42;</script><p>{answer}</p>",
            "<script>\n  let answer = 42;\n</script>\n\n<p>{answer}</p>\n",
          ],
          [
            "Example.astro",
            "---\nconst answer=42;\n---\n<p>{answer}</p>",
            "---\nconst answer = 42;\n---\n\n<p>{answer}</p>\n",
          ],
          ["example.ts", "const answer=42", "const answer = 42;\n"],
          ["example.html", "<p  >answer</p>", "<p>answer</p>\n"],
        ] as const) {
          const path = join(root, filename);
          await writeFile(path, input);
          const definition = await resolvePresetDefinition(
            "prettier",
            root,
            installer,
            { allowDownload: true, signal: AbortSignal.timeout(240_000), onProgress: console.info },
            root,
            path,
            root,
          );
          const env = { ...process.env };
          for (const [name, value] of Object.entries(definition.environment)) {
            if (value === null) delete env[name];
            else env[name] = value;
          }
          const run = () =>
            execute(
              definition.command,
              definition.args.map((arg) => arg.replaceAll("$FILE", path)),
              { cwd: root, env, timeout: 30_000 },
            );
          await run();
          expect(await readFile(path, "utf8")).toBe(output);
          await writeFile(join(root, ".prettierignore"), filename);
          await writeFile(path, input);
          await run();
          expect(await readFile(path, "utf8")).toBe(input);
        }
        expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest);
        expect(await readFile(join(root, configName), "utf8")).toBe(config);
        const path = join(root, "Example.svelte");
        const options = { allowDownload: true, signal: AbortSignal.timeout(240_000) };
        const previous = await resolvePresetDefinition(
          "prettier",
          root,
          installer,
          options,
          root,
          path,
          root,
        );
        const paths = await expectSvelteCompatibility(previous.args, "^4.0.0");
        const before = await Promise.all(
          Object.values(paths).map((file) => readFile(file, "utf8")),
        );
        const updatedManifest = '{"devDependencies":{"svelte":"^5.0.0","astro":"^5.0.0"}}';
        await writeFile(join(root, "package.json"), updatedManifest);
        const current = await resolvePresetDefinition(
          "prettier",
          root,
          installer,
          options,
          root,
          path,
          root,
        );
        // A compatible installed plugin may serve both framework declarations.
        await expectSvelteCompatibility(current.args, "^5.0.0");
        expect(current.args[2]).toBe(previous.args[2]);
        await writeFile(path, "<script>let answer=42;</script><p>{answer}</p>");
        const env = { ...process.env };
        for (const [name, value] of Object.entries(current.environment)) {
          if (value === null) delete env[name];
          else env[name] = value;
        }
        await execute(
          current.command,
          current.args.map((arg) => arg.replaceAll("$FILE", path)),
          { cwd: root, env, timeout: 30_000 },
        );
        expect(await readFile(path, "utf8")).toBe(
          "<script>\n  let answer = 42;\n</script>\n\n<p>{answer}</p>\n",
        );
        expect(await readFile(join(root, "package.json"), "utf8")).toBe(updatedManifest);
        expect(await readFile(join(root, configName), "utf8")).toBe(config);
        expect(await readFile(join(root, ".prettierignore"), "utf8")).toBe("example.html");
        expect(
          await Promise.all(Object.values(paths).map((file) => readFile(file, "utf8"))),
        ).toEqual(before);
        expect((await readdir(root)).sort()).toEqual(
          [
            ".prettierignore",
            configName,
            "Example.astro",
            "Example.svelte",
            "example.html",
            "example.ts",
            "package.json",
          ].sort(),
        );
      },
    );
  },
);
