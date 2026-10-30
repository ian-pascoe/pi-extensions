/**
 * `scripts/fetch-vscode-js-debug.mjs` downloads the pinned vscode-js-debug release for Pi DAP's
 * Supported Adapter tests. These tests serve a local fixture tarball from a loopback HTTP server,
 * so they never reach the network, and cover hash verification, the retry, and idempotence.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureVscodeJsDebug, integrityMarkerName } from "../scripts/fetch-vscode-js-debug.mjs";

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Builds a gzip tarball laid out like the release: one top-level `js-debug/` directory. */
async function buildTarball(directory: string, adapterSource: string): Promise<Buffer> {
  const contents = join(directory, "contents");
  await mkdir(join(contents, "js-debug", "src"), { recursive: true });
  await writeFile(join(contents, "js-debug", "src", "dapDebugServer.js"), adapterSource);
  const tarballPath = join(directory, "fixture.tar.gz");
  execFileSync("tar", ["-czf", tarballPath, "-C", contents, "js-debug"]);
  return readFile(tarballPath);
}

describe("fetch-vscode-js-debug", () => {
  let root: string;
  let fixtureDirectory: string;
  let server: Server;
  let baseUrl: string;
  let requests: number;
  /** Status codes for the next requests, in order; an empty list serves the tarball. */
  let failures: number[];
  let served: Buffer;

  async function writeFixture(tarball: Buffer, integrity = integrityOf(tarball)): Promise<void> {
    await writeFile(
      join(fixtureDirectory, "fixture.json"),
      JSON.stringify({ version: "9.9.9", url: `${baseUrl}/js-debug.tar.gz`, integrity }),
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fetch-js-debug-"));
    fixtureDirectory = join(root, "fixture");
    await mkdir(fixtureDirectory);
    requests = 0;
    failures = [];
    served = await buildTarball(root, "// adapter v1\n");
    server = createServer((_request, response) => {
      requests += 1;
      const failure = failures.shift();
      if (failure !== undefined) {
        response.writeHead(failure).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/gzip" }).end(served);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!(address instanceof Object) || !("port" in address)) throw new Error("no server port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    await writeFixture(served);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  });

  it("downloads, verifies, and extracts the release with an integrity marker", async () => {
    const result = await ensureVscodeJsDebug(fixtureDirectory, 0);

    expect(result).toEqual({
      status: "downloaded",
      version: "9.9.9",
      directory: join(fixtureDirectory, "js-debug"),
    });
    expect(await readFile(join(fixtureDirectory, "js-debug/src/dapDebugServer.js"), "utf8")).toBe(
      "// adapter v1\n",
    );
    expect(await readFile(join(fixtureDirectory, "js-debug", integrityMarkerName), "utf8")).toBe(
      integrityOf(served),
    );
    expect(requests).toBe(1);
  });

  it("writes a manifest so Node does not load the CommonJS adapter as part of an ES module package", async () => {
    await ensureVscodeJsDebug(fixtureDirectory, 0);

    expect(
      JSON.parse(await readFile(join(fixtureDirectory, "js-debug/package.json"), "utf8")),
    ).toEqual({
      name: "vscode-js-debug",
      version: "9.9.9",
      private: true,
    });
  });

  it("leaves no scratch directory behind", async () => {
    await ensureVscodeJsDebug(fixtureDirectory, 0);

    expect((await readdir(fixtureDirectory)).sort()).toEqual(["fixture.json", "js-debug"]);
  });

  it("is idempotent: a second run makes no request and keeps the extract", async () => {
    await ensureVscodeJsDebug(fixtureDirectory, 0);
    await writeFile(join(fixtureDirectory, "js-debug/local-edit"), "kept");

    expect((await ensureVscodeJsDebug(fixtureDirectory, 0)).status).toBe("present");

    expect(requests).toBe(1);
    expect(await readFile(join(fixtureDirectory, "js-debug/local-edit"), "utf8")).toBe("kept");
  });

  it("fetches again when the pinned integrity changes, replacing the old extract", async () => {
    await ensureVscodeJsDebug(fixtureDirectory, 0);
    served = await buildTarball(join(root, "v2"), "// adapter v2\n");
    await writeFixture(served);

    expect((await ensureVscodeJsDebug(fixtureDirectory, 0)).status).toBe("downloaded");

    expect(await readFile(join(fixtureDirectory, "js-debug/src/dapDebugServer.js"), "utf8")).toBe(
      "// adapter v2\n",
    );
    expect(requests).toBe(2);
  });

  it("fetches again when the extract carries no integrity marker", async () => {
    await mkdir(join(fixtureDirectory, "js-debug"));

    expect((await ensureVscodeJsDebug(fixtureDirectory, 0)).status).toBe("downloaded");

    expect(await readFile(join(fixtureDirectory, "js-debug/src/dapDebugServer.js"), "utf8")).toBe(
      "// adapter v1\n",
    );
  });

  it("rejects a tarball whose hash does not match, after one retry, and extracts nothing", async () => {
    await writeFixture(served, integrityOf(Buffer.from("something else")));

    await expect(ensureVscodeJsDebug(fixtureDirectory, 0)).rejects.toThrow(/integrity mismatch/u);

    expect(requests).toBe(2);
    expect(await readdir(fixtureDirectory)).toEqual(["fixture.json"]);
  });

  it("does not replace a good extract with an unverified download", async () => {
    await ensureVscodeJsDebug(fixtureDirectory, 0);
    served = await buildTarball(join(root, "bad"), "// tampered\n");
    await writeFixture(Buffer.from("pin of a different release"));

    await expect(ensureVscodeJsDebug(fixtureDirectory, 0)).rejects.toThrow(/integrity mismatch/u);

    expect(await readFile(join(fixtureDirectory, "js-debug/src/dapDebugServer.js"), "utf8")).toBe(
      "// adapter v1\n",
    );
  });

  it("retries once after a failed request", async () => {
    failures = [503];

    expect((await ensureVscodeJsDebug(fixtureDirectory, 0)).status).toBe("downloaded");

    expect(requests).toBe(2);
  });

  it("gives up after the retry fails too", async () => {
    failures = [503, 502];

    await expect(ensureVscodeJsDebug(fixtureDirectory, 0)).rejects.toThrow(/failed: 502/u);

    expect(requests).toBe(2);
    expect(await readdir(fixtureDirectory)).toEqual(["fixture.json"]);
  });

  it("rejects a fixture whose integrity is not a sha512 digest", async () => {
    await writeFile(
      join(fixtureDirectory, "fixture.json"),
      JSON.stringify({ version: "9.9.9", url: baseUrl, integrity: "sha1-abc" }),
    );

    await expect(ensureVscodeJsDebug(fixtureDirectory, 0)).rejects.toThrow();

    expect(requests).toBe(0);
  });

  it("pins the repository fixture to a sha512 digest of the 1.117.0 release", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../tools/pi-dap-vscode-js-debug/fixture.json", import.meta.url),
        "utf8",
      ),
    );

    expect(fixture).toEqual({
      version: "1.117.0",
      url: "https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/js-debug-dap-v1.117.0.tar.gz",
      integrity: expect.stringMatching(/^sha512-[A-Za-z0-9+/]{86}==$/u),
    });
  });
});
