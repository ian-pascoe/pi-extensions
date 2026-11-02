import { describe, expect, test } from "vitest";
import { GITHUB } from "../src/github-host.js";
import { findIssueHost, type IssueHost } from "../src/issue-host.js";

describe("findIssueHost", () => {
  const configuredOf =
    (...hosts: string[]) =>
    async () =>
      new Map([[GITHUB, new Set(hosts)]]);
  const never = async () => {
    throw new Error("the configured hosts must not be read");
  };

  test.each([
    ["github.com", "github.com"],
    ["GitHub.com", "github.com"],
    ["ssh.github.com", "github.com"],
    ["octo.ghe.com", "octo.ghe.com"],
    ["a.b.ghe.com", "a.b.ghe.com"],
  ])("%s is served as %s without reading the configured hosts", async (host, canonical) => {
    expect(await findIssueHost(host, never)).toEqual({ adapter: GITHUB, host: canonical });
  });

  test.each(["gitlab.com", "ghe.com", "gh-work", "github.com.evil.example", "xghe.com", ""])(
    "%j is not served",
    async (host) => {
      expect(await findIssueHost(host, configuredOf("github.corp.example"))).toBeUndefined();
    },
  );

  test("a configured host is served by the adapter that lists it, compared case-insensitively", async () => {
    expect(await findIssueHost("github.corp.example", configuredOf("github.corp.example"))).toEqual(
      {
        adapter: GITHUB,
        host: "github.corp.example",
      },
    );
    expect(await findIssueHost("GitHub.Corp.Example", configuredOf("github.corp.example"))).toEqual(
      {
        adapter: GITHUB,
        host: "github.corp.example",
      },
    );
  });

  test("a host that more than one adapter claims is not served", async () => {
    const other: IssueHost = { ...GITHUB };
    const both = async () =>
      new Map([
        [GITHUB, new Set(["shared.example"])],
        [other, new Set(["shared.example"])],
      ]);
    expect(await findIssueHost("shared.example", both)).toBeUndefined();
  });
});
