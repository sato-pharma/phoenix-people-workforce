import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A FAILED READ IS NEVER AN EMPTY LIST.
 *
 * AGENTS.md §1: a confident zero is worse than an error. The portal audit of 2026-09-29 found
 * NINE places where a `catch` emptied a collection and the screen then said, in so many words,
 * that the person has nothing — when what actually happened is that nobody could tell.
 *
 * The two that state something untrue about a real person:
 *
 *   • the support-request list on the portal dashboard — a failed fetch set `[]`, and the page
 *     rendered "No recent requests · Your support history will appear here after your first
 *     request" to a rep who may have twelve open tickets, with three KPI tiles reading 0;
 *   • expense-dashboard/page.tsx — one `catch { data = null }` feeding `if (!data ||
 *     data.empty.profile)`, so a thrown fetch is indistinguishable from an unlinked profile and
 *     the employee is told to contact HR about a linkage problem that does not exist.
 *
 * This file starts with the first, which My Workspace owns, and grows as each section PR clears
 * its own. The pattern to copy is `app/employee-portals/attendance/page.tsx`, which falls back to
 * zeros AND raises a banner, and `marketing-request-inbox.tsx`, which calls `setError(...)`.
 */

const DASHBOARD = "src/components/employee-portal/employee-portal-dashboard.tsx";

export function runPortalFailedReadStatesTests() {
  const source = stripComments(readFileSync(DASHBOARD, "utf8"));

  // ── The failure is recorded, on both paths out of the fetch ────────────────
  assert.match(
    source,
    /const \[requestsError, setRequestsError\] = useState\(false\)/,
    "the support-request loader must record that the read FAILED, separately from the list being empty",
  );
  assert.equal(
    (source.match(/setRequestsError\(true\)/g) ?? []).length,
    2,
    "both failure paths set it — a non-ok response AND a thrown fetch. Missing either one puts the " +
      "false 'no requests' message back for half the ways this can fail.",
  );
  assert.match(
    source,
    /setRequestsError\(false\)/,
    "and a successful read clears it, or one blip leaves the error showing for the rest of the session",
  );

  // ── The screen says what happened, and does NOT claim an empty history ─────
  assert.match(
    source,
    /\) : requestsError \? \(/,
    "the error branch must come BEFORE the empty branch — checked after it, a failed read still " +
      "renders 'No recent requests'",
  );
  assert.match(
    source,
    /title="Could not load your requests"/,
    "it names what happened rather than describing the person's record",
  );
  assert.match(
    source,
    /They have not been lost/,
    "and it says the requests still exist — the fear a blank list creates is that they are gone",
  );

  // ── Nor do the three tiles above it print a confident 0 ────────────────────
  for (const metric of ["openCount", "resolvedCount", "recentRequests.length"]) {
    assert.match(
      source,
      new RegExp(`value=\\{isLoadingRequests \\|\\| requestsError \\? "—" : ${metric.replace(".", "\\.")}\\}`),
      `the ${metric} tile must read — on a failed load, never 0: the count is unknown, not zero`,
    );
  }

  // ── The three lists that showed a blank table now say why they are blank ───
  for (const title of ["No performance rows yet", "No territory rows yet", "No trips yet"]) {
    assert.match(
      source,
      new RegExp(`title="${title}"`),
      `"${title}" — this list rendered a header and then nothing at all when it had no rows`,
    );
  }

  // ── And no insight is cut with an ellipsis ─────────────────────────────────
  // The owner's rule: text is never truncated with an ellipsis; where that collides with fitting
  // the screen, wrapping wins. These strings end in their measurement, so the cut removed the number.
  assert.doesNotMatch(
    source,
    /trimmed\.slice\(0, 79\)/,
    "shortInsight must not cut an insight at 79 characters and append '...'",
  );
}
