import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  getMcpServerCatalogue,
  matchMcpServers,
  transformMcpServerReferences,
  type McpServer,
} from "../src/mcp-server-references.js";

type CatalogueTool = Pick<ToolInfo, "exposure" | "namespace">;

function tool(
  namespace: string,
  exposure: ToolInfo["exposure"] = "codemode",
  details: { aliases?: string[]; description?: string; instructions?: string } = {},
): CatalogueTool {
  return { exposure, namespace: { name: namespace, ...details } };
}

const servers: McpServer[] = [
  { name: "github", namespace: "mcp__github" },
  { name: "dev-radius", namespace: "mcp__dev_radius" },
  { name: "git", namespace: "mcp__git" },
];

const link = (text: string, name: string, namespace: string): string =>
  `[${text}](mcp://${name} "MCP server ${namespace}")`;

describe("MCP Server Catalogue", () => {
  test("lists each mcp__ namespace once with a tool that is not hidden, sorted by name", () => {
    expect(
      getMcpServerCatalogue([
        tool("mcp__zed", "deferred"),
        tool("mcp__github", "direct"),
        tool("mcp__github", "codemode"),
        tool("mcp__off", "hidden"),
        tool("mcp__off", "hidden"),
        tool("mcp__mixed", "hidden"),
        tool("mcp__mixed", "codemode"),
        tool("docs", "direct"),
        { exposure: "direct" },
      ]),
    ).toEqual([
      { name: "github", namespace: "mcp__github" },
      { name: "mixed", namespace: "mcp__mixed" },
      { name: "zed", namespace: "mcp__zed" },
    ]);
  });

  test("names a server by its first alias, which Pi sets to the configured name", () => {
    expect(
      getMcpServerCatalogue([
        tool("mcp__dev_radius", "codemode", { aliases: ["dev-radius", "other"] }),
        tool("mcp__plain", "codemode", { aliases: [] }),
        tool("mcp__bad", "codemode", { aliases: ["not a name"] }),
      ]),
    ).toEqual([
      { name: "bad", namespace: "mcp__bad" },
      { name: "dev-radius", namespace: "mcp__dev_radius" },
      { name: "plain", namespace: "mcp__plain" },
    ]);
  });

  test("describes a server by its namespace description, else the first line of its instructions", () => {
    expect(
      getMcpServerCatalogue([
        tool("mcp__a", "codemode", { description: "  Search code.  ", instructions: "ignored" }),
        tool("mcp__b", "codemode", { instructions: "\n\n  Query tickets.\nSecond line." }),
        tool("mcp__c", "codemode", { description: " ", instructions: "" }),
      ]),
    ).toEqual([
      { name: "a", namespace: "mcp__a", description: "Search code." },
      { name: "b", namespace: "mcp__b", description: "Query tickets." },
      { name: "c", namespace: "mcp__c" },
    ]);
  });

  test("skips namespaces whose names cannot be written as a reference", () => {
    expect(getMcpServerCatalogue([tool("mcp__", "direct"), tool("mcp__a.b", "direct")])).toEqual(
      [],
    );
  });
});

describe("MCP server matching", () => {
  test("lists every server by name for an empty query", () => {
    expect(matchMcpServers(servers, "").map((server) => server.name)).toEqual([
      "dev-radius",
      "git",
      "github",
    ]);
  });

  test("keeps servers whose name contains the query, prefix matches first", () => {
    expect(matchMcpServers(servers, "git").map((server) => server.name)).toEqual(["git", "github"]);
    expect(matchMcpServers(servers, "HUB").map((server) => server.name)).toEqual(["github"]);
    expect(matchMcpServers(servers, "radius")).toEqual([servers[1]]);
    expect(matchMcpServers(servers, "zzz")).toEqual([]);
  });

  test("treats hyphen and underscore as one character", () => {
    expect(matchMcpServers(servers, "dev_ra")).toEqual([servers[1]]);
    expect(matchMcpServers(servers, "v-r")).toEqual([servers[1]]);
  });
});

describe("MCP Server Reference conversion", () => {
  test("converts known names to links naming the server and its Pi namespace", () => {
    expect(transformMcpServerReferences("Use @github and @git.", servers)).toBe(
      `Use ${link("@github", "github", "mcp__github")} and ${link("@git", "git", "mcp__git")}.`,
    );
  });

  test("treats hyphen and underscore as one character, keeping the typed text", () => {
    expect(transformMcpServerReferences("@dev_radius @dev-radius", servers)).toBe(
      `${link("@dev_radius", "dev-radius", "mcp__dev_radius")} ${link("@dev-radius", "dev-radius", "mcp__dev_radius")}`,
    );
  });

  test.each([
    ["Ask @github's tools", "'s"],
    ["Ask @github.", "."],
    ["Ask (@github)", ")"],
    ["Ask @github, please", ","],
    ["Ask @github: list issues", ": "],
    ["Ask @github:", ":"],
    ["Ask\n@github\nnow", "\nnow"],
  ])("converts %j", (text) => {
    expect(transformMcpServerReferences(text, servers)).toContain("](mcp://github ");
  });

  test.each([
    "foo@github",
    "@@github",
    "@github.com",
    "@github/x",
    "@github:res",
    "@gith",
    "@githubs",
    "@github_x",
    "@github-x",
    "@Github",
    "@GITHUB",
    "\\@github",
    "`@github`",
    "```\n@github\n```",
    "[@github](https://example.com)",
    "[see](mcp://github)",
    "<https://example.com/@github>",
    "<div>\n@github\n</div>",
    "+@github",
    "@./github",
    "@dev.radius",
  ])("leaves %j literal", (text) => {
    expect(transformMcpServerReferences(text, servers)).toBe(text);
  });

  test("is idempotent: its own links are not prose", () => {
    const once = transformMcpServerReferences("Use @github and @dev_radius.", servers);
    expect(transformMcpServerReferences(once, servers)).toBe(once);
  });

  test("keeps the longest name when one server name starts another", () => {
    expect(transformMcpServerReferences("@github @git", servers)).toBe(
      `${link("@github", "github", "mcp__github")} ${link("@git", "git", "mcp__git")}`,
    );
  });

  test("converts inside lists, quotes, headings, and emphasis", () => {
    const text = "- @github\n> @git\n# About @github\n*@git* and **@github**";
    const converted = transformMcpServerReferences(text, servers);
    expect(converted.match(/mcp:\/\//g)).toHaveLength(5);
    expect(converted.startsWith(`- ${link("@github", "github", "mcp__github")}\n`)).toBe(true);
  });

  test("returns the text unchanged for an empty catalogue", () => {
    expect(transformMcpServerReferences("@github", [])).toBe("@github");
  });
});
