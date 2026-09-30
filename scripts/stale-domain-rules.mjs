// The stale-platform rules, kept in their own module so that the gate and its test can import
// them: check-no-stale-domains.mjs walks the tree and calls process.exit at IMPORT time, so a test
// can never import the gate itself. Extracted 2026-09-30, the same way secret-shape-rules.mjs was
// extracted from validate-railway-production-secrets.mjs, and for the identical reason.
//
// WHAT THIS GATE IS FOR. Two platforms are dead: Vercel, and then Google Cloud Run (AGENTS.md §3 —
// "GCP and Vercel are DEAD", billing closed, every GCP API answers BILLING_DISABLED). Shipped
// source must not name either one, because a hostname the company no longer controls is not merely
// untidy — it is a trust decision pointing at a name someone else can claim.
//
// 🔴 WHY THE CLOUD RUN PATTERN WAS ADDED. Until 2026-09-30 this gate knew only the four Vercel
// patterns, so it read next.config.ts on every `validate` run and PASSED it while that file's
// `experimental.serverActions.allowedOrigins` still trusted two deleted Cloud Run hosts. Next
// matches a Server Action's Origin/Host against that list, so for weeks a live payroll app would
// have accepted a mutation arriving on a hostname belonging to whoever claimed the project number
// next. The gate was in the required job the whole time; it simply had no pattern for the platform
// that had actually been retired.
//
// The scanned surface is "the code that ships plus the code that configures the runtime":
//   src/, app/, lib/ (the top-level one-file helper), next.config.ts, proxy.ts, instrumentation.ts.
//
// 🔴 scripts/ IS DELIBERATELY NOT SCANNED, and adding it will red the required `validate` job.
// Measured 2026-09-30 — four files there legitimately contain the exact strings this gate hunts,
// because rejecting and retiring a dead platform is what that tooling is FOR:
//   scripts/validate-env.mjs:33,34                      rejects a vercel.app / Cloud Run value
//   scripts/validate-railway-production-secrets.mjs:127  rejects a vercel.app host
//   scripts/audit-page-transitions.mjs:118,119           recognises the old Vercel preview host
//   scripts/check-no-stale-domains.mjs + this module     define the patterns themselves
// A rejection pattern is the OPPOSITE of a stale reference, and scripts/ does not ship in the
// runtime image. Marking eight lines across four files to scan a directory that cannot regress a
// production trust decision buys nothing.
//
// 🔴 NO `process.env.K_REVISION` / `process.env.GCP_PROJECT_ID` PATTERN EITHER, and that is a
// decision rather than an oversight. Both are still read on purpose in shipped source:
// src/lib/observability/deploy-identity.ts reads K_REVISION as the LAST fallback behind
// RAILWAY_GIT_COMMIT_SHA (harmless, and documented there), src/lib/error-monitor/derived-status.ts
// reads it for the same identity, and src/lib/observability/gcp-metrics.ts reads GCP_PROJECT_ID and
// is being kept on purpose (it is a separate module with its own test, and is not what pulled gRPC
// into the graph). A pattern for those would fail `validate` on five files nobody has decided to
// change. Revisit only once those reads are actually removed.

import { basename } from "node:path";

/** Directories walked recursively, relative to the repo root. */
export const ROOTS = ["src", "app", "lib"];

/**
 * Single files scanned in addition to ROOTS. `instrumentation.ts` is a real runtime file — Next
 * loads it on every server boot and it is where error ingestion registers — and it was unscanned
 * until 2026-09-30 simply because it lives at the root rather than under src/.
 */
export const EXTRA_FILES = ["next.config.ts", "proxy.ts", "instrumentation.ts"];

export const EXTS = new Set([".ts", ".tsx", ".mjs", ".js", ".jsx"]);

/**
 * Per-line opt-out markers. Each is scoped to the patterns it may excuse, so a marker cannot
 * silence an unrelated finding on the same line — the single catch-all regex this replaced would
 * have let a `vercel-fallback` comment excuse a Cloud Run host sitting beside it.
 */
