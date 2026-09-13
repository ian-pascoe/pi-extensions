/**
 * Resolve known npm/pnpm Deno entrypoints to already-installed native payloads.
 * Missing candidates/closures return undefined; unrelated opaque commands are unchanged.
 * Callers retain discovery order and decide whether to acquire a private fallback.
 */
export declare function resolveDenoExecutable(candidate: string): Promise<string | undefined>;
