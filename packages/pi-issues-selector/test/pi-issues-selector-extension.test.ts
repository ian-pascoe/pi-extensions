import type {
  AutocompleteProviderFactory,
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import issuesSelectorExtension from "../src/index.js";

type Handler = (
  event: InputEvent | SessionStartEvent,
  context: ExtensionContext,
) => InputEventResult | void | Promise<InputEventResult | void>;

interface Call {
  command: string;
  args: string[];
  options: ExecOptions | undefined;
}

// The CLIs' configuration is read from the real environment, so each test gets empty config
// directories and no GH_HOST, and a test that signs in to a host writes its config file there.
let ghConfigDir = "";
let glabConfigDir = "";
beforeEach(async () => {
  ghConfigDir = await mkdtemp(join(tmpdir(), "pi-issues-gh-config-"));
  glabConfigDir = await mkdtemp(join(tmpdir(), "pi-issues-glab-config-"));
  vi.stubEnv("GH_CONFIG_DIR", ghConfigDir);
  vi.stubEnv("GH_HOST", "");
  vi.stubEnv("GLAB_CONFIG_DIR", glabConfigDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(ghConfigDir, { recursive: true, force: true });
  await rm(glabConfigDir, { recursive: true, force: true });
});
const signInTo = (host: string) =>
  writeFile(join(ghConfigDir, "hosts.yml"), `${host}:\n    git_protocol: https\n    user: me\n`);
const signInToGitLab = (host: string, extra = "") =>
  writeFile(
    join(glabConfigDir, "config.yml"),
    `hosts:\n  ${host}:\n    token: secret\n    git_protocol: https\n${extra}`,
  );

const ACME = "remote.origin.url git@github.com:acme/widgets.git\n";
interface IssueExtras {
  state?: "closed";
  draft?: boolean;
  pull_request?: { merged_at?: string };
}
const issue = (number: number, title: string, extra: IssueExtras = {}) => ({
  number,
  title,
  state: "open",
  ...extra,
});
const recent = [
  issue(31, "Fix login redirect"),
  issue(30, "Add dark mode", {
    pull_request: { merged_at: "2026-01-01T00:00:00Z" },
    state: "closed",
  }),
  issue(3, "Crash on startup", { state: "closed" }),
  issue(311, "Draft: new settings page", { draft: true, pull_request: {} }),
  issue(2, "Login page typo"),
];

const GITLAB_PROJECT = "remote.origin.url git@gitlab.com:group/sub/project.git\n";
interface GitLabExtras {
  draft?: boolean;
}
const gitLabItem = (iid: number, title: string, state = "opened", extra: GitLabExtras = {}) => ({
  id: 1000 + iid,
  iid,
  title,
  state,
  ...extra,
});
const gitLabIssues = [
  gitLabItem(31, "Fix login redirect"),
  gitLabItem(3, "Crash on startup", "closed"),
  gitLabItem(2, "Login page typo"),
];
const gitLabMergeRequests = [
  gitLabItem(41, "Add dark mode", "merged"),
  gitLabItem(4, "Draft: settings page", "opened", { draft: true }),
  gitLabItem(40, "Login rewrite", "opened", { draft: false }),
  gitLabItem(5, "Old idea", "closed"),
];

class IssuesSelectorHarness {
  remotes = ACME;
  gh: ExecResult = {
    stdout: JSON.stringify(recent),
    stderr: "",
    code: 0,
    killed: false,
  };
  /** The `glab` reply for the issues listing and for the merge requests listing. */
  glab: ExecResult = {
    stdout: JSON.stringify(gitLabIssues),
    stderr: "",
    code: 0,
    killed: false,
  };
  glabMergeRequests: ExecResult = {
    stdout: JSON.stringify(gitLabMergeRequests),
    stderr: "",
    code: 0,
    killed: false,
  };
  /** Set to hold a `gh` or `glab` call until the test releases it. */
  ghGate: Promise<void> | undefined;
  readonly calls: Call[] = [];
  readonly notices: Array<[string, string | undefined]> = [];
  readonly factories: AutocompleteProviderFactory[] = [];
  cwd = "/work/project";
  private readonly handlers = new Map<string, Handler>();
  private bound = false;

  constructor() {
    const api = {
      on: (name: string, handler: Handler) => this.handlers.set(name, handler),
      exec: async (command: string, args: string[], options?: ExecOptions) => {
        if (!this.bound) throw new Error("exec called before runtime binding");
        this.calls.push({ command, args, options });
        if (command === "git") {
          return this.remotes === ""
            ? { stdout: "", stderr: "", code: 1, killed: false }
            : { stdout: this.remotes, stderr: "", code: 0, killed: false };
        }
        await this.ghGate;
        if (command === "glab") {
          return args[3]?.includes("/merge_requests?") === true
            ? this.glabMergeRequests
            : this.glab;
        }
        return this.gh;
      },
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This boundary harness supplies every ExtensionAPI method used by the extension.
    issuesSelectorExtension(api as unknown as ExtensionAPI);
    this.bound = true;
  }

  get ghCalls(): Call[] {
    return this.calls.filter((call) => call.command === "gh");
  }

  get glabCalls(): Call[] {
    return this.calls.filter((call) => call.command === "glab");
  }

  async provider(
    current: AutocompleteProvider = new CombinedAutocompleteProvider(
      [{ name: "help", description: "Native help" }],
      "/tmp",
      null,
    ),
  ): Promise<AutocompleteProvider> {
    this.factories.length = 0;
    await this.emit({ type: "session_start", reason: "startup" });
    if (this.factories.length === 0) throw new Error("Missing autocomplete provider");
    // Pi applies the factories in registration order, each over the provider before it.
    return this.factories.reduce((provider, factory) => factory(provider), current);
  }

  async emit(event: InputEvent | SessionStartEvent, mode: ExtensionContext["mode"] = "tui") {
    const handler = this.handlers.get(event.type);
    if (!handler) throw new Error(`Missing ${event.type} handler`);
    const context = {
      mode,
      cwd: this.cwd,
      hasUI: mode === "tui" || mode === "rpc",
      ui: {
        addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
          this.factories.push(factory);
        },
        notify: (message: string, type?: string) => {
          this.notices.push([message, type]);
        },
      },
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This context provides the mode, cwd, and UI members read by the registered handlers.
    return handler(event, context as unknown as ExtensionContext);
  }
}

const suggest = async (provider: AutocompleteProvider, line: string, signal?: AbortSignal) =>
  provider.getSuggestions([line], 0, line.length, {
    signal: signal ?? new AbortController().signal,
  });

describe("Pi Issues Selector popup", () => {
  test("bare # lists the most recently updated items with kind, state, and title", async () => {
    const harness = new IssuesSelectorHarness();
    const provider = await harness.provider();
    expect(await suggest(provider, "See #")).toEqual({
      prefix: "#",
      items: [
        {
          value: "#31",
          label: "#31",
          description: "issue · open · Fix login redirect",
        },
        {
          value: "#30",
          label: "#30",
          description: "PR · merged · Add dark mode",
        },
        {
          value: "#3",
          label: "#3",
          description: "issue · closed · Crash on startup",
        },
        {
          value: "#311",
          label: "#311",
          description: "PR · draft · Draft: new settings page",
        },
        {
          value: "#2",
          label: "#2",
          description: "issue · open · Login page typo",
        },
      ],
    });
  });

  test("lists at most 20 items", async () => {
    const harness = new IssuesSelectorHarness();
    harness.gh = {
      ...harness.gh,
      stdout: JSON.stringify(Array.from({ length: 100 }, (_, index) => issue(100 - index, "Item"))),
    };
    const result = await suggest(await harness.provider(), "see #");
    expect(result?.items).toHaveLength(20);
    expect(result?.items[0]?.value).toBe("#100");
  });

  test("#digits filters by number prefix, exact number first", async () => {
    const provider = await new IssuesSelectorHarness().provider();
    expect((await suggest(provider, "see #3"))?.items.map((item) => item.value)).toEqual([
      "#3",
      "#31",
      "#30",
      "#311",
    ]);
    expect((await suggest(provider, "see #31"))?.items.map((item) => item.value)).toEqual([
      "#31",
      "#311",
    ]);
    expect(await suggest(provider, "see #9")).toBeNull();
  });

  test("#text fuzzy-matches titles and inserts the number", async () => {
    const provider = await new IssuesSelectorHarness().provider();
    const result = await suggest(provider, "see #login");
    expect(result?.prefix).toBe("#login");
    expect(result?.items.map((item) => item.value)).toEqual(["#2", "#31"]);
    const item = result?.items[0];
    if (!item || !result) throw new Error("Missing suggestion");
    expect(provider.applyCompletion(["see #login"], 0, 10, item, result.prefix)).toEqual({
      lines: ["see #2 "],
      cursorLine: 0,
      cursorCol: 7,
    });
  });

  test("fetches once per repository, then serves the cache; git is read fresh each time", async () => {
    const harness = new IssuesSelectorHarness();
    const provider = await harness.provider();
    await suggest(provider, "see #");
    await suggest(provider, "see #3");
    await suggest(provider, "see #lo");
    expect(harness.ghCalls).toHaveLength(1);
    expect(harness.calls.filter((call) => call.command === "git")).toHaveLength(3);
    expect(harness.ghCalls[0]?.args).toEqual([
      "api",
      "--hostname",
      "github.com",
      "repos/acme/widgets/issues?state=all&sort=updated&per_page=100",
    ]);
    expect(harness.calls[0]).toMatchObject({
      command: "git",
      options: { cwd: "/work/project" },
    });
  });

  test("uses the current Issue Repository for each popup", async () => {
    const harness = new IssuesSelectorHarness();
    const provider = await harness.provider();
    await suggest(provider, "see #");
    harness.remotes = "remote.origin.url https://octo.ghe.com/me/core.git\n";
    await suggest(provider, "see #");
    expect(harness.ghCalls.map((call) => call.args.slice(1, 4))).toEqual([
      ["--hostname", "github.com", "repos/acme/widgets/issues?state=all&sort=updated&per_page=100"],
      ["--hostname", "octo.ghe.com", "repos/me/core/issues?state=all&sort=updated&per_page=100"],
    ]);
  });

  test("shows nothing outside a repository, beside a non-GitHub remote, or off a token boundary", async () => {
    const harness = new IssuesSelectorHarness();
    const provider = await harness.provider();
    harness.remotes = "";
    expect(await suggest(provider, "see #")).toBeNull();
    harness.remotes = "remote.origin.url git@bitbucket.org:acme/widgets.git\n";
    expect(await suggest(provider, "see #")).toBeNull();
    harness.remotes = ACME;
    expect(await suggest(provider, "acme/other#")).toBeNull();
    expect(await suggest(provider, "issue#1")).toBeNull();
    expect(await suggest(provider, "`#`")).toBeNull();
    // A lone `#` opening a line is a Markdown heading marker, so it opens no popup yet.
    expect(await suggest(provider, "#")).toBeNull();
    expect(harness.ghCalls).toHaveLength(0);
  });

  test("lists a GitHub Enterprise Server repository through gh on its host", async () => {
    await signInTo("github.corp.example");
    const harness = new IssuesSelectorHarness();
    harness.remotes = "remote.origin.url https://github.corp.example/acme/widgets.git\n";
    const provider = await harness.provider();
    expect((await suggest(provider, "see #3"))?.items[0]?.value).toBe("#3");
    expect(harness.ghCalls.map((call) => call.args)).toEqual([
      [
        "api",
        "--hostname",
        "github.corp.example",
        "repos/acme/widgets/issues?state=all&sort=updated&per_page=100",
      ],
    ]);
  });

  test("lists a host named by GH_HOST without any hosts.yml", async () => {
    vi.stubEnv("GH_HOST", "github.corp.example");
    const harness = new IssuesSelectorHarness();
    harness.remotes = "remote.origin.url git@github.corp.example:acme/widgets.git\n";
    expect(await suggest(await harness.provider(), "see #")).not.toBeNull();
    expect(harness.ghCalls[0]?.args.slice(1, 3)).toEqual(["--hostname", "github.corp.example"]);
  });

  test("shows nothing for a host gh is not signed in to", async () => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = "remote.origin.url https://github.corp.example/acme/widgets.git\n";
    expect(await suggest(await harness.provider(), "see #")).toBeNull();
    expect(harness.ghCalls).toHaveLength(0);
  });

  test("returns nothing for a cancelled request without waiting for gh", async () => {
    const harness = new IssuesSelectorHarness();
    let release: () => void = () => undefined;
    harness.ghGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = await harness.provider();
    const controller = new AbortController();
    const pending = suggest(provider, "see #", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await pending).toBeNull();
    release();
  });

  test("keeps native slash completion and stacks over other providers", async () => {
    const harness = new IssuesSelectorHarness();
    const provider = await harness.provider();
    expect(await suggest(provider, "/he")).toEqual({
      prefix: "/he",
      items: [{ value: "help", label: "help", description: "Native help" }],
    });
    expect(provider.triggerCharacters).toContain("#");
    const result = { lines: ["x"], cursorLine: 0, cursorCol: 1 };
    const current: AutocompleteProvider = {
      triggerCharacters: ["$"],
      getSuggestions: async () => ({
        prefix: "$a",
        items: [{ value: "$abc", label: "$abc" }],
      }),
      applyCompletion: () => result,
    };
    const stacked = await harness.provider(current);
    expect(await suggest(stacked, "$a")).toEqual({
      prefix: "$a",
      items: [{ value: "$abc", label: "$abc" }],
    });
    expect(stacked.triggerCharacters).toEqual(["$", "#", "!"]);
    expect(stacked.applyCompletion(["$a"], 0, 2, { value: "$abc", label: "$abc" }, "$a")).toBe(
      result,
    );
  });

  test.each(["rpc", "print", "json"] as const)(
    "does not register terminal autocomplete in %s mode",
    async (mode) => {
      const harness = new IssuesSelectorHarness();
      await harness.emit({ type: "session_start", reason: "startup" }, mode);
      expect(harness.factories).toEqual([]);
    },
  );

  test("re-registers after Pi clears providers for reload", async () => {
    const harness = new IssuesSelectorHarness();
    await harness.provider();
    harness.factories.length = 0;
    await harness.emit({ type: "session_start", reason: "reload" });
    expect(harness.factories).toHaveLength(2);
  });
});

describe("Pi Issues Selector notices", () => {
  const needsCli = (harness: IssuesSelectorHarness): void => {
    harness.gh = {
      stdout: "",
      stderr: "gh: To get started, run: gh auth login",
      code: 4,
      killed: false,
    };
  };

  test.each([
    ["no hosts.yml", undefined],
    ["a malformed hosts.yml", "a: [unclosed\n  : : :\n"],
  ])(
    "%s recognises no host: no popup, no gh call, no notice, and references stay literal",
    async (_name, hostsFile) => {
      if (hostsFile !== undefined) await writeFile(join(ghConfigDir, "hosts.yml"), hostsFile);
      const harness = new IssuesSelectorHarness();
      // Were the host recognised, gh would be asked and would say it needs signing in.
      needsCli(harness);
      harness.remotes = "remote.origin.url https://github.corp.example/acme/widgets.git\n";
      const provider = await harness.provider();
      expect(await suggest(provider, "see #")).toBeNull();
      expect(
        await harness.emit({
          type: "input",
          source: "interactive",
          text: "Fix #12",
        }),
      ).toEqual({
        action: "continue",
      });
      expect(harness.ghCalls).toHaveLength(0);
      expect(harness.notices).toEqual([]);
    },
  );

  test("says once per host that suggestions need a signed-in GitHub CLI", async () => {
    const harness = new IssuesSelectorHarness();
    needsCli(harness);
    const provider = await harness.provider();
    expect(await suggest(provider, "see #")).toBeNull();
    expect(await suggest(provider, "see #1")).toBeNull();
    harness.remotes = "remote.origin.url https://octo.ghe.com/me/core.git\n";
    expect(await suggest(provider, "see #")).toBeNull();
    expect(harness.notices).toEqual([
      [
        "Issue suggestions need the GitHub CLI (gh) signed in to github.com. Run /skill:pi-issues-selector to diagnose.",
        "info",
      ],
      [
        "Issue suggestions need the GitHub CLI (gh) signed in to octo.ghe.com. Run /skill:pi-issues-selector to diagnose.",
        "info",
      ],
    ]);
  });

  test("speaks again in a new session", async () => {
    const harness = new IssuesSelectorHarness();
    needsCli(harness);
    await suggest(await harness.provider(), "see #");
    await suggest(await harness.provider(), "see #");
    expect(harness.notices).toHaveLength(2);
  });

  test.each([
    ["a network error", "error connecting to api.github.com"],
    ["a rate limit", "gh: API rate limit exceeded (HTTP 403)"],
    ["a missing repository", "gh: Not Found (HTTP 404)"],
  ])("stays silent for %s", async (_name, stderr) => {
    const harness = new IssuesSelectorHarness();
    harness.gh = { stdout: "", stderr, code: 1, killed: false };
    expect(await suggest(await harness.provider(), "see #")).toBeNull();
    expect(harness.notices).toEqual([]);
  });
});

describe("Pi Issues Selector input", () => {
  const submit = (harness: IssuesSelectorHarness, text: string) =>
    harness.emit({ type: "input", source: "interactive", text });

  test("converts bare and qualified references against the Issue Repository", async () => {
    const harness = new IssuesSelectorHarness();
    expect(await submit(harness, "Fix #12 like acme/other#3.")).toEqual({
      action: "transform",
      text: "Fix [#12](https://github.com/acme/widgets/issues/12) like [acme/other#3](https://github.com/acme/other/issues/3).",
    });
    expect(harness.calls).toEqual([
      {
        command: "git",
        args: [
          "config",
          "--get-regexp",
          "^remote\\..*\\.(url|gh-resolved|glab-resolved-base|glab-resolved)$",
        ],
        options: expect.objectContaining({ cwd: "/work/project" }),
      },
    ]);
  });

  test("reads the remotes fresh on every submission that has a candidate", async () => {
    const harness = new IssuesSelectorHarness();
    await submit(harness, "#1");
    harness.remotes = "remote.origin.url https://octo.ghe.com/me/core.git\n";
    expect(await submit(harness, "#1")).toEqual({
      action: "transform",
      text: "[#1](https://octo.ghe.com/me/core/issues/1)",
    });
  });

  test("runs no command for text that cannot hold a reference", async () => {
    const harness = new IssuesSelectorHarness();
    expect(await submit(harness, "Nothing to see, no #hash and #0 or #x")).toEqual({
      action: "continue",
    });
    expect(harness.calls).toEqual([]);
  });

  test.each([
    ["Bitbucket", "remote.origin.url git@bitbucket.org:acme/widgets.git\n"],
    [
      "a GitLab host that glab is not signed in to",
      "remote.origin.url git@gitlab.corp.example:acme/widgets.git\n",
    ],
    ["a local path", "remote.origin.url /srv/git/widgets.git\n"],
    ["a file URL", "remote.origin.url file:///srv/git/widgets.git\n"],
    ["an SSH host alias", "remote.origin.url git@gh-work:acme/widgets.git\n"],
  ])("leaves every reference literal beside %s", async (_name, remotes) => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = remotes;
    expect(await submit(harness, "See #1 and acme/other#2")).toEqual({
      action: "continue",
    });
  });

  test("links an ssh.github.com remote on github.com", async () => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = "remote.origin.url ssh://git@ssh.github.com:443/acme/widgets.git\n";
    expect(await submit(harness, "See #1")).toEqual({
      action: "transform",
      text: "See [#1](https://github.com/acme/widgets/issues/1)",
    });
    await (
      await harness.provider()
    ).getSuggestions(["see #"], 0, 5, {
      signal: new AbortController().signal,
    });
    expect(harness.ghCalls[0]?.args.slice(1, 3)).toEqual(["--hostname", "github.com"]);
  });

  test("leaves bare references literal without a repository or beside another host", async () => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = "";
    expect(await submit(harness, "See #1")).toEqual({ action: "continue" });
    expect(await submit(harness, "See acme/other#2")).toEqual({
      action: "transform",
      text: "See [acme/other#2](https://github.com/acme/other/issues/2)",
    });
    harness.remotes = "remote.origin.url git@bitbucket.org:acme/widgets.git\n";
    expect(await submit(harness, "See #1 and acme/other#2")).toEqual({
      action: "continue",
    });
  });

  test("converts on a GitHub Enterprise Server host gh is signed in to, as soon as it is", async () => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = "remote.origin.url https://github.corp.example/acme/widgets.git\n";
    expect(await submit(harness, "Fix #12")).toEqual({ action: "continue" });
    await signInTo("github.corp.example");
    expect(await submit(harness, "Fix #12")).toEqual({
      action: "transform",
      text: "Fix [#12](https://github.corp.example/acme/widgets/issues/12)",
    });
  });

  test("converts on a host named by GH_HOST, with no hosts.yml", async () => {
    vi.stubEnv("GH_HOST", "github.corp.example");
    const harness = new IssuesSelectorHarness();
    harness.remotes = "remote.origin.url https://github.corp.example/acme/widgets.git\n";
    expect(await submit(harness, "Fix #12")).toEqual({
      action: "transform",
      text: "Fix [#12](https://github.corp.example/acme/widgets/issues/12)",
    });
  });

  test("treats a failing git like a missing repository", async () => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = "";
    expect(await submit(harness, "#1")).toEqual({ action: "continue" });
  });

  test.each(["interactive", "rpc"] as const)(
    "preserves %s attachments and steering/follow-up delivery",
    async (source) => {
      const harness = new IssuesSelectorHarness();
      for (const streamingBehavior of ["steer", "followUp"] as const) {
        const event: InputEvent = {
          type: "input",
          source,
          text: "#5",
          streamingBehavior,
          images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        };
        expect(await harness.emit(event, source === "rpc" ? "rpc" : "tui")).toEqual({
          action: "transform",
          text: "[#5](https://github.com/acme/widgets/issues/5)",
          images: event.images,
        });
        expect(event.text).toBe("#5");
      }
    },
  );

  test("converts in print mode and leaves extension-generated messages alone", async () => {
    const harness = new IssuesSelectorHarness();
    expect(
      await harness.emit({ type: "input", source: "interactive", text: "#5" }, "print"),
    ).toMatchObject({ action: "transform" });
    expect(await harness.emit({ type: "input", source: "extension", text: "#5" })).toEqual({
      action: "continue",
    });
    expect(harness.calls).toHaveLength(1);
  });
});

