#!/usr/bin/env node
// Should this pull request run `next build`? — the PR half of ci.yml's Build step.
//
// `main` always builds (the deploy gate). A pull request used to never build (#4802), so a build
// break first appeared on `main`, after the merge, and withheld the deploy. This decides, per PR,
// whether the build runs too.
//
// NARROWED 2026-10-08 (owner: "narrow the PR build to routes and config"). The first version, the
// same morning, built unless every path was build-inert — measured on the last 120 merged PRs that
// built 52.5% of them, ~3.5 min of wall each. It is now defined by INCLUSION: a PR builds only when
// it touches a ROUTE or a BUILD CONFIG file (BUILD_PATHS below). The accepted cost, his call: a
// break that lives only in a library or component file (`src/**`) — a misplaced "use client", an
// import the bundler rejects — is caught by `main`'s build after the merge, as before 2026-10-08,
// or earlier by `remote-check all` when wanted.
//
// What stays fail-safe: an empty list, an unreadable list, a path it cannot classify, or ANY error
// → build. A rename is read with --no-renames, so its OLD and NEW paths are both classified, and a
// deletion lists the deleted path — deleting or moving a route builds. A wrong answer can only fall
// back to what PRs did before this script (no build), never past it: the required checks
// (`validate`, `checks`) are unchanged and `main` still builds every commit.
//
// Usage (ci.yml): git diff --name-only --no-renames HEAD^1 HEAD | node scripts/ci-build-risk.mjs
// Prints `build=true|false` (append it to $GITHUB_OUTPUT) and one reason line on stderr.
// Pinned by tests/ci-build-risk.test.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Next's special files inside app/: a route's own files, its boundaries and its metadata routes.
const APP_SPECIAL_FILE =
  /^app\/(?:.*\/)?(?:page|layout|route|template|default|loading|error|global-error|not-found|forbidden|unauthorized|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(?:tsx|ts|jsx|js|mdx)$/;

/**
 * Paths that make a pull request build. Each entry is a test over a repo-relative POSIX path.
 */
export const BUILD_PATHS = [
  { name: "app/** route and segment file", test: (p) => APP_SPECIAL_FILE.test(p) },
  { name: "app/** stylesheet", test: (p) => p.startsWith("app/") && /\.css$/i.test(p) },
  { name: "next.config", test: (p) => /^next\.config\.[cm]?[jt]s$/.test(p) },
  { name: "proxy / middleware / instrumentation", test: (p) => /^(?:proxy|middleware|instrumentation(?:-client)?)\.[jt]s$/.test(p) },
  { name: "dependency manifest", test: (p) => ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"].includes(p) },
  { name: "tsconfig", test: (p) => /^tsconfig[^/]*\.json$/.test(p) },
  { name: "postcss / tailwind config", test: (p) => /^(?:postcss|tailwind)\.config\.[cm]?[jt]s$/.test(p) },
  { name: "Dockerfile", test: (p) => p === "Dockerfile" },
  // The Build step and its environment live in ci.yml.
  { name: "ci.yml", test: (p) => p === ".github/workflows/ci.yml" },
];

const PATH_RE = /^[^\0]+$/;

/**
 * The decision for one changed-path list. Pure; never throws.
 * @param {unknown} paths repo-relative paths, one per entry
 * @returns {{ build: boolean, reason: string }}
 */
export function classifyBuildRisk(paths) {
  try {
    if (!Array.isArray(paths)) return { build: true, reason: "no path list — building" };
    const list = paths.map((p) => String(p).trim().replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean);
    if (list.length === 0) return { build: true, reason: "the diff is empty or unreadable — building" };
    for (const path of list) {
      if (!PATH_RE.test(path) || path.startsWith("/") || path.split("/").includes("..")) {
        return { build: true, reason: `cannot classify ${JSON.stringify(path)} — building` };
      }
    }
    for (const path of list) {
      const rule = BUILD_PATHS.find((r) => r.test(path));
      if (rule) return { build: true, reason: `${path} is a ${rule.name} change` };
    }
    return { build: false, reason: `none of the ${list.length} changed path(s) is a route or build config` };
  } catch (error) {
    return { build: true, reason: `classifier error (${error?.message ?? error}) — building` };
  }
}

function main() {
  let text = "";
  try {
    text = readFileSync(0, "utf8");
  } catch {
    text = "";
  }
  const verdict = classifyBuildRisk(text.split(/\r?\n/));
  process.stdout.write(`build=${verdict.build ? "true" : "false"}\n`);
  process.stderr.write(`build risk: ${verdict.reason}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    process.stdout.write("build=true\n");
  }
}
