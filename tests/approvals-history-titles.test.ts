import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { excuseHistoryTitle, leaveHistoryTitle, planHistoryTitle } from "../src/lib/approvals-hub/history-title.ts";
import { stripComments } from "./support/comment-strip.ts";

// An Approvals Hub history row is titled in words: the type by its own name, the day as a Cairo date, and
// no module prefix, because the tab already says "Leave", "Excuse" or "Plans" (docs/tables-said-once-fit.md).
export function runApprovalsHistoryTitlesTests() {
  assert.equal(leaveHistoryTitle("annual", "2026-10-18"), "Annual Vacation · 18 Oct 2026");
  assert.equal(leaveHistoryTitle("sick", "2026-10-02"), "Sick Vacation · 02 Oct 2026");
  assert.ok(!/_/.test(leaveHistoryTitle("sick_leave_with_note", "2026-10-18")), "a stored code never reaches the title");
  assert.ok(!/^Leave/.test(leaveHistoryTitle("annual", "2026-10-18")), "no module prefix");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(leaveHistoryTitle("annual", "2026-10-18")), "no ISO date");
  assert.equal(leaveHistoryTitle("annual", null), "Annual Vacation", "a missing day leaves the type alone, never a stray separator");

  assert.equal(excuseHistoryTitle("morning", "2026-10-18"), "Morning · 18 Oct 2026");
  assert.equal(excuseHistoryTitle("afternoon", "2026-10-18"), "Afternoon · 18 Oct 2026");
  assert.ok(!/^Excuse/.test(excuseHistoryTitle("morning", "2026-10-18")), "no module prefix");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(excuseHistoryTitle("morning", "2026-10-18")), "no ISO date");

  assert.equal(planHistoryTitle({ periodKey: "2026-W43", periodStartDate: "2026-10-18", planKind: "weekly" }), "Week of 18 Oct");
  assert.equal(planHistoryTitle({ periodKey: "2026-08", periodStartDate: "2026-08-01", planKind: "monthly" }), "Aug 2026");
  assert.ok(!/W\d\d/.test(planHistoryTitle({ periodKey: "2026-W43", periodStartDate: "2026-10-18", planKind: "weekly" })), "never the week code");
  assert.ok(!/plan/i.test(planHistoryTitle({ periodKey: "2026-W43", periodStartDate: "2026-10-18", planKind: "weekly" })), "no module prefix");

  // service.ts builds every history title through these three, never by hand.
  const service = stripComments(readFileSync("src/lib/approvals-hub/service.ts", "utf8"));
  assert.ok(!/title: `Leave · /.test(service), "a hand-built 'Leave · …' history title is back");
  assert.ok(!/title: `Excuse · /.test(service), "a hand-built 'Excuse · …' history title is back");
  assert.ok(!/title: `\$\{kindLabel\} plan · /.test(service), "a hand-built '<kind> plan · <code>' history title is back");
  assert.ok(!/vacation_type \?\? ""\)\.replace\(\/_\/g/.test(service), "a vacation type is shown with its underscores replaced");
  assert.ok(/leaveHistoryTitle\(/.test(service) && /excuseHistoryTitle\(/.test(service) && /planHistoryTitle\(/.test(service), "service.ts no longer calls the history-title builders");
}
