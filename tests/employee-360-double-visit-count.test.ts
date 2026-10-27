import assert from "node:assert/strict";

import { summarizeVisits, type Employee360Window, type VisitRow } from "../src/lib/employee-360/service.ts";

// Regression coverage for the employee-360 double-visit OVER-COUNT (data-fidelity
// audit finding "A", 2026-07-18). summarizeVisits used to count `doublesReceived`
// as ANY row with a resolved `double_hr_id`, on ANY visit_type — so a partner
// riding along on a Meeting/Vacation/Training row inflated the DV count, and a
// real partner on a fieldwork visit whose id was unmapped (`double_hr_id` null)
// was silently DROPPED. The canonical crm/reads predicate is the single source of
// truth: a double visit = a real partner (`double_crm_id` ≠ null/0) on a fieldwork
// type ∈ {0 Regular, -8 Campaign}. This test locks employee-360 to that predicate.

const WINDOW: Employee360Window = { from: "2026-01-01", to: "2026-12-31", label: "test window" };

function visit(partial: Partial<VisitRow>): VisitRow {
  return {
    visit_type: 0,
    visit_type_description: "Regular",
    visit_date: "2026-03-10",
    ampm: "AM",
    contact_crm_id: null,
    contact_name: null,
    customer_name: null,
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    comment: null,
    ...partial,
  };
}

export async function runEmployee360DoubleVisitCountTests() {
  const rows: VisitRow[] = [
    // 1. Regular fieldwork with a real partner → COUNTS
    visit({ visit_type: 0, double_crm_id: 501, double_hr_id: "mr-0001" }),
    // 2. Campaign fieldwork with a real partner → COUNTS
    visit({ visit_type: -8, visit_type_description: "Campaign", double_crm_id: 502, double_hr_id: "mr-0002" }),
    // 3. Meeting with a partner riding along → does NOT count (not a fieldwork type)
    visit({ visit_type: -19, visit_type_description: "Unknown", comment: "Weekly meeting", double_crm_id: 503, double_hr_id: "mgr-1" }),
    // 4. Regular with NO real partner (double_crm_id null but a stray double_hr_id) → does NOT count
    visit({ visit_type: 0, double_crm_id: null, double_hr_id: "mgr-2" }),
    // 5. Regular with an explicit zero partner id → does NOT count
    visit({ visit_type: 0, double_crm_id: 0, double_hr_id: "mgr-3" }),
    // 6. Vacation with a partner → does NOT count (not a fieldwork type)
    visit({ visit_type: -4, visit_type_description: "Vacation", double_crm_id: 504, double_hr_id: "mgr-4" }),
    // 7. Regular fieldwork with a real partner but an UNMAPPED double_hr_id → COUNTS (keyed on crm id)
    visit({ visit_type: 0, double_crm_id: 505, double_hr_id: null }),
  ];

  const s = summarizeVisits(rows, WINDOW);

  // Only rows 1, 2, 7 are canonical double visits.
  assert.equal(s.doublesReceived, 3, "only real partners on fieldwork types {0,-8} count as double visits");
  // Rows 1, 2 and 7 share 10 Mar (the fixture's default day), so the three double visits were made on one day.
  assert.equal(s.doublesReceivedDays, 1, "the double visits received are counted on their distinct days");
  const spread = summarizeVisits(
    [
      visit({ visit_date: "2026-03-10", double_crm_id: 501, double_hr_id: "mr-0001" }),
      visit({ visit_date: "2026-03-10", double_crm_id: 502, double_hr_id: "mr-0002" }),
      visit({ visit_date: "2026-03-12", double_crm_id: 501, double_hr_id: "mr-0001" }),
      // A partner on a Meeting row is no double visit, so its day is no double-visit day.
      visit({ visit_date: "2026-03-15", visit_type: -19, visit_type_description: "Unknown", comment: "meeting", double_crm_id: 9, double_hr_id: "m" }),
      // A single visit on another day is not a double-visit day either.
      visit({ visit_date: "2026-03-16" }),
    ],
    WINDOW,
  );
  assert.equal(spread.doublesReceived, 3);
  assert.equal(spread.doublesReceivedDays, 2, "3 double visits on 2 days: 10 Mar and 12 Mar, never the meeting's or the single visit's day");

  // Productive visits = every regular/campaign-bucket row (1,2,4,5,7) = 5.
  assert.equal(s.productiveVisits, 5);
  // singleVisits = productiveVisits − productiveDoubles = 5 − 3 = 2.
  assert.equal(s.singleVisits, 2, "single visits exclude the productive double visits, and only real DVs are subtracted");

  // The two specific pre-fix bugs, called out explicitly:
  const meetingOnly = summarizeVisits([visit({ visit_type: -19, visit_type_description: "Unknown", comment: "meeting", double_crm_id: 9, double_hr_id: "m" })], WINDOW);
  assert.equal(meetingOnly.doublesReceived, 0, "a partner on a Meeting row must NEVER count as a double visit");

  const unmappedPartner = summarizeVisits([visit({ visit_type: 0, double_crm_id: 77, double_hr_id: null })], WINDOW);
  assert.equal(unmappedPartner.doublesReceived, 1, "a real partner on fieldwork counts even when its employee id is unmapped");
}
