import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sensitivePathReason, type SensitivePathContext } from "../src/sensitive-paths.js";
import { resolveToolPolicy, type ToolPolicyInput } from "../src/tool-policy.js";

let root: string;
let workspace: string;
let paths: SensitivePathContext;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "guardian-paths-"));
  workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await mkdir(join(root, "agent"), { recursive: true });
  await symlink(join(root, "outside"), join(workspace, "escape"));
  await symlink(join(workspace, ".git"), join(workspace, "git-link"));
  paths = { cwd: workspace, piDirectories: [join(root, "agent")] };
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("Sensitive Path", () => {
  it.each(["src/index.ts", "./README.md", "new/dir/file.ts", "@src/a.ts", "src/../src/b.ts"])(
    "treats %s as an ordinary workspace path",
    (path) => {
      expect(sensitivePathReason(path, paths)).toBeUndefined();
    },
  );

  it.each([
    ["the parent directory", "../outside/file", "outside the workspace root"],
    ["an absolute outside path", "/etc/hosts", "outside the workspace root"],
    ["the home directory", "~/.bashrc", "outside the workspace root"],
    ["a file URL outside", "file:///etc/passwd", "outside the workspace root"],
    ["a symlink escape", "escape/file", "outside the workspace root"],
    ["a symlink into .git", "git-link/config", "version-control metadata (.git)"],
    ["git metadata", ".git/config", "version-control metadata (.git)"],
    ["nested git metadata", "sub/.git/hooks/pre-commit", "version-control metadata (.git)"],
    ["case variants", ".GIT/config", "version-control metadata (.git)"],
    ["Pi project settings", ".pi/settings.json", "Pi configuration (.pi)"],
    ["dotenv", ".env", "a secret or environment file (.env)"],
    ["dotenv variants", "app/.env.local", "a secret or environment file (.env.local)"],
    ["direnv", ".envrc", "a secret or environment file (.envrc)"],
  ])("reviews %s", (_case, path, reason) => {
    expect(sensitivePathReason(path, paths)).toBe(reason);
  });

  it("treats Pi's agent and session directories as sensitive wherever they are", () => {
    expect(sensitivePathReason(join(root, "agent", "settings.json"), paths)).toBe(
      "Pi's agent configuration or session files",
    );
    const inside = { cwd: workspace, piDirectories: [join(workspace, "sessions")] };
    expect(sensitivePathReason("sessions/abc.jsonl", inside)).toBe(
      "Pi's agent configuration or session files",
    );
  });

  it("expands ~ like Pi", () => {
    const home = { cwd: homedir(), piDirectories: [] };
    expect(sensitivePathReason("~/notes.txt", home)).toBeUndefined();
    expect(sensitivePathReason("~/.pi/agent/settings.json", home)).toBe("Pi configuration (.pi)");
  });
});

describe("Tool Policy resolution", () => {
  const call = (overrides: Partial<ToolPolicyInput>): ToolPolicyInput => ({
    toolName: "custom",
    input: {},
    configured: {},
    safeCommands: [],
    annotations: undefined,
    paths,
    ...overrides,
  });

  it.each([
    "read",
    "grep",
    "find",
    "ls",
    "codemode",
    "tool_search",
    "todo",
    "web_search",
    "web_fetch",
  ])("allows %s by default", (toolName) => {
    expect(resolveToolPolicy(call({ toolName }))).toEqual({ policy: "allow", source: "default" });
  });

  it("allows ordinary edits and reviews Sensitive Paths", () => {
    expect(resolveToolPolicy(call({ toolName: "edit", input: { path: "src/a.ts" } })).policy).toBe(
      "allow",
    );
    expect(resolveToolPolicy(call({ toolName: "write", input: { path: ".env" } }))).toEqual({
      policy: "review",
      source: "default",
      detail: "Sensitive Path: a secret or environment file (.env)",
    });
    expect(resolveToolPolicy(call({ toolName: "write", input: { path: 3 } })).policy).toBe(
      "review",
    );
  });

  it("allows Safe Commands and reviews other bash calls", () => {
    expect(
      resolveToolPolicy(call({ toolName: "bash", input: { command: "git status" } })).policy,
    ).toBe("allow");
    expect(
      resolveToolPolicy(call({ toolName: "bash", input: { command: "npm test" } })).policy,
    ).toBe("review");
    expect(
      resolveToolPolicy(
        call({ toolName: "bash", input: { command: "npm test" }, safeCommands: ["npm test"] }),
      ).policy,
    ).toBe("allow");
  });

  it("reviews terminal tools even when annotated read-only", () => {
    expect(
      resolveToolPolicy(call({ toolName: "terminal_send", annotations: { readOnlyHint: true } })),
    ).toEqual({ policy: "review", source: "default" });
  });

  it("follows readOnlyHint for tools without a default, else reviews", () => {
    expect(resolveToolPolicy(call({ annotations: { readOnlyHint: true } }))).toEqual({
      policy: "allow",
      source: "annotation",
    });
    expect(resolveToolPolicy(call({ annotations: { readOnlyHint: false } }))).toEqual({
      policy: "review",
      source: "fallback",
    });
    expect(resolveToolPolicy(call({}))).toEqual({ policy: "review", source: "fallback" });
  });

  it("lets configured Tool Policies override defaults and annotations", () => {
    expect(resolveToolPolicy(call({ toolName: "read", configured: { read: "deny" } }))).toEqual({
      policy: "deny",
      source: "setting",
    });
    expect(
      resolveToolPolicy(
        call({
          toolName: "bash",
          input: { command: "rm -rf dist" },
          configured: { bash: "allow" },
        }),
      ).policy,
    ).toBe("allow");
    expect(
      resolveToolPolicy(
        call({ configured: { custom: "review" }, annotations: { readOnlyHint: true } }),
      ).policy,
    ).toBe("review");
    // Inherited object properties are not configured Tool Policies.
    expect(resolveToolPolicy(call({ toolName: "toString" })).policy).toBe("review");
  });
});
