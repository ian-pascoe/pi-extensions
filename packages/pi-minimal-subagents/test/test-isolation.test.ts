import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

describe("test isolation", () => {
  it("keeps the developer's Pi config and home directory out of SDK sessions", () => {
    // The root vitest config points HOME and the agent directory at an empty temporary tree.
    expect(isInside(tmpdir(), homedir())).toBe(true);
    expect(isInside(tmpdir(), getAgentDir())).toBe(true);
    expect(existsSync(join(getAgentDir(), "mcp.json"))).toBe(false);
    expect(existsSync(join(getAgentDir(), "settings.json"))).toBe(false);
  });
});
