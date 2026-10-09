import type {
  PostEditDiagnosticOutcome,
  PostEditLspDiagnostic,
} from "./lsp-post-edit-diagnostics.js";

/** The text of each file a finding lies in, by absolute path, read after the pull that found it. */
export type FileTexts = ReadonlyMap<string, string>;

/** The trimmed text of a one-based line, or an empty string when the file or line is unknown. */
function trimmedLineText(texts: FileTexts, path: string, line: number): string {
  return (
    texts
      .get(path)
      ?.split(/\r\n|\r|\n/u)
      [line - 1]?.trim() ?? ""
  );
}

/**
 * Identity of one finding: server, severity, code, message, and the trimmed text of the line it
 * starts on. It names no position, so it survives edits that shift the line, such as a sibling
 * edit in the same parallel tool batch adding a line above it.
 */
export function findingKey(diagnostic: PostEditLspDiagnostic, texts: FileTexts): string {
  const { serverId, severity, code, message, path, line } = diagnostic;
  return [serverId, severity, code ?? "", message, trimmedLineText(texts, path, line)].join(
    "\u0000",
  );
}

/**
 * The LSP Diagnostics a changed file had before a native `edit` or `write`, so Post-edit
 * Diagnostics report only what the edit introduced. Only Server Instances that answered the
 * pre-edit pull have an entry; a server without one has no baseline.
 */
export interface PreEditBaseline {
  /** Absolute path of the changed file. */
  readonly path: string;
  /** How many findings of each identity each answering Server Instance reported, by server ID. */
  readonly servers: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** Record a changed file's pre-edit pull, keyed against its text before the edit. */
export function preEditBaselineOf(
  path: string,
  outcomes: readonly PostEditDiagnosticOutcome[],
  text: string,
): PreEditBaseline {
  const texts = new Map([[path, text]]);
  const servers = new Map<string, Map<string, number>>();
  for (const outcome of outcomes) {
    if (outcome.kind === "no_diagnostics" && outcome.path === path) {
      if (outcome.serverId !== undefined && !servers.has(outcome.serverId)) {
        servers.set(outcome.serverId, new Map());
      }
    } else if (outcome.kind === "diagnostic" && outcome.diagnostic.path === path) {
      const counts = servers.get(outcome.diagnostic.serverId) ?? new Map<string, number>();
      const key = findingKey(outcome.diagnostic, texts);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      servers.set(outcome.diagnostic.serverId, counts);
    }
  }
  return { path, servers };
}

/**
 * Compare fresh outcomes with a changed file's Pre-edit Baseline as multisets: each finding the
 * baseline still has an unmatched copy of becomes an `unchanged` count, and the rest stay listed.
 * A server with no baseline keeps all its findings listed and gets one `no_baseline` note.
 * Outcomes for other files pass through.
 */
export function compareWithPreEditBaseline(
  baseline: PreEditBaseline,
  outcomes: readonly PostEditDiagnosticOutcome[],
  texts: FileTexts,
): PostEditDiagnosticOutcome[] {
  const remaining = new Map(
    [...baseline.servers].map(([serverId, counts]) => [serverId, new Map(counts)]),
  );
  const unbaselined = new Set<string>();
  const compared: PostEditDiagnosticOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== "diagnostic" || outcome.diagnostic.path !== baseline.path) {
      compared.push(outcome);
      continue;
    }
    const { diagnostic } = outcome;
    const counts = remaining.get(diagnostic.serverId);
    if (counts === undefined) {
      unbaselined.add(diagnostic.serverId);
      compared.push(outcome);
      continue;
    }
    const key = findingKey(diagnostic, texts);
    const left = counts.get(key) ?? 0;
    if (left === 0) {
      compared.push(outcome);
      continue;
    }
    counts.set(key, left - 1);
    compared.push({
      kind: "unchanged",
      path: diagnostic.path,
      severity: diagnostic.severity,
      count: 1,
    });
  }
  for (const serverId of unbaselined) {
    compared.push({ kind: "no_baseline", path: baseline.path, serverId });
  }
  return compared;
}
