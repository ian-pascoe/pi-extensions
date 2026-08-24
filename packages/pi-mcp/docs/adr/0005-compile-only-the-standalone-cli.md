# Compile only the standalone CLI

The package publishes its standalone `pi-mcp` executable and CLI dependency graph as JavaScript under `dist`, while Pi continues loading the extension from `src/index.ts`. Node does not execute TypeScript within installed packages without an additional runtime loader, so this narrow exception to the repository's source-only package convention avoids both a runtime dependency and a second handwritten JavaScript implementation.
