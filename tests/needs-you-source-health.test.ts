import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Driven, not restated: these are the real exports the fan-out uses.
import { ACTION_SOURCE_LABELS, isForbiddenSourceError } from "../src/lib/action-center/service.ts";

/**
 * A pending source must be able to say "I could not answer" — in every queue the needs-you board
 * reads.
 *
 * WHY THIS EXISTS. Three live defects, all the same shape, all found on 2026-09-28 while composing
 * `src/lib/needs-you/`:
 *
 *   1. `getAwaitingMyActionItems` wrapped each of its seven reads in `.catch(() => null)` INSIDE a
 *      `Promise.allSettled`. That made the `allSettled` decorative — every result was
 *      `"fulfilled"`, every failure arrived as a `null` the item loops skipped — and the file
 *      contained no logging of any kind, so a dead resignations read produced a shorter list and
 *      total silence, in the very function `/api/approvals/badge-counts` counts.
 *   2. `getVacationAwaitingBadge` and `getExcuseAwaitingBadge` returned `{count: 0, overdue: false}`
 *      on failure, with no field able to say the read had failed at all. Only
 *      `getPlanAwaitingBadge`, in the same file, carried `available`.
 *
 * A badge can survive that — a rail that goes quiet for one poll is cosmetic. The needs-you board
 * cannot: its whole purpose is that the owner STOPS checking for himself, so a swallowed failure
 * rendering as zero says "nothing needs you" after the looking has already been delegated. That is
 * the one failure direction the module exists to prevent, and it starts here, in the sources.
 *
 * Every assertion below defends that one direction. Over-reporting is untested on purpose.
 *
 * Node builtins only, and the source-scanned halves are scanned rather than driven for a specific
 * reason: calling them needs Supabase, and this suite runs with PRODUCTION credentials
 * (`--env-file-if-exists=.env.local`). A test that reached the real database to prove an error path
 * would be reading live payroll data to check a `catch` block.
 */
export function runNeedsYouSourceHealthTests() {
  const ACTION_CENTER = "src/lib/action-center/service.ts";
  const APPROVALS_HUB = "src/lib/approvals-hub/service.ts";
  const actionSource = readFileSync(ACTION_CENTER, "utf8");
  const hubSource = readFileSync(APPROVALS_HUB, "utf8");

  // ── 1. The swallow must not come back ───────────────────────────────────────
  // Scoped to getAwaitingMyActionItemsWithHealth's own body, NOT the whole file, and the narrowing
  // is deliberate rather than convenient. `getMyRequestItems` (same file, ~line 199) still carries
  // six `.catch(() => null)` wrappers in the same shape — but it answers a different question ("show
  // me my own submissions"), it is not a queue this board reads, and it has no consumer for a health
  // list. Widening this assertion to the file would force a `WithHealth` variant nobody renders,
  // which is how `src/lib/overview/service.ts getOverviewDashboard` became dead code. Tracked
  // separately; asserted here only where the board depends on it.
  const fanOutStart = actionSource.indexOf("export async function getAwaitingMyActionItemsWithHealth");
  assert.ok(fanOutStart > 0, `getAwaitingMyActionItemsWithHealth not found in ${ACTION_CENTER}`);
  const fanOutBody = actionSource.slice(fanOutStart, actionSource.indexOf("\n}\n", fanOutStart));

  assert.doesNotMatch(
    fanOutBody,
    /\.catch\(\(\)\s*=>\s*null\)/,
    "getAwaitingMyActionItemsWithHealth contains `.catch(() => null)`. Inside a Promise.allSettled " +
      "that makes the allSettled decorative: every result settles \"fulfilled\", the failure arrives " +
      "as a null the item loops skip, and a queue nobody could read becomes indistinguishable from a " +
      "queue with nothing in it. Let the rejection reach allSettled and name it in `unavailable`.",
  );

  // The fan-out and its labels are joined by INDEX, so a seventh source with six labels reports as
  // the generic "An approval queue" — the quiet half of the same failure.
  const settledBlock = fanOutBody.slice(
    fanOutBody.indexOf("const settled = await Promise.allSettled(["),
    fanOutBody.indexOf("]);", fanOutBody.indexOf("const settled = await Promise.allSettled([")),
  );
  const sourceCount = settledBlock.split("\n").filter((line) => /^\s{4}[a-zA-Z(]/.test(line)).length;
  assert.equal(
    ACTION_SOURCE_LABELS.length,
    sourceCount,
    `${ACTION_SOURCE_LABELS.length} labels for ${sourceCount} sources in the awaiting-action fan-out. ` +
      "They are joined by index, so the mismatch does not throw — it silently reports a real source " +
      "under the wrong name, or under the generic fallback.",
  );

  for (const label of ACTION_SOURCE_LABELS) {
    assert.doesNotMatch(
      label,
      /^[A-Z]{1,3}-\d|_/,
      `Source label "${label}" reads like a code. Owner rule: human-readable names, never raw codes ` +
        "or IDs, in both the UI and chat — and these labels are printed verbatim on the board.",
    );
  }

  // ── 2. Forbidden is a TRUE zero, not a failure ──────────────────────────────
  // Collapsing the two is what would turn "you hold no rung on resignations" into nine permanent
  // amber warnings, which trains him to ignore amber — the same failure one step removed.
  assert.equal(isForbiddenSourceError(new Error("Forbidden: no rung on this queue")), true);
  assert.equal(isForbiddenSourceError(new Error("forbidden: lower case is the same refusal")), true);
  assert.equal(
    isForbiddenSourceError(new Error("fetch failed")),
    false,
    "a network failure must never be classified as a permission refusal — that is precisely how a " +
      "dead queue comes to read as an empty one",
  );
  assert.equal(isForbiddenSourceError(new Error("Request timed out")), false);
  assert.equal(isForbiddenSourceError("Forbidden: a bare string is not an Error"), false);
  assert.equal(isForbiddenSourceError(null), false);
  assert.equal(isForbiddenSourceError(undefined), false);

  // ── 3. Both badges can express "I could not read this" ──────────────────────
  // Asserted on BOTH paths: a function that returns `available: true` on success and omits it in
  // the catch still leaves the caller unable to tell a real zero from a dead query.
  for (const badge of ["getVacationAwaitingBadge", "getExcuseAwaitingBadge", "getPlanAwaitingBadge"]) {
    const start = hubSource.indexOf(`export async function ${badge}`);
    assert.ok(start > 0, `${badge} not found in ${APPROVALS_HUB}`);
    const body = hubSource.slice(start, hubSource.indexOf("\n}\n", start));

    // The plan badge says `available: unavailable.length === 0`: its read succeeds but can come back
    // with a source missing (PlanApprovalsBuckets.unavailable), and that short count is not available.
    assert.match(
      body,
      /available:\s*(?:true|unavailable\.length === 0)/,
      `${badge} never returns \`available: true\`, so its caller cannot tell a successful read from a ` +
        "swallowed failure.",
    );
    assert.match(
      body,
      /available:\s*false/,
      `${badge} returns a count on its failure path without \`available: false\`. A \`0\` that might ` +
        "mean \"the query died\" is the under-report the needs-you board exists to prevent — it renders " +
        "as \"nothing is waiting\" on the one screen he trusts instead of looking for himself.",
    );

    // The failure path must not claim a number it did not count.
    const catchBlock = body.slice(body.indexOf("} catch"));
    assert.doesNotMatch(
      catchBlock,
      /count:\s*[1-9]/,
      `${badge}'s catch block returns a non-zero count. A fabricated number is worse than either a ` +
        "zero or an unknown.",
    );
  }
}
