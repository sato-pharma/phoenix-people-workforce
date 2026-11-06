import assert from "node:assert/strict";

import { aggregateSalesRows, describeSalesMonths, type SalesRow } from "../src/lib/employee-360/deep-service.ts";
import type { CrmListType } from "../src/lib/crm/list-types.ts";
import { customerLaneOf, summarizeVisits, TOP_CUSTOMERS_PER_LANE, type VisitRow } from "../src/lib/employee-360/service.ts";

// Employee 360, owner 2026-09-21.
//
// 1. "March, April, May, June are missing." They were there, but March to June 2026 carry sales and
//    NO target anywhere, so each drew as an empty bar reading "— · 95.1K/0", and their sales were
//    divided by the targets of the months that have one. Nosiba Salah read 103% while no targeted
//    month passed 79%. The closing's rule, the one the Business Review already follows: a month with
//    no target at all is left out of the achievement, numerator and denominator alike; its sales
//    still show.
// 2. "The most visited AM customers and PM customers and pharmacies. Separate." One ranking mixed
//    all three, and a pharmacy is not a contact.

function sale(overrides: Partial<SalesRow>): SalesRow {
  return {
    employee_hr_id: "B-1",
    line: "Anti Infective",
    family: "Saginko",
    product: "Saginko",
    month: 1,
    year: 2026,
    sales_value: 0,
    target_value: 0,
    ...overrides,
  };
}

const WINDOW = { from: "2026-08-23", to: "2026-09-21", label: "Last 30 days" };

function visit(overrides: Partial<VisitRow>): VisitRow {
  return {
    visit_type: 0,
    visit_type_description: "Regular",
    visit_date: "2026-09-01",
    ampm: "PM",
    contact_crm_id: null,
    contact_name: null,
    customer_name: null,
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    comment: null,
    speciality: null,
    ...overrides,
  };
}

