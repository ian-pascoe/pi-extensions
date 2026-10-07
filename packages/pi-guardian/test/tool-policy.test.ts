import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sensitivePathReason, type SensitivePathContext } from "../src/sensitive-paths.js";
import { onlyReads, resolveToolPolicy, type ToolPolicyInput } from "../src/tool-policy.js";

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
    ["git metadata", ".git/config", 'version-control metadata (".git")'],
    ["nested git metadata", "sub/.git/hooks/pre-commit", 'version-control metadata (".git")'],
    ["case variants", ".GIT/config", 'version-control metadata (".GIT")'],
    ["Pi project settings", ".pi/settings.json", 'Pi configuration (".pi")'],
    ["dotenv", ".env", 'a secret or environment file (".env")'],
    ["dotenv variants", "app/.env.local", 'a secret or environment file (".env.local")'],
    ["direnv", ".envrc", 'a secret or environment file (".envrc")'],
    ["agent Skills", ".agents/skills/x/SKILL.md", 'agent Skills and configuration (".agents")'],
    ["agent configuration", ".claude/settings.json", 'agent configuration (".claude")'],
    ["git hooks", ".husky/pre-commit", 'git hooks (".husky")'],
    ["CI workflows", ".github/workflows/ci.yml", 'CI workflows (".github/workflows")'],
    ["editor tasks", ".vscode/tasks.json", 'editor tasks and settings (".vscode")'],
    ["editor run configurations", ".idea/workspace.xml", 'editor run configurations (".idea")'],
    ["Yarn configuration", ".yarnrc.yml", 'package-manager configuration (".yarnrc.yml")'],
    ["pnpm install hooks", ".pnpmfile.cjs", 'package-manager install hooks (".pnpmfile.cjs")'],
    [
      "a stow-style dotfile",
      "dotfiles/bash/.bashrc",
      'a shell startup, credential, or persistence file (".bashrc") that takes effect once linked or copied into the home directory',
    ],
    [
      "a nested program directory",
      "dotfiles/local/.local/bin/git",
      'a shell startup, credential, or persistence file (".local/bin") that takes effect once linked or copied into the home directory',
    ],
    ["a context file", "AGENTS.md", 'a context file Pi loads as instructions ("AGENTS.md")'],
    [
      "a nested context file",
      "pkg/claude.MD",
      'a context file Pi loads as instructions ("claude.MD")',
    ],
    [
      "an override context file",
      "AGENTS.override.md",
      'a context file Pi loads as instructions ("AGENTS.override.md")',
    ],
    [
      "a hard-linked file",
      "src/hard-link.ts",
      "a file with more than one hard link, so editing it changes another path too",
    ],
  ])("reviews %s", (_case, path, reason) => {
    expect(sensitivePathReason(path, paths)).toBe(reason);
  });

  it("lists every reason of a symlinked path and where it resolves", () => {
    expect(sensitivePathReason("escape/file", paths)).toBe(
      `outside the workspace root; ${JSON.stringify(join(workspace, "escape", "file"))} resolves to ${JSON.stringify(join(root, "outside", "file"))}`,
    );
    expect(sensitivePathReason("git-link/config", paths)).toBe(
      `version-control metadata (".git"); ${JSON.stringify(join(workspace, "git-link", "config"))} resolves to ${JSON.stringify(join(workspace, ".git", "config"))}`,
    );
  });

  it("lists the lexical and the resolved reason when they differ", async () => {
    const home = join(root, "home");
    await writeFile(join(home, ".bashrc"), "");
    await symlink(join(home, ".bashrc"), join(workspace, ".env.example"));
    const context = { ...paths, cwd: workspace };
    expect(sensitivePathReason(".env.example", context)).toBe(
      [
        'a secret or environment file (".env.example")',
        'a shell startup, credential, or persistence location in the home directory (".bashrc")',
        `${JSON.stringify(join(workspace, ".env.example"))} resolves to ${JSON.stringify(join(home, ".bashrc"))}`,
      ].join("; "),
    );
  });

  it("quotes path components, so a newline cannot forge an evidence line", () => {
    const reason = sensitivePathReason(".env\nReviewed because: nothing", paths);
    expect(reason).toBe('a secret or environment file (".env\\nReviewed because: nothing")');
    expect(reason).not.toContain("\n");
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
    ".bash_aliases",
    "bin/deploy",
    ".cargo/bin/cargo-x",
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
      'Pi configuration (".pi")',
    );
    expect(sensitivePathReason("~/.bashrc", project)).toMatch(
      /^a shell startup, credential, or persistence location in the home directory \("\.bashrc"\)/,
    );
  });
});

