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
const PROBATION = "app/employee-portals/probation/page.tsx";
const EXPENSE_DASHBOARD = "app/employee-portals/expense-dashboard/page.tsx";
const SUPPORT_REQUESTS = "app/employee-portals/support-requests/page.tsx";

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

  // ── The probation queue (Performance section) ─────────────────────────────
  // Both of its lists are best-effort and catch to [], and the "nothing to show" screen reads
  // their LENGTH — so with both queries down an evaluator holding overdue SLA tasks was told he
  // had none, which is the same defect as the dashboard's above and lands on someone's record.
  const probation = stripComments(readFileSync(PROBATION, "utf8"));
  assert.equal(
    (probation.match(/loadFailed = true;/g) ?? []).length,
    2,
    "BOTH probation reads must record the failure — the inbox and the scorable list. Either one " +
      "missing leaves the false 'no probation records' screen for half the ways this can fail.",
  );
  assert.match(
    probation,
    /if \(loadFailed && feedbackTasks\.length === 0 && scorableProbationers\.length === 0\) \{/,
    "the failed-read branch must be tested BEFORE the emptiness branch, or a failure still renders " +
      "as 'No active probation records found for your current scope'",
  );
  assert.match(
    probation,
    /title="Could not load your probation queue"/,
    "it names what happened rather than describing the evaluator's caseload",
  );
  assert.match(
    probation,
    /Nothing has been lost or completed/,
    "and it says the queue still exists — a blank list on an SLA screen reads as 'you are clear'",
  );

  // ── The expense dashboard (Outstation Expenses) — the worst of the nine ────
  // One catch set `data = null`, and the branch below tested `!data || data.empty.profile`, so a
  // thrown read and an unlinked profile were the same thing to this page. An employee whose data
  // source was down was told to CONTACT HR about a linkage problem that does not exist — he then
  // does, and HR finds nothing wrong. A confident zero is bad; a confident WRONG REASON sends a
  // real person to a real colleague on a false errand.
  const expenses = stripComments(readFileSync(EXPENSE_DASHBOARD, "utf8"));
  assert.match(
    expenses,
    /let loadFailed = false;/,
    "the expense dashboard must record a thrown read separately from an unlinked profile",
  );
  // Declaring the flag is not recording the failure. Caught by breaking it: with `loadFailed = true`
  // deleted from the catch, every other assertion here still passed — the branch was present, the
  // ordering was right, and the flag was simply never set, so the false HR message came back in
  // full. A test that only checks a variable EXISTS is satisfied by a variable nobody writes.
  assert.match(
    expenses,
    /\} catch \{[\s\S]*?loadFailed = true;/,
    "the catch must SET loadFailed — declaring it is not recording the failure",
  );
  assert.match(
    expenses,
    /if \(loadFailed\) \{[\s\S]*?title="Could not load your expenses"/,
    "it must render its OWN message, not fall through to one about a profile link",
  );
  // ORDERING IS THE WHOLE FIX. Checked after the profile branch, a failed read still returns
  // "contact HR" — the assertion above would pass and the defect would be untouched.
  {
    const failedAt = expenses.indexOf("if (loadFailed)");
    const profileAt = expenses.indexOf("Your employee profile is not linked yet");
    assert.ok(
      failedAt > -1 && profileAt > -1 && failedAt < profileAt,
      "the failed-read branch must come BEFORE the unlinked-profile branch, or the false HR message returns",
    );
  }

  // ── The HR support queue (off-sidebar, cleared by the tail PR) ─────────────
  // `catch { initialItems = [] }` handed the workspace an empty ticket board, and an empty board
  // reads to HR Advisory as "no employee is waiting on us" — on the one screen whose entire job is
  // that nobody is left waiting. Same defect as the two above, except it lands on the people who
  // opened the tickets rather than on the reader.
  const support = stripComments(readFileSync(SUPPORT_REQUESTS, "utf8"));
  assert.match(
    support,
    /\} catch \(error\) \{[\s\S]*?loadFailed = true;/,
    "the catch must SET loadFailed — declaring the flag is not recording the failure, and that exact " +
      "hole passed every other assertion in this file when the expense-dashboard one was written",
  );
  assert.match(
    support,
    /if \(loadFailed\) \{[\s\S]*?title="Could not load the support queue"/,
    "it must name what happened rather than hand the board an empty list",
  );
  assert.match(
    support,
    /No ticket has been lost or closed/,
    "and it must say the tickets still exist — an empty queue reads as 'they were all dealt with'",
  );
  {
    // ORDERING, again. The workspace must render AFTER the failed-read return, or the empty board
    // is still what HR sees and nothing about this change is visible.
    const failedAt = support.indexOf("if (loadFailed)");
    const workspaceAt = support.indexOf("<SupportRequestsWorkspace");
    assert.ok(
      failedAt > -1 && workspaceAt > -1 && failedAt < workspaceAt,
      "the failed-read branch must come BEFORE the workspace renders, or the empty board returns",
    );
  }

  // ── And the two best-effort pickers are no longer SILENT ───────────────────
  // Neither of these gets a banner, deliberately: each page's PRIMARY read already surfaces its own
  // failure, and these two catches only empty a picker. What they may not be is invisible — a
  // manager with six direct reports saw a one-entry picker and no reason given, and someone filling
  // a contract saw a company with no lines on file. Both now log through the same helper every
  // other best-effort read in app/employee-portals/ uses.
  for (const [file, moduleName] of [
    ["app/employee-portals/fingerprint-analytics/page.tsx", "attendance-direct-reports"],
    ["app/employee-portals/hiring-pack/page.tsx", "hiring-pack-lines"],
  ] as const) {
    const body = stripComments(readFileSync(file, "utf8"));
    assert.match(
      body,
      new RegExp(`module: "${moduleName}"`),
      `${file} must log its best-effort failure under module "${moduleName}" instead of swallowing it`,
    );
  }
}
