import assert from "node:assert/strict";

import {
  countWorkingDays,
  summarizeCheckins,
  summarizeVisits,
  type CheckinRow,
  type VisitRow,
} from "../src/lib/employee-360/service.ts";

// Two bugs this locks:
//  1. The "Visits by day of week" chart was empty for reps with no GPS check-ins,
//     because VisitSummary.dayOfWeek and CheckinSummary.dayOfWeek collided on the
//     `{ ...visitSummary, ...checkinSummary }` spread — the check-in array (all
//     zeros) overwrote the visit array. They are now visitDayOfWeek / checkinDayOfWeek.
//  2. The work week: Saturday IS a working day. Utilization's working days are the
//     call rate's own (isCallRateWorkingDay): Saturday to Wednesday, less the
//     confirmed national holidays. Thursday and Friday never count.

const window = { from: "2026-07-01", to: "2026-07-31", label: "July" };

function visit(date: string, type: number): VisitRow {
  return {
    visit_type: type,
    visit_type_description: null,
    visit_date: date,
    ampm: "AM",
    contact_crm_id: null,
    contact_name: "Dr X",
    customer_name: null,
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    comment: null,
  };
}

function dowOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export async function runEmployee360WorkweekTests() {
  // ── Bug 1: visit day-of-week is its OWN field, populated from productive visits ──
  // Seven consecutive days, one Regular (productive, type 0) visit each.
  const week = ["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11"];
  const visits: VisitRow[] = week.map((d) => visit(d, 0));
  const vs = summarizeVisits(visits, window);

  assert.equal(vs.productiveVisits, 7, "all 7 Regular visits are productive");
  assert.equal(vs.visitDayOfWeek.reduce((a, b) => a + b, 0), 7, "visitDayOfWeek is populated, not empty");
  for (const d of week) {
    assert.equal(vs.visitDayOfWeek[dowOf(d)], 1, `weekday ${dowOf(d)} (${d}) counted once`);
  }
  // The Saturday in this range must be counted (regression for the empty-chart bug
  // + Saturday-is-a-weekend bug). 2026-07-11 is a Saturday (dow 6).
  assert.equal(dowOf("2026-07-11"), 6, "2026-07-11 is a Saturday");
  assert.equal(vs.visitDayOfWeek[6], 1, "Saturday visits are counted in visitDayOfWeek");

  // ── Bug 1: check-in day-of-week is a SEPARATE field; empty check-ins don't blank visits ──
  const noCheckins: CheckinRow[] = [];
  const cs = summarizeCheckins(noCheckins, visits, vs);
  assert.deepEqual(cs.checkinDayOfWeek, [0, 0, 0, 0, 0, 0, 0], "no check-ins → checkinDayOfWeek all zeros");
  // The collision would have made a merged `dayOfWeek` all-zero; here the two are
  // independent, so the visit chart keeps its real distribution.
  assert.notDeepEqual(vs.visitDayOfWeek, cs.checkinDayOfWeek, "visit and check-in day-of-week are independent");

  // ── Bug 2: work week — Saturday to Wednesday; Thursday and Friday never count ──
  // One full calendar week (Sun 2026-07-05 … Sat 2026-07-11) has one Thursday and one Friday.
  assert.equal(dowOf("2026-07-09"), 4, "2026-07-09 is a Thursday");
  assert.equal(countWorkingDays("2026-07-05", "2026-07-11"), 5, "a 7-day week has 5 working days (Thu and Fri off)");
  assert.equal(countWorkingDays("2026-07-09", "2026-07-09"), 0, "a lone Thursday counts 0 working days");
  // A single Friday is not a working day; a single Saturday is.
  assert.equal(dowOf("2026-07-10"), 5, "2026-07-10 is a Friday");
  assert.equal(countWorkingDays("2026-07-10", "2026-07-10"), 0, "a lone Friday counts 0 working days");
  assert.equal(countWorkingDays("2026-07-11", "2026-07-11"), 1, "a lone Saturday counts 1 working day");
}