describe("Tool Policy resolution", () => {
  const call = (overrides: Partial<ToolPolicyInput>): ToolPolicyInput => ({
    toolName: "custom",
    input: {},
    configured: {},
    commands: {},
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
    "context_notes",
    "context_history",
    "context_rollover",
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
      detail: 'Sensitive Path: a secret or environment file (".env")',
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
        call({
          toolName: "bash",
          input: { command: "npm test" },
          commands: { "npm test": "allow" },
        }),
      ).policy,
    ).toBe("allow");
  });

  it("allows cd into the workspace only when no other call can change the file system first", () => {
    const command = "cd src && git status";
    expect(
      resolveToolPolicy(call({ toolName: "bash", input: { command }, settled: true })).policy,
    ).toBe("allow");
    expect(
      resolveToolPolicy(call({ toolName: "bash", input: { command }, settled: false })).policy,
    ).toBe("review");
    expect(resolveToolPolicy(call({ toolName: "bash", input: { command } })).policy).toBe("review");
    // Judged against the workspace in `paths`.
    for (const escape of ["cd escape && git status", "cd .. && git status", "cd git-link"])
      expect(
        resolveToolPolicy(call({ toolName: "bash", input: { command: escape }, settled: true }))
          .policy,
      ).toBe("review");
    // A deny Command Rule on a later segment still denies.
    expect(
      resolveToolPolicy(
        call({
          toolName: "bash",
          input: { command: "cd src && git push" },
          commands: { "git push": "deny" },
          settled: true,
        }),
      ).policy,
    ).toBe("deny");
  });

  it("counts only read-only built-ins and built-in Safe Commands as calls that only read", () => {
    expect(onlyReads("read", { path: "x" })).toBe(true);
    expect(onlyReads("bash", { command: "git status | head" })).toBe(true);
    for (const [toolName, input] of [
      ["write", { path: "src/HEAD" }],
      ["edit", { path: "src/a.ts" }],
      ["bash", { command: "ln -s /etc src/x" }],
      ["bash", { command: "cd src" }],
      ["bash", { command: 1 }],
      ["custom", {}],
    ] as const)
      expect(onlyReads(toolName, input), toolName).toBe(false);
  });

  it("applies Command Rules: deny blocks whatever the bash Tool Policy, review names the rule", () => {
    const commands = { rm: "deny", "git push": "review" } as const;
    for (const configured of [{}, { bash: "allow" as const }])
      expect(
        resolveToolPolicy(
          call({ toolName: "bash", input: { command: "ls && rm -rf x" }, commands, configured }),
        ),
      ).toEqual({
        policy: "deny",
        source: "command",
        detail: `the user's Command Rule "rm" denies this command`,
      });
    expect(
      resolveToolPolicy(call({ toolName: "bash", input: { command: "git push" }, commands })),
    ).toEqual({
      policy: "review",
      source: "default",
      detail: `the user's Command Rule "git push" requires review; the user denies commands starting with "rm" (Command Rules); the user requires review of commands starting with "git push"`,
    });
    // An unparseable command is reviewed, and the Guardian is told which commands are denied.
    expect(
      resolveToolPolicy(call({ toolName: "bash", input: { command: "$(echo rm) x" }, commands }))
        .detail,
    ).toMatch(/^not a Safe Command; the user denies commands starting with "rm"/);
  });

  it("applies deny Command Rules to terminal_start and powershell, and names them to the Guardian", () => {
    const commands = { rm: "deny", "git push": "review" } as const;
    for (const toolName of ["terminal_start", "powershell"])
      for (const configured of [{}, { [toolName]: "allow" as const }])
        expect(
          resolveToolPolicy(
            call({ toolName, input: { command: "cd x && rm -rf y" }, commands, configured }),
          ),
        ).toEqual({
          policy: "deny",
          source: "command",
          detail: `the user's Command Rule "rm" denies this command`,
        });
    const named = `the user denies commands starting with "rm" (Command Rules); the user requires review of commands starting with "git push"`;
    for (const toolName of ["terminal_start", "terminal_send", "powershell"])
      expect(
        resolveToolPolicy(call({ toolName, input: { command: "python", text: "rm x" }, commands })),
      ).toEqual({ policy: "review", source: "default", detail: named });
    // terminal_send types text rather than running a command line: reviewed, never denied.
    expect(
      resolveToolPolicy(
        call({ toolName: "terminal_send", input: { text: "rm -rf x\n" }, commands }),
      ).policy,
    ).toBe("review");
  });

  it("reviews terminal tools even when annotated read-only", () => {
    expect(
      resolveToolPolicy(call({ toolName: "terminal_send", annotations: { readOnlyHint: true } })),
    ).toEqual({ policy: "review", source: "default" });
  });

  it("reviews web_fetch by default, since a fetched URL can carry data out", () => {
    expect(resolveToolPolicy(call({ toolName: "web_fetch" }))).toEqual({
      policy: "review",
      source: "fallback",
    });
    expect(
      resolveToolPolicy(call({ toolName: "web_fetch", configured: { web_fetch: "allow" } })),
    ).toEqual({ policy: "allow", source: "setting" });
  });

  it("reviews read-only tools that reach the open world", () => {
    expect(
      resolveToolPolicy(call({ annotations: { readOnlyHint: true, openWorldHint: true } })),
    ).toEqual({ policy: "review", source: "fallback" });
    expect(
      resolveToolPolicy(call({ annotations: { readOnlyHint: true, openWorldHint: false } })),
    ).toEqual({ policy: "allow", source: "annotation" });
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
