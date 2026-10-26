/**
 * The plan history lists each week once and names it by its date (NSM audit, 2026-10-26).
 *
 *   1. /employee-portals/plans listed 2026-W32 twice — rev 4 "Draft" and rev 5 "HR acknowledged", two headers
 *      of one period with no parent_plan_id between them. A draft whose period went forward on another plan
 *      can never be sent, so `splitDraftsReplacedByALaterPlan` sets it aside and the page says how many.
 *   2. Weeks read "2026-W42" on the history and "Week: 2026-10-24" on the Private Calendar's daily timeline.
 *      Both now read "Week of 18 Oct" — the day the week starts. A week key names the ISO week that ENDS on
 *      its Sunday, so 2026-W42 starts on Sunday 18 October.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mapPlanRowToPrivateCalendarItem } from "@/lib/private-calendar/plan-items";
import { planPeriodShortLabel, weekOfLabel } from "@/lib/weekly-planning/plan-labels";
import { splitDraftsReplacedByALaterPlan } from "@/lib/weekly-planning/plan-revisions";
import { weekStartDateFromWeekKey } from "@/lib/weekly-planning/week";

type Plan = { id: string; periodKey: string; planKind: string; revision: number; status: string };
const plan = (id: string, periodKey: string, revision: number, status: string, planKind = "weekly"): Plan => ({
  id,
  periodKey,
  planKind,
  revision,
  status,
});

export function runPlansHistoryReplacedDraftsAndWeekLabelsTests() {
  // ── 1. A draft its week replaced ──────────────────────────────────────────────────────────────────
  {
    const plans = [
      plan("w31", "2026-W31", 5, "hr_acknowledged"),
      plan("w32-draft", "2026-W32", 4, "draft"),
      plan("w32", "2026-W32", 5, "hr_acknowledged"),
      plan("w33-draft", "2026-W33", 1, "draft"), // the only plan of its week: kept
      plan("w34-draft", "2026-W34", 2, "draft"),
      plan("w34-rejected", "2026-W34", 1, "manager_rejected"), // a dead plan replaces nothing
      plan("w35-draft", "2026-W35", 1, "draft"),
      plan("w35-pending", "2026-W35", 2, "manager_pending"), // in approval: the draft can never be sent
      plan("m08-draft", "2026-08", 1, "draft", "monthly"), // another kind's week does not count
    ];
    const { kept, replaced } = splitDraftsReplacedByALaterPlan(plans);
    assert.deepEqual(
      replaced.map((p) => p.id),
      ["w32-draft", "w35-draft"],
      "a draft whose week went forward on another plan is listed once, by the plan that replaced it",
    );
    assert.deepEqual(kept.map((p) => p.id), ["w31", "w32", "w33-draft", "w34-draft", "w34-rejected", "w35-pending", "m08-draft"]);
  }

  // ── 2. Weeks named by their date ──────────────────────────────────────────────────────────────────
  assert.equal(weekStartDateFromWeekKey("2026-W42"), "2026-10-18", "a week key names the ISO week that ENDS on its Sunday");
  assert.equal(weekStartDateFromWeekKey("2026-W41"), "2026-10-11");
  assert.equal(weekStartDateFromWeekKey("not a key"), null);
  assert.equal(weekOfLabel("2026-W42"), "Week of 18 Oct");
  assert.equal(weekOfLabel("2026-10-24"), "Week of 24 Oct", "a week's start date reads the same way");
  assert.equal(weekOfLabel(""), "");
  assert.equal(planPeriodShortLabel({ periodKey: "2026-W32", periodStartDate: "2026-08-09", planKind: "weekly" }), "Week of 9 Aug");
  assert.equal(planPeriodShortLabel({ periodKey: "2026-08", periodStartDate: "2026-08-01", planKind: "monthly" }), "Aug 2026");

  // The Private Calendar's daily timeline.
  const item = mapPlanRowToPrivateCalendarItem(
    { employee_hr_id: "A-12", employee_name: "Ali Mohamed", manager_name: null, period_key: "2026-W42", status: "hr_acknowledged" },
    {
      activity_date: "2026-10-19",
      activity_title: "Field",
      activity_type: "Field",
      area: null,
      double_visit_medical_rep_name: null,
      end_time: null,
      id: "i1",
      location_text: null,
      notes: null,
      objective: null,
      start_time: null,
    } as unknown as Parameters<typeof mapPlanRowToPrivateCalendarItem>[1],
  );
  assert.ok(item.detailLines.includes("Week of 18 Oct"), `the timeline names the week by its date: ${item.detailLines.join(" | ")}`);
  assert.equal(item.detailLines.some((line) => line.includes("2026-W42")), false, "never the week code");

  const planItems = readFileSync("src/lib/private-calendar/plan-items.ts", "utf8");
  assert.ok(planItems.includes("detailLines.push(weekOfLabel(halfDay.weekStart)"), "a manager's Phoenix CRM half-day names its week by its date too");

  // ── 3. The history page wears both ────────────────────────────────────────────────────────────────
  const history = readFileSync("src/components/employee-portal/plans-history.tsx", "utf8");
  assert.ok(history.includes("splitDraftsReplacedByALaterPlan(plans)"), "the history sets replaced drafts aside");
  assert.ok(history.includes("{planNounLabel(plan.planKind)} · {planPeriodShortLabel(plan)}"), "a plan card is headed by its week's date");
  assert.equal(history.includes("{plan.periodKey}"), false, "the history never prints the week code");
}
