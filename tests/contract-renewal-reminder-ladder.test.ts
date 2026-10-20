import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { contractRenewalReminderDaysAhead } from "../src/lib/contracts/service.ts";

const routeSource = readFileSync("app/api/notifications/contract-renewals/route.ts", "utf8");

// The hard-wrapped source is read flattened so an assertion cannot fail merely because a line
// broke at a different column after an edit.
const flatRouteSource = routeSource.replace(/\s+/g, " ");

export function runContractRenewalReminderLadderTests() {
  // The owner set this ladder on 2026-09-29: 2 months and 15 days, 2 months, 1 month, 15 days
  // before the renewal date. The numbers look close enough to `lifecycleRiskWindows`
  // (60 / 30 / 7) that the obvious-looking tidy-up is to fold them back into it — which would
  // silently restore the 7-day and same-day reminders he dropped, and move the Contract Renewal
  // board's colour bands as a side effect.
  assert.deepEqual(
    [...contractRenewalReminderDaysAhead],
    [75, 60, 30, 15],
    "contract renewal reminders fire at 75, 60, 30 and 15 days before the renewal date (owner, 2026-09-29) — not the retired 60/30/7/0",
  );

  assert.ok(
    !contractRenewalReminderDaysAhead.includes(0 as never),
    "no reminder fires on the renewal date itself — a notice that arrives on the day is a record, not a warning",
  );

  // The cron must take the ladder from the constant. Before 2026-09-29 it built its own array out
  // of three `lifecycleRiskWindows` members plus a literal 0, so the schedule lived in two places
  // and the dashboard's bands were load-bearing for when mail went out.
  assert.ok(
    flatRouteSource.includes("getContractRenewalReminderCandidates(contractRenewalReminderDaysAhead)"),
    "the contract-renewal cron passes the shared ladder constant, never its own inline array of day counts",
  );
  assert.ok(
    !flatRouteSource.includes("lifecycleRiskWindows"),
    "the contract-renewal cron no longer reads lifecycleRiskWindows — those windows colour the board, they do not schedule mail",
  );

  // The final rung is the loudest. When the ladder ended at 7 days this threshold was the literal
  // 7; leaving it behind after the ladder moved to 15 would have made every reminder a "warning"
  // and none of them critical, so the last notice would arrive quieter than the one before it.
  assert.ok(
    flatRouteSource.includes("const contractRenewalEscalationDays = Math.min(...contractRenewalReminderDaysAhead)"),
    "the danger/critical threshold is derived from the ladder's last rung, never a literal day count that can be left behind when the ladder moves",
  );
  assert.ok(
    !/row\.daysUntil <= \d/.test(flatRouteSource),
    "no literal day count is compared against daysUntil in the contract-renewal cron",
  );
  assert.equal(
    Math.min(...contractRenewalReminderDaysAhead),
    15,
    "the escalating rung is 15 days, so the last reminder before the renewal date is the critical one",
  );

  // HR Operations is the seat that maintains contracts (contracts: read/create/update/export in
  // the HR function catalogue), added on the owner's instruction so the HR Generalist running
  // renewals is told at the same time as the manager chain. It is resolved by ROLE, so the
  // reminder follows the seat rather than whoever holds it today. HR Administration (the HR
  // Operations Specialist seat) joined on 2026-10-20: she tracks renewals and prepares their papers.
  assert.ok(
    flatRouteSource.includes('const contractRenewalHrApproverRoles = ["Super Admin", "HR Operations", "HR Administration"]'),
    "contract renewal reminders reach the Super Admin, the HR Operations seat and the HR Administration seat, by role and not by hr id",
  );
  // Read the array literal itself rather than sweeping the whole file for the string: the comment
  // above it explains WHY HR Advisory is excluded, so a bare `includes("HR Advisory")` check would
  // fail on the explanation and could only be "fixed" by deleting the reason.
  const approverRoles = /const contractRenewalHrApproverRoles = \[([^\]]*)\]/.exec(flatRouteSource)?.[1] ?? "";
  assert.ok(
    approverRoles && !approverRoles.includes("HR Advisory"),
    "HR Advisory is deliberately excluded from the recipient roles — her contracts grant is read-only, so a pending-recommendation reminder is not hers to act on",
  );
  assert.ok(
    !/["']HR-\d/.test(flatRouteSource),
    "no employee is named by hr id in the contract-renewal cron — a named recipient strands the reminder when that person leaves the seat",
  );
}
