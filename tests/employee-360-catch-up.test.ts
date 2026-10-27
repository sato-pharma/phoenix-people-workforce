import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  conductedDoubleVisitFigures,
  leaderVisitFigures,
  managerOwnVisitsAsVisitRows,
  summarizeOutstationRequests,
  summarizePayrollExpenseRows,
  trainingManagerKeysOf,
  type PayrollExpenseRow,
} from "../src/lib/employee-360/deep-service.ts";
import { countWorkingDays, doubleReceivedKind, summarizeVisits, type VisitRow } from "../src/lib/employee-360/service.ts";
import { combinePlanCompliance } from "../src/lib/employee-360/team-lifecycle.ts";
import type { ManagerDayVisit } from "../src/lib/phoenix-crm/manager-visit-detail.ts";

/**
 * Employee 360 catch-up (owner, 2026-10-27): the expense, outstation and CRM-visit figures.
 *
 * - An expense counts what it PAYS (HR's approved amount), and a rejected trip pays nothing.
 * - The outstation block has no variance and no fraud signal.
 * - A leader's own visit with a senior is never a single visit; conducted double visits are counted by kind,
 *   without counting a Phoenix visit twice; his own visits join his field presence.
 * - The Training Manager is found by job function, never a title substring.
 * - A failed plan read is "—", never a zero. There is no fourth AM/PM bucket.
 * - Working days are Saturday to Wednesday, less the national holidays.
 */

function expenseRow(over: Partial<PayrollExpenseRow>): PayrollExpenseRow {
  return {
    allowance: 0,
    am_workload: 0,
    approved_amount: null,
    description: null,
    expense_date: "2026-09-06",
    from_location: null,
    hr_approved: false,
    km: 0,
    location: null,
    meeting_amount: 0,
    other_amount: 0,
    pharmacy_workload: null,
    pm_workload: 0,
    request_type: "Travel",
    status: "pending",
    to_location: "Alexandria",
    total: 0,
    transportation_type: null,
    travel_cost: 0,
    ...over,
  } as PayrollExpenseRow;
}

function managerVisit(over: Partial<ManagerDayVisit>): ManagerDayVisit {
  return {
    address: null,
    areaName: null,
    awaitingValidation: false,
    brickName: null,
    bucket: "AM",
    comment: null,
    customerName: "Dr. Mona Adel",
    date: "2026-09-06",
    grade: null,
    hasPin: false,
    id: Math.random().toString(36).slice(2),
    inVacantTerritory: false,
    kind: "single",
    kindLabel: "",
    listType: null,
    loggedAt: null,
    loggedHalf: "AM",
    managerHrId: "dm-1",
    pharmacyName: null,
    placeLabel: null,
    placeSource: "none",
    planned: true,
    products: [],
    source: "own",
    speciality: null,
    territoryName: null,
    withPeople: [],
    ...over,
  } as ManagerDayVisit;
}

function visitRow(over: Partial<VisitRow>): VisitRow {
  return {
    ampm: "AM",
    comment: null,
    contact_crm_id: 1,
    contact_name: "Dr. Hany Samir",
    customer_name: "Dr. Hany Samir",
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    source: "ireports360",
    speciality: null,
    visit_date: "2026-09-06",
    visit_type: 0,
    visit_type_description: null,
    ...over,
  } as VisitRow;
}