describe("Pi Issues Selector GitLab popup", () => {
  const gitLab = (): IssuesSelectorHarness => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = GITLAB_PROJECT;
    return harness;
  };
  const issuesPath =
    "projects/group%2Fsub%2Fproject/issues?state=all&order_by=updated_at&sort=desc&per_page=100";
  const mergeRequestsPath =
    "projects/group%2Fsub%2Fproject/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=100";

  test("# lists the project's issues through glab api, and only issues", async () => {
    const harness = gitLab();
    expect(await suggest(await harness.provider(), "See #")).toEqual({
      prefix: "#",
      items: [
        {
          value: "#31",
          label: "#31",
          description: "issue · open · Fix login redirect",
        },
        {
          value: "#3",
          label: "#3",
          description: "issue · closed · Crash on startup",
        },
        {
          value: "#2",
          label: "#2",
          description: "issue · open · Login page typo",
        },
      ],
    });
    expect(harness.ghCalls).toEqual([]);
    expect(harness.glabCalls.map((call) => [call.command, call.args])).toEqual([
      ["glab", ["api", "--hostname", "gitlab.com", issuesPath]],
    ]);
  });

  test("! lists the project's merge requests through glab api, and only merge requests", async () => {
    const harness = gitLab();
    expect(await suggest(await harness.provider(), "See !")).toEqual({
      prefix: "!",
      items: [
        {
          value: "!41",
          label: "!41",
          description: "MR · merged · Add dark mode",
        },
        {
          value: "!4",
          label: "!4",
          description: "MR · draft · Draft: settings page",
        },
        {
          value: "!40",
          label: "!40",
          description: "MR · open · Login rewrite",
        },
        { value: "!5", label: "!5", description: "MR · closed · Old idea" },
      ],
    });
    expect(harness.glabCalls.map((call) => call.args)).toEqual([
      ["api", "--hostname", "gitlab.com", mergeRequestsPath],
    ]);
  });

  test("! filters by number prefix, fuzzy-matches titles, and inserts !<number>", async () => {
    const provider = await gitLab().provider();
    expect((await suggest(provider, "see !4"))?.items.map((item) => item.value)).toEqual([
      "!4",
      "!41",
      "!40",
    ]);
    const result = await suggest(provider, "see !login");
    expect(result?.items.map((item) => item.value)).toEqual(["!40"]);
    const item = result?.items[0];
    if (!item || !result) throw new Error("Missing suggestion");
    expect(provider.applyCompletion(["see !login"], 0, 10, item, result.prefix)).toEqual({
      lines: ["see !40 "],
      cursorLine: 0,
      cursorCol: 8,
    });
  });

  test("# and ! keep separate caches, each fetched once", async () => {
    const harness = gitLab();
    const provider = await harness.provider();
    await suggest(provider, "see #");
    await suggest(provider, "see !");
    await suggest(provider, "see #3");
    await suggest(provider, "see !4");
    expect(harness.glabCalls.map((call) => call.args[3])).toEqual([issuesPath, mergeRequestsPath]);
  });

  test("!= opens no popup", async () => {
    const harness = gitLab();
    const provider = await harness.provider();
    expect(await suggest(provider, "a !=")).toBeNull();
    expect(await suggest(provider, "a != b")).toBeNull();
    expect(harness.glabCalls).toEqual([]);
  });

  test("a message that starts with ! is bash mode: the provider it wraps answers", async () => {
    const harness = gitLab();
    const answer = { prefix: "src", items: [{ value: "src/", label: "src/" }] };
    const getSuggestions = vi.fn(async () => answer);
    const current: AutocompleteProvider = {
      getSuggestions,
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    };
    const provider = await harness.provider(current);
    expect(await suggest(provider, "!ls !")).toBe(answer);
    expect(await suggest(provider, "  !ls !4")).toBe(answer);
    expect(
      await provider.getSuggestions(["", "!ls !"], 1, 5, {
        signal: new AbortController().signal,
      }),
    ).toBe(answer);
    expect(getSuggestions).toHaveBeenCalledTimes(3);
    expect(harness.glabCalls).toEqual([]);
    // Other text starts no bash command, so the popup lists merge requests.
    expect((await suggest(provider, "run !"))?.prefix).toBe("!");
    expect(harness.glabCalls).toHaveLength(1);
  });

  test("! offers nothing on a GitHub checkout, which has no merge requests", async () => {
    const harness = new IssuesSelectorHarness();
    expect(await suggest(await harness.provider(), "see !")).toBeNull();
    expect(harness.ghCalls).toEqual([]);
    expect(harness.glabCalls).toEqual([]);
  });

  test("! offers nothing outside a repository or beside an unrecognised host", async () => {
    const harness = gitLab();
    const provider = await harness.provider();
    harness.remotes = "";
    expect(await suggest(provider, "see !")).toBeNull();
    harness.remotes = "remote.origin.url git@gitlab.corp.example:group/project.git\n";
    expect(await suggest(provider, "see !")).toBeNull();
    expect(harness.glabCalls).toEqual([]);
  });

  test("lists a self-managed host that glab is configured for", async () => {
    await signInToGitLab("gitlab.corp.example");
    const harness = new IssuesSelectorHarness();
    harness.remotes = "remote.origin.url https://gitlab.corp.example/group/project.git\n";
    expect((await suggest(await harness.provider(), "see #3"))?.items[0]?.value).toBe("#3");
    expect(harness.glabCalls.map((call) => call.args.slice(0, 3))).toEqual([
      ["api", "--hostname", "gitlab.corp.example"],
    ]);
  });

  test("lists an ssh_host remote through the web host", async () => {
    await signInToGitLab("gitlab.corp.example", "    ssh_host: ssh.corp.example\n");
    const harness = new IssuesSelectorHarness();
    harness.remotes = "remote.origin.url git@ssh.corp.example:group/project.git\n";
    expect(await suggest(await harness.provider(), "see #")).not.toBeNull();
    expect(harness.glabCalls[0]?.args.slice(0, 4)).toEqual([
      "api",
      "--hostname",
      "gitlab.corp.example",
      "projects/group%2Fproject/issues?state=all&order_by=updated_at&sort=desc&per_page=100",
    ]);
  });

  test("a host both gh and glab are configured for is not recognised", async () => {
    await signInTo("both.example");
    await signInToGitLab("both.example");
    const harness = new IssuesSelectorHarness();
    harness.remotes = "remote.origin.url https://both.example/group/project.git\n";
    expect(await suggest(await harness.provider(), "see #")).toBeNull();
    expect(await suggest(await harness.provider(), "see !")).toBeNull();
    expect(harness.ghCalls).toEqual([]);
    expect(harness.glabCalls).toEqual([]);
  });

  test("a glab-marked remote decides the project", async () => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = [
      "remote.upstream.url git@gitlab.com:other/upstream.git",
      "remote.origin.url git@gitlab.com:group/sub/project.git",
      "remote.origin.glab-resolved-base base",
    ].join("\n");
    await suggest(await harness.provider(), "see #");
    expect(harness.glabCalls[0]?.args[3]).toBe(issuesPath);
  });
});

