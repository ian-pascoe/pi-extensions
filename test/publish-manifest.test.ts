/**
 * `scripts/publish-manifest.mjs` lifts a package's `publishConfig` field overrides to the top level
 * for release, because npm and Bun honour only registry options there. These tests drive its
 * `apply`, `check`, and `restore` modes against temporary package directories, once through the
 * exported functions and once through the command line the release scripts use.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPublishManifest,
  checkPublishManifest,
  originalManifestFileName,
  restorePublishManifest,
  runPublishManifest,
} from "../scripts/publish-manifest.mjs";

const run = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/publish-manifest.mjs", import.meta.url));
const realPiUtilsManifest = fileURLToPath(
  new URL("../packages/pi-utils/package.json", import.meta.url),
);

const sourceManifest = {
  name: "@example/library",
  version: "1.2.3",
  files: ["dist"],
  type: "module",
  main: "./src/index.ts",
  types: "./src/index.ts",
  exports: { ".": "./src/index.ts", "./extra": "./src/extra.ts" },
  publishConfig: {
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./extra": { types: "./dist/extra.d.ts", import: "./dist/extra.js" },
    },
    access: "public",
    provenance: true,
  },
  scripts: { build: "tsc" },
};

function serialize<Manifest extends { name: string }>(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function readManifest(directory: string): Promise<typeof sourceManifest> {
  return JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
}

describe("publish-manifest", () => {
  let root: string;
  let packageDirectory: string;
  let originalText: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "publish-manifest-"));
    packageDirectory = join(root, "library");
    await mkdir(packageDirectory);
    originalText = serialize(sourceManifest);
    await writeFile(join(packageDirectory, "package.json"), originalText);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("apply", () => {
    it("lifts the overrides and leaves only registry options in publishConfig", async () => {
      expect(await applyPublishManifest(packageDirectory)).toEqual({ handled: true });

      const applied = await readManifest(packageDirectory);
      expect(applied.main).toBe("./dist/index.js");
      expect(applied.types).toBe("./dist/index.d.ts");
      expect(applied.exports).toEqual(sourceManifest.publishConfig.exports);
      expect(applied.publishConfig).toEqual({ access: "public", provenance: true });
      expect({ ...applied, main: 0, types: 0, exports: 0, publishConfig: 0 }).toEqual({
        ...sourceManifest,
        main: 0,
        types: 0,
        exports: 0,
        publishConfig: 0,
      });
    });

    it("keeps field order and the final newline", async () => {
      await applyPublishManifest(packageDirectory);

      const text = await readFile(join(packageDirectory, "package.json"), "utf8");
      expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(sourceManifest));
      expect(text.endsWith("}\n")).toBe(true);
    });

    it("drops publishConfig when only overrides were in it", async () => {
      const { access, provenance, ...overrides } = sourceManifest.publishConfig;
      await writeFile(
        join(packageDirectory, "package.json"),
        serialize({ ...sourceManifest, publishConfig: overrides }),
      );

      await applyPublishManifest(packageDirectory);

      expect(access).toBe("public");
      expect(provenance).toBe(true);
      expect(await readManifest(packageDirectory)).not.toHaveProperty("publishConfig");
    });

    it("keeps the original manifest beside the rewritten one", async () => {
      await applyPublishManifest(packageDirectory);

      expect(await readFile(join(packageDirectory, originalManifestFileName), "utf8")).toBe(
        originalText,
      );
    });

    it("changes nothing for a package without overrides", async () => {
      const plain = serialize({
        name: "@example/extension",
        version: "0.1.0",
        publishConfig: { access: "public", provenance: true },
      });
      await writeFile(join(packageDirectory, "package.json"), plain);

      expect(await applyPublishManifest(packageDirectory)).toEqual({ handled: false });

      expect(await readFile(join(packageDirectory, "package.json"), "utf8")).toBe(plain);
      expect(await readdir(packageDirectory)).toEqual(["package.json"]);
    });

    it("is a no-op once applied", async () => {
      await applyPublishManifest(packageDirectory);
      const applied = await readFile(join(packageDirectory, "package.json"), "utf8");

      expect(await applyPublishManifest(packageDirectory)).toEqual({ handled: false });

      expect(await readFile(join(packageDirectory, "package.json"), "utf8")).toBe(applied);
      expect(await readFile(join(packageDirectory, originalManifestFileName), "utf8")).toBe(
        originalText,
      );
    });

    it("refuses to overwrite a kept original while overrides remain", async () => {
      await writeFile(join(packageDirectory, originalManifestFileName), "stale");

      await expect(applyPublishManifest(packageDirectory)).rejects.toThrow(/run restore first/u);

      expect(await readFile(join(packageDirectory, "package.json"), "utf8")).toBe(originalText);
    });

    it("rejects publishConfig keys it does not understand", async () => {
      await writeFile(
        join(packageDirectory, "package.json"),
        serialize({ ...sourceManifest, publishConfig: { directory: "dist", access: "public" } }),
      );

      await expect(applyPublishManifest(packageDirectory)).rejects.toThrow(
        /publishConfig\.directory is neither an overridable field/u,
      );
    });
  });

  describe("check", () => {
    it("fails for an unapplied manifest and names the fields", async () => {
      await expect(checkPublishManifest(packageDirectory)).rejects.toThrow(
        /does not match its publishConfig overrides for main, types, exports; run `node scripts\/publish-manifest\.mjs apply` first/u,
      );
    });

    it("fails when one field was left behind", async () => {
      await applyPublishManifest(packageDirectory);
      const applied = await readManifest(packageDirectory);
      await writeFile(
        join(packageDirectory, "package.json"),
        serialize({
          ...applied,
          main: "./src/index.ts",
          publishConfig: { ...applied.publishConfig, main: "./dist/index.js" },
        }),
      );

      await expect(checkPublishManifest(packageDirectory)).rejects.toThrow(/overrides for main\b/u);
    });

    it("passes once applied", async () => {
      await applyPublishManifest(packageDirectory);

      expect(await checkPublishManifest(packageDirectory)).toEqual({ handled: false });
    });

    it("passes when the top level already equals the overrides", async () => {
      await writeFile(
        join(packageDirectory, "package.json"),
        serialize({
          ...sourceManifest,
          main: sourceManifest.publishConfig.main,
          types: sourceManifest.publishConfig.types,
          exports: sourceManifest.publishConfig.exports,
        }),
      );

      expect(await checkPublishManifest(packageDirectory)).toEqual({ handled: true });
    });
  });

  describe("restore", () => {
    it("puts the original manifest back byte for byte", async () => {
      await applyPublishManifest(packageDirectory);

      expect(await restorePublishManifest(packageDirectory)).toEqual({ handled: true });

      expect(await readFile(join(packageDirectory, "package.json"), "utf8")).toBe(originalText);
      expect(await readdir(packageDirectory)).toEqual(["package.json"]);
    });

    it("does nothing when no manifest was applied", async () => {
      expect(await restorePublishManifest(packageDirectory)).toEqual({ handled: false });

      expect(await readFile(join(packageDirectory, "package.json"), "utf8")).toBe(originalText);
    });

    it("allows applying again afterwards", async () => {
      await applyPublishManifest(packageDirectory);
      await restorePublishManifest(packageDirectory);

      expect(await applyPublishManifest(packageDirectory)).toEqual({ handled: true });
    });
  });

  describe("with the real pi-utils manifest", () => {
    it("publishes dist entrypoints for every export and restores byte for byte", async () => {
      const realText = await readFile(realPiUtilsManifest, "utf8");
      await copyFile(realPiUtilsManifest, join(packageDirectory, "package.json"));

      await applyPublishManifest(packageDirectory);
      await checkPublishManifest(packageDirectory);

      const applied = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
      expect(applied.main).toBe("./dist/index.js");
      expect(applied.types).toBe("./dist/index.d.ts");
      expect(Object.keys(applied.exports).length).toBeGreaterThan(5);
      for (const [subpath, target] of Object.entries(applied.exports)) {
        expect(JSON.stringify(target), subpath).not.toContain("/src/");
        expect(JSON.stringify(target), subpath).toContain("./dist/");
      }
      expect(applied.publishConfig).toEqual({ access: "public", provenance: true });

      await restorePublishManifest(packageDirectory);
      expect(await readFile(join(packageDirectory, "package.json"), "utf8")).toBe(realText);
    });
  });

  describe("command line", () => {
    function node(...args: string[]): Promise<{ stdout: string; stderr: string }> {
      return run(process.execPath, [scriptPath, ...args], { cwd: root });
    }

    it("runs apply, check, and restore against the named directories", async () => {
      await expect(node("check", packageDirectory)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("run `node scripts/publish-manifest.mjs apply` first"),
      });

      expect((await node("apply", packageDirectory)).stdout).toBe(
        "publish-manifest apply: library\n",
      );
      expect((await node("check", packageDirectory)).stdout).toBe("");
      expect((await node("restore", packageDirectory)).stdout).toBe(
        "publish-manifest restore: library\n",
      );

      expect(await readFile(join(packageDirectory, "package.json"), "utf8")).toBe(originalText);
    });

    it("rejects an unknown mode", async () => {
      await expect(node("publish", packageDirectory)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Usage: publish-manifest.mjs <apply|check|restore>"),
      });
    });
  });

  it("reports the packages a mode handled", async () => {
    expect(await runPublishManifest("apply", [packageDirectory])).toHaveLength(1);
    expect(await runPublishManifest("apply", [packageDirectory])).toEqual([]);
  });
});
