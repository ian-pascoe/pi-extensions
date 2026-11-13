// vp migrate: merged .oxlintrc.json (8c08590b256a6fb2454e3a7d777bcf30).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// oxlint's type-aware backend: tsrs's tsrs-lint, not the oxlint-tsgolint vite-plus bundles. Set here
// rather than in the shell, so every Vite+ lint gets it and an inherited value is replaced. See ADR 0012.
process.env.OXLINT_TSGOLINT_PATH = fileURLToPath(
  new URL(
    `node_modules/.bin/tsrs-lint${process.platform === "win32" ? ".cmd" : ""}`,
    import.meta.url,
  ),
);

// Agent and editor directories, and the vendored anti-slop plugin, are neither formatted nor linted.
const ignorePatterns = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  "tools/oxlint/anti-slop/**",
];

export default defineConfig({
  run: {
    tasks: {
      check: {
        command: "vp check",
      },
    },
  },
  // The pre-commit hook (.vite-hooks/pre-commit) checks staged files without fixing them.
  staged: {
    "*": "vp check --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns,
  },
  lint: {
    ignorePatterns,
    plugins: ["typescript", "unicorn", "oxc"],
    jsPlugins: [
      {
        name: "anti-slop",
        specifier: "./tools/oxlint/anti-slop/index.ts",
      },
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    options: {
      typeAware: true,
      typeCheck: false,
    },
    categories: {
      correctness: "error",
    },
    rules: {
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    env: {
      builtin: true,
    },
  },
});
