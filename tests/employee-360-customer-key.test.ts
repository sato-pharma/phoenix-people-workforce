import assert from "node:assert/strict";

import {
  customerKeyOf,
  summarizeVisits,
  windowSalesEfficiency,
  type VisitRow,
} from "../src/lib/employee-360/service.ts";

// Regression coverage for the Employee 360 audit of 2026-09-21.
//
// 1. Every campaign (-8) and unlabelled field visit (-30) carries contact id 0 and no name —
//    6,623 and 320 production rows since July, not one with a real id. Keyed as `id:0`, all of a
//    rep's campaign work became ONE customer: distinct customers one too high, a repeat customer
//    who does not exist, and visits-per-customer inflated by every campaign visit. The catch-all
//    contact 100000 is no doctor either.
// 2. Sales / visit and Sales / customer divided EVERY month since the history floor by the
//    window's visits. They must use only the months the window touches, and a team roll-up gets
//    no ratio at all.
//
// The hire-month cut that once lived here is now seat tenure (each month credited to whoever held
// the seat on its last day), pinned in tests/employee-360-canonical-sales.test.ts.

const WINDOW = { from: "2026-08-23", to: "2026-09-21", label: "Last 30 days" };

function visit(overrides: Partial<VisitRow>): VisitRow {
  return {
    visit_type: 0,
    visit_type_description: "Regular",
    visit_date: "2026-09-01",
    ampm: "AM",
    contact_crm_id: null,
    contact_name: null,
    customer_name: null,
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    comment: null,
    ...overrides,
  };
}

export async function runEmployee360CustomerKeyTests() {
  // ── customerKeyOf: 0 and the catch-all are nobody; a real id is itself ──
  assert.equal(customerKeyOf({ contact_crm_id: 0, contact_name: null, customer_name: null }), null, "contact 0 is nobody");
  assert.equal(customerKeyOf({ contact_crm_id: 100000, contact_name: "Catch all", customer_name: null }), null, "100000 is the catch-all, not a doctor");
  assert.equal(customerKeyOf({ contact_crm_id: -3, contact_name: null, customer_name: null }), null, "a negative id is no contact");
  assert.equal(customerKeyOf({ contact_crm_id: 4512, contact_name: "Dr Hany", customer_name: null }), "id:4512");
  assert.equal(customerKeyOf({ contact_crm_id: null, contact_name: "  Dr Mona ", customer_name: null }), "dr mona", "a native row with no id keys on its name");
  assert.equal(customerKeyOf({ contact_crm_id: null, contact_name: null, customer_name: null }), null);

  // ── summarizeVisits: four campaign visits reach no customer ──
  const rows: VisitRow[] = [
    visit({ contact_crm_id: 4512, contact_name: "Dr Hany", visit_date: "2026-09-01" }),
    visit({ contact_crm_id: 4512, contact_name: "Dr Hany", visit_date: "2026-09-08" }),
    visit({ contact_crm_id: 7781, contact_name: "Dr Mona", visit_date: "2026-09-02" }),
    visit({ visit_type: -8, visit_type_description: "Campaign", contact_crm_id: 0, visit_date: "2026-09-03" }),
    visit({ visit_type: -8, visit_type_description: "Campaign", contact_crm_id: 0, visit_date: "2026-09-03", ampm: "PM" }),
    visit({ visit_type: -8, visit_type_description: "Campaign", contact_crm_id: 0, visit_date: "2026-09-04" }),
    visit({ visit_type: 0, contact_crm_id: 100000, contact_name: "Catch all", visit_date: "2026-09-05" }),
  ];
  const summary = summarizeVisits(rows, WINDOW);
  assert.equal(summary.productiveVisits, 7, "campaign and catch-all visits still count as productive work");
  assert.equal(summary.campaignVisits, 3);
  assert.equal(summary.distinctCustomers, 2, "only Dr Hany and Dr Mona were reached — contact 0 and 100000 are not customers");
  assert.equal(summary.repeatCustomers, 1, "Dr Hany is the one repeat customer; contact 0 must not be a second");
  assert.equal(summary.oneTimeCustomers, 1);
  assert.equal(summary.avgVisitsPerCustomer, 1.5, "3 visits that reached a customer over 2 customers, never 7 over 2");

  // ── windowSalesEfficiency: only the window's months, never the whole series ──
  const monthly = [
    { month: "2026-01", sales: 900_000 },
    { month: "2026-07", sales: 50_000 },
    { month: "2026-08", sales: 40_000 },
    { month: "2026-09", sales: 20_000 },
  ];
  const own = windowSalesEfficiency({ monthly, window: WINDOW, isTeamRollup: false, productiveVisits: 30, distinctCustomers: 12 });
  assert.equal(own.windowSalesValue, 60_000, "August + September only — the window runs 23 Aug to 21 Sep");
  assert.equal(own.salesPerVisit, 2_000, "60,000 over 30 visits, never the 1,010,000 since January");
  assert.equal(own.salesPerCustomer, 5_000);

  const team = windowSalesEfficiency({ monthly, window: WINDOW, isTeamRollup: true, productiveVisits: 30, distinctCustomers: 12 });
  assert.equal(team.salesPerVisit, null, "a team roll-up's sales over the manager's own visits describe nobody");
  assert.equal(team.salesPerCustomer, null);
  assert.equal(team.windowSalesValue, 60_000, "the expense ratio still gets the window's sales");

  const quiet = windowSalesEfficiency({ monthly, window: { from: "2026-10-01", to: "2026-10-31" }, isTeamRollup: false, productiveVisits: 10, distinctCustomers: 4 });
  assert.equal(quiet.salesPerVisit, null, "no sales in the window is no ratio, not zero");
  assert.equal(windowSalesEfficiency({ monthly, window: WINDOW, isTeamRollup: false, productiveVisits: 0, distinctCustomers: 0 }).salesPerVisit, null);
}
