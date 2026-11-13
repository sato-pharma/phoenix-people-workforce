import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Honour the _ prefix convention for intentionally-unused identifiers.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    settings: {
      react: {
        version: "19.2.4",
      },
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "**/.next/**",
    ".claude/**",
    "scripts/export-supabase-to-xlsx.js",
    "out/**",
    "build/**",
    "**/build/**",
    "next-env.d.ts",
    // Local-only working directories that are not part of the project source.
    // `.codex-worktrees` and `_wt-*` hold full checkouts of other branches and must
    // never be linted by this project's CI (they produce thousands of unrelated findings).
    ".codex-worktrees/**",
    "_wt-*/**",
    // The native Android app. Linted by its own `expo lint` config inside mobile/, not by the
    // Next.js rule set — eslint-config-next's React and import rules assume a DOM and a Next
    // router, neither of which exists in React Native, so every screen would report findings
    // for code that is correct. Same rationale as the worktree ignores above.
    "mobile/**",
    ".playwright-cli/**",
    ".alt-git-objects/**",
    ".vercel/**",
    // Generated output files — not part of the app source.
    "coverage/**",
    "output/**",
    "outputs/**",
    "templates/**",
    // Vendored pdf.js browser build + worker, served as static assets for the recruitment CV
    // viewer (see scripts/sync-pdfjs-assets.mjs). Minified third-party code — linting it produces
    // thousands of irrelevant findings, same rationale as build/** above.
    "public/pdfjs/**",
    // Gitignored local snapshot/export directory (e.g. audit-tool code dumps). Not part of the
    // project source — same rationale as the worktree ignores above.
    "artifacts/**",
    // Deno code for Supabase Edge Functions, not part of the Next.js app (supabase/functions/README.md).
    "supabase/functions/**",
  ]),
]);

export default eslintConfig;
