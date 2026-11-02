import type { ConfiguredHosts, IssueHost } from "../src/issue-host.js";

/** What `adapter`'s CLI is configured for: each host its own web host. */
export const configuredFor = (adapter: IssueHost, ...hosts: string[]): ConfiguredHosts =>
  new Map([[adapter, new Map(hosts.map((host) => [host, host]))]]);