export async function runEmployee360CatchUpTests() {
  // ── B4: the expense total is what the trip PAYS; a rejected trip is left out ──
  {
    const summary = summarizePayrollExpenseRows([
      // HR cut a 1,000 claim to 600 and approved it.
      expenseRow({ allowance: 200, approved_amount: 600, hr_approved: true, status: "approved", total: 1000, travel_cost: 800 }),
      // Still pending, nothing changed: pays its claim.
      expenseRow({ approved_amount: null, total: 300, travel_cost: 300 }),
      // Rejected: pays nothing, counted only as rejected.
      expenseRow({ approved_amount: null, hr_approved: false, status: "Rejected", total: 5000, travel_cost: 5000 }),
    ]);
    assert.equal(summary.totalCost, 900, "B4: the total is the approved 600 plus the pending 300 — never the claim, never the rejected trip");
    assert.equal(summary.tripCount, 2, "B4: a rejected trip is not one of the period's expenses");
    assert.equal(summary.rejectedCount, 1, "B4: the rejected trip is still counted as rejected");
    assert.equal(summary.approvedCount, 1);
    assert.equal(summary.approvedCost, 600, "B4: the approved cost is the approved amount");
    assert.equal(summary.pendingCount, 1);
    const catSum = summary.categories.reduce((s, c) => s + c.amount, 0);
    assert.ok(Math.abs(catSum - summary.totalCost) < 0.001, `B4: the category split adds up to the total (${catSum} vs ${summary.totalCost})`);
  }

  // ── B5 + B6: no variance, no fraud, no "GPS-verified" ──
  {
    const out = summarizeOutstationRequests([
      { claimed_total_amount: 500, eligibility_status: "eligible", expected_total_amount: 400, territory_validation_status: "outside_expected_territory" },
      { claimed_total_amount: 200, eligibility_status: "not_eligible", expected_total_amount: 200, territory_validation_status: "outside_expected_territory" },
    ] as Parameters<typeof summarizeOutstationRequests>[0]);
    assert.equal(out.flaggedCount, 1, "B5: only the eligibility issue flags");
    assert.equal("variance" in out, false, "B5: the outstation summary carries no variance");
    assert.equal("fraudCount" in out || "fraudFlagged" in out, false, "B6: the outstation summary carries no fraud signal");
    const view = readFileSync("src/components/employee-360/employee-360-view.tsx", "utf8");
    assert.doesNotMatch(view, /GPS-verified/i, "B6: the 360 view never says GPS-verified");
    assert.doesNotMatch(view, /fraud/i, "B6: the 360 view never says fraud");
    assert.doesNotMatch(view, /label="Variance"/, "B5: the Variance tile is gone");
  }

  // ── C8 + C10: own visits alone and with a senior apart; own visits join field presence ──
  {
    const visits: ManagerDayVisit[] = [
      managerVisit({ bucket: "AM", kind: "single" }),
      managerVisit({ bucket: "PM", kind: "single", loggedHalf: "PM" }),
      managerVisit({ bucket: "PM", kind: "with_senior", loggedHalf: "PM" }),
      managerVisit({ awaitingValidation: true, kind: "single" }),
      managerVisit({ kind: "double", listType: "AM", source: "ride_along" }),
      managerVisit({ kind: "chain", listType: "PM", source: "ride_along" }),
      managerVisit({ kind: "product_manager", listType: "Pharmacy", pharmacyName: "El Ezaby", source: "ride_along" }),
    ];
    const fig = leaderVisitFigures(visits);
    assert.equal(fig.ownWithSenior.visits, 1, "C8: the visit with a senior is counted with a senior");
    assert.equal(fig.ownSingle.visits, 3, "C8: the with-senior visit is NOT a single visit (3 own alone, one awaiting validation)");
    assert.deepEqual(fig.ownSingle.split, { am: 1, pharmacies: 0, pm: 1 }, "C8: the single split skips the with-senior visit and the one awaiting validation");
    assert.deepEqual(fig.ownWithSenior.split, { am: 0, pharmacies: 0, pm: 1 });
    assert.deepEqual(fig.rides, { chains: 1, doubles: 1, productManagerVisits: 1 }, "C9: ride-alongs by kind");

    const rows = managerOwnVisitsAsVisitRows(visits);
    assert.equal(rows.length, 3, "C10: his own validated visits (alone and with a senior) join his field presence; ride-alongs do not");
    assert.ok(rows.every((r) => r.source === "phoenix" && r.visit_type === 0 && r.double_crm_id === null), "C10: each is a regular single row");
    assert.ok(rows.every((r) => r.customer_name === "Dr. Mona Adel"), "C10: named by the customer");
  }

  // ── C9: conducted double visits by kind, never a Phoenix visit twice; null when the Phoenix read failed ──
  {
    const phoenix = leaderVisitFigures([
      managerVisit({ kind: "double", listType: "AM", source: "ride_along" }),
      managerVisit({ kind: "product_manager", listType: "PM", source: "ride_along" }),
    ]);
    const door = [
      { ampm: "AM", comment: null, crm_visit_id: 101, double2_hr_id: null, source: "ireports360", speciality: null, visit_type: 0, visit_type_description: null },
      { ampm: "PM", comment: null, crm_visit_id: 102, double2_hr_id: "rm-1", source: "ireports360", speciality: null, visit_type: 0, visit_type_description: null },
      // The door's own Phoenix row is the same visit as a ride-along above: never counted twice.
      { ampm: "AM", comment: null, crm_visit_id: -7, double2_hr_id: null, source: "phoenix", speciality: null, visit_type: 0, visit_type_description: null },
    ];
    const conducted = conductedDoubleVisitFigures(door, phoenix);
    assert.ok(conducted, "C9: a figure when both reads worked");
    assert.deepEqual(conducted.byKind, { chains: 1, doubles: 2, productManagerVisits: 1 }, "C9: one figure per kind, the door's Phoenix row left out");
    assert.equal(conducted.total, 4, "C9: the total is the sum of the kinds");
    assert.deepEqual(conducted.split, { am: 2, pharmacies: 0, pm: 2 });
    assert.equal(conductedDoubleVisitFigures(door, null), null, "C13 spirit: a failed Phoenix read is no figure, never half of one");
  }

  // ── C11: the Training Manager by job function, never a title substring ──
  {
    const keys = trainingManagerKeysOf([
      { hrId: " TM-1 ", jobTitle: "Training Manager" },
      { hrId: "TM-2", jobTitle: null, positionTitle: "Training Manager" },
      { hrId: "REP-9", jobTitle: "Medical Rep (in training)" },
      { hrId: null, jobTitle: "Training Manager" },
    ]);
    assert.deepEqual([...keys].sort(), ["tm-1", "tm-2"], "C11: by job or position title through resolveJobFunctionRole; a title merely mentioning training is not one");
  }

  // ── C12: doubles received split by kind ──
  {
    assert.equal(doubleReceivedKind({ visit_kind: "chain" }), "chain");
    assert.equal(doubleReceivedKind({ visit_kind: "product_manager" }), "product_manager");
    assert.equal(doubleReceivedKind({ double2_hr_id: "rm-1", source: "ireports360" }), "chain", "C12: a second companion makes a chain");
    assert.equal(doubleReceivedKind({ source: "ireports360" }), "double");
    const window = { from: "2026-09-05", label: "test", to: "2026-09-09" };
    const summary = summarizeVisits(
      [
        visitRow({ double_crm_id: 5 }),
        visitRow({ double2_hr_id: "rm-1", double_crm_id: 5 }),
        visitRow({ double_hr_id: "pm-1", source: "phoenix", visit_kind: "product_manager" }),
        visitRow({}),
      ],
      window,
    );
    assert.equal(summary.doublesReceived, 3);
    assert.deepEqual(summary.doublesReceivedByKind, { chain: 1, withManager: 1, withProductManager: 1 }, "C12: doubles received by kind");
  }

  // ── C13: a failed plan read is null with a reason, never a zero ──
  {
    const failed = combinePlanCompliance(null, { approved: 1, submitted: 2 }, 5);
    assert.equal(failed.planSubmittedCount, null, "C13: a failed rep-plan read is no figure");
    assert.equal(failed.planApprovedCount, null);
    assert.equal(failed.planCoverageRate, null);
    assert.ok(failed.planUnavailableReason, "C13: the reason is given");
    const ok = combinePlanCompliance({ approved: 1, submitted: 3 }, { approved: 1, submitted: 1 }, 8);
    assert.deepEqual(ok, { planApprovedCount: 2, planCoverageRate: 0.5, planSubmittedCount: 4, planUnavailableReason: null });
  }

  // ── C14: no fourth AM/PM bucket; a visit with no period is PM ──
  {
    const summary = summarizeVisits(
      [visitRow({ ampm: "AM" }), visitRow({ ampm: null, contact_crm_id: 2 }), visitRow({ ampm: "PM", contact_crm_id: 3 })],
      { from: "2026-09-05", label: "test", to: "2026-09-09" },
    );
    assert.equal("unknownAmpm" in summary, false, "C14: there is no fourth bucket");
    assert.equal(summary.amVisits + summary.pmVisits + summary.pharmacyVisits, summary.productiveVisits, "C14: the three buckets hold every productive visit");
    assert.equal(summary.pmVisits, 2, "C14: a visit with no period is PM");
  }

  // ── C15: working days are Saturday to Wednesday, less the national holidays ──
  {
    // 2026-09-05 is a Saturday; 09-10 Thursday; 09-11 Friday.
    assert.equal(countWorkingDays("2026-09-05", "2026-09-11"), 5, "C15: Thursday and Friday never count");
    assert.equal(countWorkingDays("2026-09-10", "2026-09-10"), 0, "C15: a lone Thursday is no working day");
    assert.equal(countWorkingDays("2026-09-05", "2026-09-11", new Set(["2026-09-06"])), 4, "C15: a national holiday leaves the working days");
    const summary = summarizeVisits(
      [visitRow({ visit_date: "2026-09-06" }), visitRow({ contact_crm_id: 2, visit_date: "2026-09-10" })],
      { from: "2026-09-05", label: "test", to: "2026-09-11" },
      undefined,
      { complete: true, dates: new Set(["2026-09-07"]) },
    );
    assert.equal(summary.workingDaysInWindow, 4, "C15: the summary's working days take the holidays out");
    assert.equal(summary.utilization, 0.25, "C15: a Thursday visit never pushes utilization up");
  }
}
