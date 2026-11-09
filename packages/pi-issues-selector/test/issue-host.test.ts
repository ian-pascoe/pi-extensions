import { describe, expect, test } from "vitest";
import { configuredFor } from "./configured-hosts.js";
import { GITHUB } from "../src/github-host.js";
import { GITLAB } from "../src/gitlab-host.js";
import { findIssueHost } from "../src/issue-host.js";

describe("findIssueHost", () => {
  const configuredOf =
    (...hosts: string[]) =>
    async () =>
      configuredFor(GITHUB, ...hosts);
  const never = async () => {
    throw new Error("the configured hosts must not be read");
  };

  test.each([
    ["GitHub.com", "github.com"],
    ["ssh.github.com", "github.com"],
    ["octo.ghe.com", "octo.ghe.com"],
  ])("%s is served as %s without reading the configured hosts", async (host, canonical) => {
    expect(await findIssueHost(host, never)).toEqual({
      adapter: GITHUB,
      host: canonical,
    });
  });

  test.each(["ghe.com", "github.com.evil.example", "xghe.com"])(
    "%j is not served",
    async (host) => {
      expect(await findIssueHost(host, configuredOf("github.corp.example"))).toBeUndefined();
    },
  );

  test("a configured host is served by the adapter that lists it", async () => {
    expect(await findIssueHost("github.corp.example", configuredOf("github.corp.example"))).toEqual(
      {
        adapter: GITHUB,
        host: "github.corp.example",
      },
    );
  });

  test("gitlab.com is built in, served by the GitLab adapter without reading the configured hosts", async () => {
    expect(await findIssueHost("gitlab.com", never)).toEqual({
      adapter: GITLAB,
      host: "gitlab.com",
    });
    expect(await findIssueHost("GitLab.com", never)).toEqual({
      adapter: GITLAB,
      host: "gitlab.com",
    });
  });

  test("a self-managed host is served by GitLab when glab lists it, and an SSH host as its web host", async () => {
    const glab = async () =>
      new Map([
        [
          GITLAB,
          new Map([
            ["gitlab.corp.example", "gitlab.corp.example"],
            ["ssh.corp.example", "gitlab.corp.example"],
          ]),
        ],
        [GITHUB, new Map([["github.corp.example", "github.corp.example"]])],
      ]);
    expect(await findIssueHost("gitlab.corp.example", glab)).toEqual({
      adapter: GITLAB,
      host: "gitlab.corp.example",
    });
    expect(await findIssueHost("SSH.corp.example", glab)).toEqual({
      adapter: GITLAB,
      host: "gitlab.corp.example",
    });
    expect(await findIssueHost("github.corp.example", glab)).toEqual({
      adapter: GITHUB,
      host: "github.corp.example",
    });
  });

  test("a host both gh and glab are configured for is not served", async () => {
    const both = async () =>
      new Map([
        ...configuredFor(GITHUB, "shared.example"),
        ...configuredFor(GITLAB, "shared.example"),
      ]);
    expect(await findIssueHost("shared.example", both)).toBeUndefined();
  });
});
