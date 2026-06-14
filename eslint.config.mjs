import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
    // `.codex-worktrees` holds full checkouts of other branches and must never be
    // linted by this project's CI (it produces thousands of unrelated findings).
    ".codex-worktrees/**",
    ".vercel/**",
    // Generated output files — not part of the app source.
    "outputs/**",
    "templates/**",
  ]),
]);

export default eslintConfig;
