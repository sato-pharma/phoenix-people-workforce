import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * 🔴 THE PROBATION LIST IS READ ONCE PER REQUEST.
 *
 * The admin home asks for `getProbationRows` twice in the same instant, under one
 * `getCeoCommandCenterData`: the lifecycle-risk tiles (`getPlatformMetrics` →
 * `getLifecycleRiskMetrics`) and the Needs You probation row (the `probation-decisions` adapter).
 * Each copy is the full directory join plus both probation reads. On a loaded minute the two
 * copies queued behind each other past the board's eight-second budget and the probation row went
 * amber (26 Oct 2026, 00:32 Cairo, two timeouts 34 ms apart, while every query behind them stayed
 * under 132 ms). React's `cache()` makes the second caller share the first one's promise.
 *
 * WHAT EACH ASSERTION CATCHES, in the words of the change that would break it:
 *
 *  1. `getProbationRows` written back as a plain `export async function` — the second read returns.
 *  2. The wrapper pointed at something other than the real loader, or `cache` imported from
 *     somewhere other than React (a module-level memo would hand one viewer's list to the next).
 *  3. Both callers still being there — if one moves, this file's reason has changed and should be
 *     re-read, not deleted.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => stripComments(readFileSync(path.join(repoRoot, relative), "utf8"));

const SERVICE = "src/lib/probation/service.ts";

export function runProbationRowsOneReadPerRequestTests() {
  const service = read(SERVICE);

  // 1 — no un-memoised export.
  assert.doesNotMatch(
    service,
    /export\s+async\s+function\s+getProbationRows\b/,
    `${SERVICE} exports getProbationRows as a plain function again. The admin home calls it twice in ` +
      "one request (lifecycle-risk tiles and the Needs You probation row) — wrap it in React's cache().",
  );

  // 2 — memoised per request, on the real loader, with React's cache.
  assert.match(
    service,
    /export\s+const\s+getProbationRows\s*=\s*cache\(\s*loadProbationRows\s*\)/,
    `${SERVICE} must export getProbationRows = cache(loadProbationRows).`,
  );
  assert.match(
    service,
    /import\s*\{\s*cache\s*\}\s*from\s*"react"/,
    `${SERVICE} must take cache from "react" — it is per request; any other memo outlives the viewer.`,
  );
  assert.match(
    service,
    /async\s+function\s+loadProbationRows\(\s*access:\s*AccessContext\s*\)/,
    `${SERVICE} no longer defines loadProbationRows(access).`,
  );

  // 3 — the two same-request callers this exists for.
  assert.match(
    read("src/lib/platform/metrics.ts"),
    /getProbationRows\(accessContext\)/,
    "the lifecycle-risk tiles no longer read getProbationRows — re-read this test's reason",
  );
  assert.match(
    read("src/lib/needs-you/sources.ts"),
    /const probationDecisions: NeedsYouAdapter[\s\S]*?getProbationRows\(access\)/,
    "the probation-decisions adapter no longer reads getProbationRows — re-read this test's reason",
  );
}
