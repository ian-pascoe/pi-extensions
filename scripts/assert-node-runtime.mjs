/**
 * Fails when a script or test runner runs under Bun instead of Node.
 *
 * Bun installs dependencies and starts package scripts, but Node is the tool runtime: it runs
 * Vitest, these scripts, Changesets, and Pi. `bun run <script>` starts the `node` on PATH for
 * `node ...` scripts and for tool shebangs; `bun --bun run ...` and a missing `node` put the tool
 * under Bun's runtime, whose Node compatibility layer the repository does not test against.
 *
 * @param {NodeJS.ProcessVersions | { bun?: string }} versions
 * @returns {void}
 */
export function assertNodeRuntime(versions = process.versions) {
  if (versions.bun === undefined) return;
  throw new Error(
    `This tool must run under Node, but it is running under Bun ${versions.bun}. Put Node 22.19 on PATH (\`mise install\`) and run it through \`bun run <script>\` without \`--bun\`.`,
  );
}