describe("Pi Issues Selector GitLab notices", () => {
  const signedOut = (harness: IssuesSelectorHarness): void => {
    harness.remotes = GITLAB_PROJECT;
    harness.glab = {
      stdout: "",
      stderr: "glab: 404 Project Not Found",
      code: 1,
      killed: false,
    };
    harness.glabMergeRequests = harness.glab;
  };

  test("names the GitLab CLI once per host and session, for # and ! alike", async () => {
    const harness = new IssuesSelectorHarness();
    signedOut(harness);
    const provider = await harness.provider();
    expect(await suggest(provider, "see #")).toBeNull();
    expect(await suggest(provider, "see !")).toBeNull();
    expect(await suggest(provider, "see #1")).toBeNull();
    expect(harness.notices).toEqual([
      [
        "Issue suggestions need the GitLab CLI (glab) signed in to gitlab.com. Run /skill:pi-issues-selector to diagnose.",
        "info",
      ],
    ]);
    expect(harness.glabCalls).toHaveLength(2);
  });

  test("a self-managed host is named by its web host", async () => {
    await signInToGitLab("gitlab.corp.example");
    const harness = new IssuesSelectorHarness();
    signedOut(harness);
    harness.remotes = "remote.origin.url https://gitlab.corp.example/group/project.git\n";
    await suggest(await harness.provider(), "see !");
    expect(harness.notices.map(([message]) => message)).toEqual([
      "Issue suggestions need the GitLab CLI (glab) signed in to gitlab.corp.example. Run /skill:pi-issues-selector to diagnose.",
    ]);
  });

  test.each([
    ["a rate limit", "glab: 429 Too Many Requests"],
    ["a forbidden project", "glab: 403 Forbidden"],
    ["a network error", "error connecting to gitlab.com"],
  ])("stays silent for %s", async (_name, stderr) => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = GITLAB_PROJECT;
    harness.glab = { stdout: "", stderr, code: 1, killed: false };
    expect(await suggest(await harness.provider(), "see #")).toBeNull();
    expect(harness.notices).toEqual([]);
  });

  test("a missing glab, which prints nothing, asks for the GitLab CLI", async () => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = GITLAB_PROJECT;
    harness.glab = { stdout: "", stderr: "", code: 1, killed: false };
    await suggest(await harness.provider(), "see #");
    expect(harness.notices).toHaveLength(1);
  });
});

