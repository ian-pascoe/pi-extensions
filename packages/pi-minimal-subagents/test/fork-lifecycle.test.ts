import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isForkDestinationForSource,
  rememberForkSnapshot,
  takeForkSnapshot,
} from "../src/minimal-subagents-fork-lifecycle.js";
import type { ForkSnapshot } from "../src/minimal-subagents-types.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe("minimal subagents fork snapshot lifecycle", () => {
  it("proves destination selection only through the canonical parentSession link", () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-fork-proof-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source.jsonl");
    const alias = join(directory, "source-alias.jsonl");
    writeFileSync(source, "{}\n");
    symlinkSync(source, alias);

    expect(isForkDestinationForSource({ parentSession: alias }, source)).toBe(true);
    expect(isForkDestinationForSource({}, source)).toBe(false);
    expect(isForkDestinationForSource({ parentSession: join(directory, "other") }, source)).toBe(
      false,
    );
  });

  it("uses canonical paths, clones snapshots, and consumes each snapshot once", () => {
    const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-fork-"));
    temporaryDirectories.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    const alias = join(directory, "alias.jsonl");
    writeFileSync(sessionFile, "{}\n");
    symlinkSync(sessionFile, alias);
    const snapshot: ForkSnapshot = {
      source_root_session_file: alias,
      source_root_session_id: "source-root",
      agents: [],
      tombstones: ["deleted"],
      deliveries: [],
    };

    rememberForkSnapshot(snapshot);
    snapshot.tombstones.push("mutated");
    const consumed = takeForkSnapshot(realpathSync(sessionFile));
    expect(consumed?.source_root_session_file).toBe(realpathSync(sessionFile));
    expect(consumed?.tombstones).toEqual(["deleted"]);
    consumed?.tombstones.push("local");
    expect(takeForkSnapshot(sessionFile)).toBeUndefined();
  });
});
