import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  await mkdir(join(root, "home"), { recursive: true });
  await writeFile(join(workspace, "src", "original.ts"), "");
  await link(join(workspace, "src", "original.ts"), join(workspace, "src", "hard-link.ts"));
  paths = { cwd: workspace, piDirectories: [join(root, "agent")], home: join(root, "home") };
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
    ["the home directory", "~/notes.txt", "outside the workspace root"],
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
    [
      "agent configuration",
      ".agents/skills/x/SKILL.md",
      "agent Skills and configuration (.agents)",
    ],
    ["git hooks", ".husky/pre-commit", "git hooks (.husky)"],
    ["CI workflows", ".github/workflows/ci.yml", "CI workflows (.github/workflows)"],
    ["editor tasks", ".vscode/tasks.json", "editor tasks and settings (.vscode)"],
    ["a context file", "AGENTS.md", "a context file Pi loads as instructions (AGENTS.md)"],
    [
      "a nested context file",
      "pkg/claude.MD",
      "a context file Pi loads as instructions (claude.MD)",
    ],
    [
      "an override context file",
      "AGENTS.override.md",
      "a context file Pi loads as instructions (AGENTS.override.md)",
    ],
    [
      "a hard-linked file",
      "src/hard-link.ts",
      "a file with more than one hard link, so editing it changes another path too",
    ],
  ])("reviews %s", (_case, path, reason) => {
    expect(sensitivePathReason(path, paths)).toBe(reason);
  });

  it.each([
    ".bashrc",
    ".zshenv",
    ".profile",
    ".config/fish/config.fish",
    ".config/systemd/user/x.service",
    ".ssh/authorized_keys",
    ".gnupg/gpg.conf",
    ".aws/credentials",
    ".gitconfig",
    ".npmrc",
    ".netrc",
    ".docker/config.json",
    ".kube/config",
    ".local/bin/git",
  ])("reviews ~/%s as a persistence or credential location wherever the workspace is", (path) => {
    const home = join(root, "home");
    const inHome = { cwd: join(home, "project"), piDirectories: [], home };
    expect(sensitivePathReason(join(home, path), inHome)).toMatch(
      /^a shell startup, credential, or persistence location in the home directory/,
    );
  });

  it.each([
    ["the home directory", (home: string) => home],
    ["an ancestor of the home directory", (home: string) => join(home, "..")],
    ["the file system root", () => "/"],
  ])("reviews every edit when the workspace is %s", (_case, cwd) => {
    const home = join(root, "home");
    const context = { cwd: cwd(home), piDirectories: [], home };
    expect(sensitivePathReason(join(home, "notes.txt"), context)).toBe(
      "the workspace root contains the home directory, so every file is reviewed",
    );
    expect(sensitivePathReason(join(home, "project", "src", "a.ts"), context)).toBe(
      "the workspace root contains the home directory, so every file is reviewed",
    );
  });

  it("treats resources Pi loaded as sensitive wherever they are", () => {
    const skill = join(root, "outside", "skills", "deploy");
    const context = { ...paths, loadedResources: [skill, join(workspace, "docs", "prompt.md")] };
    expect(sensitivePathReason(join(skill, "SKILL.md"), context)).toBe(
      "a context file, Skill, prompt template, or extension Pi loaded",
    );
    expect(sensitivePathReason("docs/prompt.md", context)).toBe(
      "a context file, Skill, prompt template, or extension Pi loaded",
    );
    expect(sensitivePathReason("docs/other.md", context)).toBeUndefined();
  });

  it("reviews Windows path forms on Windows", () => {
    const windows = { ...paths, platform: "win32" as const };
    expect(sensitivePathReason("src\\a.ts", windows)).toBe(
      "a Windows path form Guardian does not judge",
    );
    expect(sensitivePathReason("C:/repo/a.ts", windows)).toBe(
      "a Windows path form Guardian does not judge",
    );
    expect(sensitivePathReason("src/a.ts", windows)).toBeUndefined();
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
    const project = { cwd: join(homedir(), "guardian-test-project"), piDirectories: [] };
    expect(sensitivePathReason("~/guardian-test-project/notes.txt", project)).toBeUndefined();
    expect(sensitivePathReason("~/guardian-test-project/.pi/settings.json", project)).toBe(
      "Pi configuration (.pi)",
    );
    expect(sensitivePathReason("~/.bashrc", project)).toBe(
      "a shell startup, credential, or persistence location in the home directory (.bashrc)",
    );
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