describe("Pi Issues Selector GitLab input", () => {
  const submit = (harness: IssuesSelectorHarness, text: string) =>
    harness.emit({ type: "input", source: "interactive", text });
  const gitLab = (remotes = GITLAB_PROJECT): IssuesSelectorHarness => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = remotes;
    return harness;
  };

  test("converts # to an issue link and ! to a merge request link", async () => {
    expect(await submit(gitLab(), "Fix #12 and !3")).toEqual({
      action: "transform",
      text: "Fix [#12](https://gitlab.com/group/sub/project/-/issues/12) and [!3](https://gitlab.com/group/sub/project/-/merge_requests/3)",
    });
  });

  test("converts qualified references against the Issue Repository's host", async () => {
    expect(await submit(gitLab(), "See other/team/proj#12 and other/team/proj!4.")).toEqual({
      action: "transform",
      text: "See [other/team/proj#12](https://gitlab.com/other/team/proj/-/issues/12) and [other/team/proj!4](https://gitlab.com/other/team/proj/-/merge_requests/4).",
    });
  });

  test.each([
    "see ./foo/bar#12",
    "e.g./x#1",
    "~/a/b#1",
    "issue#123",
    "group/proj.git#3",
    "a != b and x!=3",
    "Hello!3",
    "proj#12",
  ])("leaves %j literal", async (text) => {
    expect(await submit(gitLab(), text)).toEqual({ action: "continue" });
  });

  test("converts on a self-managed host that glab is configured for", async () => {
    await signInToGitLab("gitlab.corp.example", "    ssh_host: ssh.corp.example\n");
    const harness = gitLab("remote.origin.url git@ssh.corp.example:group/project.git\n");
    expect(await submit(harness, "Fix #12 and !3")).toEqual({
      action: "transform",
      text: "Fix [#12](https://gitlab.corp.example/group/project/-/issues/12) and [!3](https://gitlab.corp.example/group/project/-/merge_requests/3)",
    });
  });

  test("stays literal beside a host that both gh and glab are configured for", async () => {
    await signInTo("both.example");
    await signInToGitLab("both.example");
    const harness = gitLab("remote.origin.url https://both.example/group/project.git\n");
    expect(await submit(harness, "Fix #12 and !3 and a/b#1")).toEqual({
      action: "continue",
    });
  });

  test("a GitHub checkout keeps ! literal and converts # as before", async () => {
    expect(await submit(new IssuesSelectorHarness(), "Fix #12 and !3 and a/b/c#4")).toEqual({
      action: "transform",
      text: "Fix [#12](https://github.com/acme/widgets/issues/12) and !3 and a/b/c#4",
    });
  });

  test("a message with only ! runs the host lookup too", async () => {
    const harness = gitLab();
    await submit(harness, "!3");
    expect(harness.calls.map((call) => call.command)).toEqual(["git"]);
  });

  test("without remotes, a qualified GitHub reference still converts and ! stays literal", async () => {
    const harness = new IssuesSelectorHarness();
    harness.remotes = "";
    expect(await submit(harness, "See acme/other#2 and !3")).toEqual({
      action: "transform",
      text: "See [acme/other#2](https://github.com/acme/other/issues/2) and !3",
    });
  });
});
