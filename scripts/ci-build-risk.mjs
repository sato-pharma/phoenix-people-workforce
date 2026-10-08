#!/usr/bin/env node
// Should this pull request run `next build`? — the PR half of ci.yml's Build step.
//
// `main` always builds (the deploy gate). A pull request used to never build (#4802), so a build
// break first appeared on `main`, after the merge, and withheld the deploy. This decides, per PR,
// whether the build runs too.
//
// It is defined by EXCLUSION, not inclusion, so it can only fail toward building:
//   * a PR builds UNLESS every changed path is in SAFE_PATHS below;
//   * an empty list, an unreadable list, a path it cannot classify, or ANY error → build;
//   * a rename is read with --no-renames, so its OLD and NEW paths are both classified, and a
//     deletion lists the deleted path — so deleting a route or moving a component builds.
// A wrong answer can only fall back to what PRs did before this script (no build), never past it:
// the required checks (`validate`, `checks`) are unchanged and `main` still builds every commit.
//
// Usage (ci.yml): git diff --name-only --no-renames HEAD^1 HEAD | node scripts/ci-build-risk.mjs
// Prints `build=true|false` (append it to $GITHUB_OUTPUT) and one reason line on stderr.
// Pinned by tests/ci-build-risk.test.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Paths a Next build never reads. Each entry is a test over a repo-relative POSIX path.
 * `scripts/**` is safe only because nothing under app/, src/ or a root config imports a script —
 * tests/ci-build-risk.test.ts re-proves that on every run, so a future import turns the test red.
 */
export const SAFE_PATHS = [
  { name: "docs/**", test: (p) => p.startsWith("docs/") },
  { name: "**/*.md", test: (p) => /\.md$/i.test(p) },
  { name: "tests/**", test: (p) => p.startsWith("tests/") },
  { name: ".claude/**", test: (p) => p.startsWith(".claude/") },
  // Every workflow but ci.yml itself: the Build step and its environment live in ci.yml.
  { name: ".github/** (not ci.yml)", test: (p) => p.startsWith(".github/") && p !== ".github/workflows/ci.yml" },
  { name: "mobile/**", test: (p) => p.startsWith("mobile/") },
  { name: "supabase/migrations/**", test: (p) => p.startsWith("supabase/migrations/") },
  { name: "xlsx/**", test: (p) => p.startsWith("xlsx/") },
  { name: "scripts/**", test: (p) => p.startsWith("scripts/") },
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
      const safe = SAFE_PATHS.some((rule) => rule.test(path));
      if (!safe) return { build: true, reason: `${path} can change the build` };
    }
    return { build: false, reason: `all ${list.length} changed path(s) are outside the build` };
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