export async function runEmployee360UntargetedMonthsTests() {
  // ── describeSalesMonths ──
  assert.equal(describeSalesMonths(["2026-06", "2026-03", "2026-05", "2026-04"]), "Mar – Jun 2026", "a run folds into one range, in order");
  assert.equal(describeSalesMonths(["2026-09"]), "Sep 2026");
  assert.equal(describeSalesMonths(["2026-03", "2026-04", "2026-09"]), "Mar – Apr 2026, Sep 2026", "a gap starts a new run");
  assert.equal(describeSalesMonths(["2025-12", "2026-01"]), "Dec 2025 – Jan 2026", "a run across the year names both years");

  // ── aggregateSalesRows: Nosiba Salah's eight months, production 2026-09-21 ──
  const months: Array<[number, number, number]> = [
    [1, 102_200, 129_500],
    [2, 71_400, 129_500],
    [3, 95_100, 0],
    [4, 47_400, 0],
    [5, 70_200, 0],
    [6, 54_200, 0],
    [7, 52_000, 120_500],
    [8, 60_800, 157_200],
  ];
  const summary = aggregateSalesRows(
    months.map(([month, sales, target]) => sale({ month, sales_value: sales, target_value: target })),
    false,
    0,
  );
  assert.equal(summary.monthly.length, 8, "all eight months are listed — March to June are not missing");
  assert.deepEqual(
    summary.monthly.filter((m) => !m.hasTarget).map((m) => [m.month, m.sales]),
    [
      ["2026-03", 95_100],
      ["2026-04", 47_400],
      ["2026-05", 70_200],
      ["2026-06", 54_200],
    ],
    "the four untargeted months keep their sales",
  );
  assert.equal(summary.totalSales, 553_300, "Total sales is every month's sales");
  assert.equal(summary.totalTarget, 536_700);
  assert.equal(summary.gradedSales, 286_400, "only January, February, July and August are graded");
  assert.equal(Math.round((summary.achievementPct ?? 0) * 100) / 100, 53.36, "286,400 / 536,700 — never 553,300 / 536,700 = 103%");
  assert.equal(summary.targetedMonthsCount, 4);
  assert.deepEqual(summary.untargetedMonths, ["2026-03", "2026-04", "2026-05", "2026-06"]);
  assert.equal(summary.untargetedLabel, "Mar – Jun 2026");
  assert.equal(summary.monthsHitTarget, 0);
  assert.equal(summary.topProducts[0].sales, 553_300, "a product's sales are all its sales");
  assert.equal(Math.round(summary.topProducts[0].achievementPct ?? 0), 53, "a product's achievement is graded the same way as the total");
  assert.match(summary.summaryText, /53% of target \(286\.4K \/ 536\.7K\) across 4 months with a target/);
  assert.match(summary.summaryText, /Mar – Jun 2026 have no target: 266\.9K of sales shown, not graded/);

  // A team month with a target grades every rep's sales in it, even a rep with no target of his own
  // ("inside a month every pound counts").
  const team = aggregateSalesRows(
    [
      sale({ employee_hr_id: "B-1", month: 7, sales_value: 100, target_value: 200 }),
      sale({ employee_hr_id: "B-2", month: 7, sales_value: 50, target_value: 0 }),
      sale({ employee_hr_id: "B-2", month: 4, sales_value: 999, target_value: 0 }),
    ],
    true,
    2,
  );
  assert.equal(team.gradedSales, 150, "July's untargeted rep counts toward July; April, with no target at all, does not");
  assert.equal(team.achievementPct, 75);
  assert.equal(team.totalSales, 1_149);

  // No target anywhere: nothing graded, nothing named, no percentage.
  const none = aggregateSalesRows([sale({ month: 4, sales_value: 10 }), sale({ month: 5, sales_value: 20 })], false, 0);
  assert.equal(none.achievementPct, null, "no target is no achievement, never 0%");
  assert.equal(none.untargetedLabel, null, "with no target anywhere there is nothing to set apart");
  assert.equal(none.targetedMonthsCount, 0);
  assert.equal(none.monthly.length, 2, "the months still show");
  assert.match(none.summaryText, /No month here carries a target, so nothing is graded\./);

  // ── customerLaneOf: the rep's list decides, then the visit's own signals ──
  const lists = new Map<number, Set<CrmListType>>([
    [11, new Set<CrmListType>(["AM"])],
    [22, new Set<CrmListType>(["PM"])],
    [33, new Set<CrmListType>(["Pharmacy"])],
  ]);
  assert.equal(customerLaneOf(visit({ contact_crm_id: 11, ampm: "PM" }), lists), "am", "an AM-list doctor is AM whatever session the visit says");
  assert.equal(customerLaneOf(visit({ contact_crm_id: 33, ampm: "AM" }), lists), "pharmacy", "a pharmacy on the list is a pharmacy");
  assert.equal(customerLaneOf(visit({ contact_crm_id: 44, ampm: "AM", speciality: "Pharmacy" }), lists), "pharmacy", "off the list, the specialty marks a pharmacy");
  assert.equal(customerLaneOf(visit({ contact_crm_id: 44, ampm: "am" })), "am", "no list at all: the AM/PM flag places a doctor");
  assert.equal(customerLaneOf(visit({ contact_crm_id: 44, ampm: " " })), null, "no list, no pharmacy mark, no flag: not placed");

  // ── summarizeVisits: three lists, each customer once, at most five each ──
  const rows: VisitRow[] = [
    visit({ contact_crm_id: 11, contact_name: "Dr Amal", ampm: "AM" }),
    visit({ contact_crm_id: 11, contact_name: "Dr Amal", ampm: "PM" }),
    visit({ contact_crm_id: 11, contact_name: "Dr Amal", ampm: "AM" }),
    visit({ contact_crm_id: 22, contact_name: "Dr Samy" }),
    visit({ contact_crm_id: 33, contact_name: "صيدلية النور", ampm: "AM" }),
    visit({ contact_crm_id: 33, contact_name: "صيدلية النور" }),
    visit({ contact_crm_id: 55, contact_name: "El Shifa Pharmacy", speciality: "Pharmacy" }),
    visit({ contact_crm_id: 66, contact_name: "Dr Off List", ampm: "AM" }),
    visit({ contact_crm_id: 66, contact_name: "Dr Off List", ampm: "PM" }),
    visit({ contact_crm_id: 66, contact_name: "Dr Off List", ampm: "PM" }),
    visit({ contact_crm_id: 77, contact_name: "Dr No Flag", ampm: null }),
    visit({ visit_type: -8, visit_type_description: "Campaign", contact_crm_id: 0 }),
    ...[101, 102, 103, 104, 105, 106].map((id) => visit({ contact_crm_id: id, contact_name: `Dr PM ${id}` })),
  ];
  const { topCustomers } = summarizeVisits(rows, WINDOW, lists);
  assert.deepEqual(topCustomers.am.top, [{ name: "Dr Amal", count: 3 }], "Dr Amal is on the AM list: one customer, all three visits");
  assert.equal(topCustomers.am.customers, 1);
  assert.deepEqual(
    topCustomers.pharmacy.top,
    [
      { name: "صيدلية النور", count: 2 },
      { name: "El Shifa Pharmacy", count: 1 },
    ],
    "pharmacies apart, from the list and from the specialty",
  );
  assert.equal(topCustomers.pm.top[0].name, "Dr Off List", "an off-list doctor goes where most of his visits were (2 PM of 3)");
  assert.ok(!topCustomers.am.top.some((c) => c.name === "Dr Off List"), "and he is listed once, never in both");
  assert.equal(topCustomers.pm.customers, 8, "Dr Samy, Dr Off List and six more PM doctors");
  assert.equal(topCustomers.pm.top.length, TOP_CUSTOMERS_PER_LANE, "at most five per list");
  assert.equal(topCustomers.unplaced, 1, "Dr No Flag cannot be placed; he is counted, not dropped");
}
