import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { HostCli, IssueListing, IssueSummary } from "./issue-host.js";
import type { RunCommand } from "./issue-repository.js";

// What the adapters share. It lives apart from `issue-host.ts`, which imports the adapters.

/**
 * Reads an adapter's configured hosts, yielding none when `read` throws: configuration that
 * cannot be read configures nothing.
 */
export async function readConfiguredHostsSafely(
  read: () => Promise<ReadonlyMap<string, string>>,
): Promise<ReadonlyMap<string, string>> {
  try {
    return await read();
  } catch {
    return new Map();
  }
}

/** How an adapter lists recent items through its CLI: the call, and what it makes of the answer. */
export interface RecentListingRequest<Item extends TSchema> {
  cli: HostCli;
  args: string[];
  run: RunCommand;
  signal: AbortSignal;
  /** Whether a failed call means the CLI is missing or signed out, which the user can fix. */
  needsCli: (result: Awaited<ReturnType<RunCommand>>) => boolean;
  /** The parts of an item of the CLI's JSON array that `summarize` reads; other items are skipped. */
  schema: Item;
  summarize: (item: Static<Item>) => IssueSummary;
}

/**
 * Runs the CLI and reads its JSON array of items. A killed call, a failure that does not need the
 * CLI, and anything but a JSON array are `unavailable`; items that do not match `schema` are
 * dropped.
 */
export async function listRecentThroughCli<Item extends TSchema>(
  request: RecentListingRequest<Item>,
): Promise<IssueListing> {
  const { cli, args, run, signal, needsCli, schema, summarize } = request;
  try {
    const result = await run(cli.command, args, { signal, timeout: 20_000 });
    if (result.killed) return { ok: false, reason: "unavailable" };
    if (result.code !== 0) {
      return { ok: false, reason: needsCli(result) ? "needs-cli" : "unavailable" };
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return { ok: false, reason: "unavailable" };
    const issues: IssueSummary[] = [];
    for (const item of parsed) if (Value.Check(schema, item)) issues.push(summarize(item));
    return { ok: true, issues };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