export const ALLOW_MARKERS = {
  /**
   * The tolerated `process.env.VERCEL_ENV` read inside the platform-neutral `isProductionRuntime()`
   * detector in src/config/system-settings.ts — a fallback behind APP_ENV/NODE_ENV, not a
   * dependency. (Unused as of 2026-09-30: `VERCEL_ENV` does not match the `VERCEL\b` pattern, so
   * that line passes on its own. Kept because the failure message advertises it.)
   */
  vercel: "platform-neutral-vercel-fallback",
  /**
   * A GCP / Cloud Run reference that must stay in shipped source — a migration note that has to
   * name the host, say. Use it only when the reference genuinely cannot be reworded: the prose in
   * next.config.ts and src/lib/synthetic-journeys/service.ts explaining these removals deliberately
   * does NOT spell the hostname out, precisely so no marker is needed there.
   */
  gcp: "deliberate-cloud-run-reference",
};

/**
 * [regex, human message, which ALLOW_MARKERS key may excuse it].
 *
 * Every pattern is matched per line, so a finding can name a `file:line`.
 *
 * The `@type` is load-bearing, not decoration: without it TypeScript widens each row to
 * `(string | RegExp)[]`, so a consumer destructuring `[re]` gets `string | RegExp` and `re.test(...)`
 * does not compile. That is exactly how this module first reached CI — `tests/stale-domain-gate.test.ts`
 * failed the required `checks` job on TS2339 and TS2769, and it could not have been caught locally
 * because a local typecheck is refused here by design. Declaring the tuple fixes it for every reader.
 *
 * @type {ReadonlyArray<readonly [RegExp, string, keyof typeof ALLOW_MARKERS]>}
 */
export const FORBIDDEN = [
  [/vercel\.app/i, "stale Vercel domain (*.vercel.app)", "vercel"],
  [/process\.env\.VERCEL\b/, "Vercel-only runtime flag (process.env.VERCEL)", "vercel"],
  [/process\.env\.VERCEL_URL\b/, "Vercel-only runtime var (process.env.VERCEL_URL)", "vercel"],
  [/process\.env\.VERCEL_PROJECT_PRODUCTION_URL\b/, "Vercel-only runtime var", "vercel"],
  [
    // The dead Cloud Run platform. `\b` on both sides so `run.apply` and `forrun.appear` are not
    // hits, while `*.run.app`, `foo.run.app` and a bare `run.app` all are.
    /\brun\.app\b/i,
    "dead Cloud Run host (*.run.app) — GCP billing is closed and these hostnames are no longer ours",
    "gcp",
  ],
];

/**
 * Whether a path is a file this gate reads, keyed on the BASENAME's last dot.
 *
 * 🔴 The bug this fixes (live until 2026-09-30): the test was
 * `EXTS.has(full.slice(full.lastIndexOf(".")))` against the WHOLE path, so a dotted parent
 * directory displaced it entirely — `src/v1.2/route.ts` yields `.2/route.ts`, which is in no
 * extension set, and every file beneath such a directory was skipped SILENTLY. Latent only because
 * nothing under src/ or app/ carries a dot in a directory name today; it would have widened the
 * moment one did, and a gate that skips files while reporting a clean scan is worse than no gate.
 * A basename with no dot at all (`Makefile`) is correctly not scanned — the old `slice(-1)` on
 * `lastIndexOf` returning -1 handed back the final character instead.
 */
export function hasScannedExtension(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return EXTS.has(name.slice(dot));
}

/** Whether `line` carries the opt-out marker for the forbidden entry keyed `markerKey`. */
export function lineIsExcused(line, markerKey) {
  const marker = ALLOW_MARKERS[markerKey];
  return typeof marker === "string" && line.includes(marker);
}

/**
 * The findings in one file's text. Pure — takes the text rather than reading it — so a test can
 * drive it with a crafted line and watch the real pattern fire.
 *
 * Returns `{ file, line, message, text }` per finding, newest pattern last.
 */
export function findViolations(file, text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [re, message, markerKey] of FORBIDDEN) {
      if (!re.test(line)) continue;
      if (lineIsExcused(line, markerKey)) continue;
      out.push({ file, line: i + 1, message, text: line.trim().slice(0, 120) });
    }
  }
  return out;
}
