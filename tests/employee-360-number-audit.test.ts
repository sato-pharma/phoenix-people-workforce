import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { CoachingReportSummaryRow } from "../src/lib/coaching/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { busiestTerritories, shapeFrequency } from "../src/lib/employee-360/crm-insights.ts";
import {
  buildDoubleVisitHistory,
  expenseEfficiencyOf,
  expenseRecordedUntilNote,
  leaderVisitFigures,
  poolImpact,
} from "../src/lib/employee-360/deep-service.ts";
import { unpublishedEmployee360FamilyPeriods } from "../src/lib/employee-360/sales-canonical.ts";
import type { VisitRow } from "../src/lib/employee-360/service.ts";
import { summarizeTrainingManagerAnalytics } from "../src/lib/employee-360/tm-analytics.ts";
import { customerFrequencyRow } from "../src/lib/phoenix-crm/customer-frequency.ts";
import type { ManagerDayVisit } from "../src/lib/phoenix-crm/manager-visit-detail.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Every Employee 360 figure checked against its source (2026-10-27). Each block is a number that was
 * wrong on production:
 *
 * - the Training Manager's "Sessions delivered" left out reps who have since resigned (25 of A-7's 51);
 * - the before/after impact averaged in spans the read never fetched or that had not happened yet;
 * - the double-visit history dropped 32 visits whose partner has no HR id, while "doubles received" counted them;
 * - expenses stopped at the last recorded claim and said nothing;
 * - a Product Manager's months with no published closing vanished instead of being named;
 * - Cost / visit and Expenses vs sales divided claims to August by visits and sales to October;
 * - a manager over more than 15 territories lost the frequency section instead of reading the 15 most visited.
 */

function rep(hrId: string): EmployeeDirectoryRow {
  return {
    hrId,
    employmentStatus: "active",
    jobTitle: "Medical Representative",
    positionTitle: "Medical Representative",
    organogramVisible: true,
  } as unknown as EmployeeDirectoryRow;
}

function coaching(medicalRepHrId: string, status: string, coachingDate = "2026-09-10"): CoachingReportSummaryRow {
  return {
    coachHrId: "A-7",
    coachName: "Training Manager",
    coachingDate,
    finalScorePercent: 80,
    medicalRepHrId,
    medicalRepName: medicalRepHrId,
    status,
  } as unknown as CoachingReportSummaryRow;
}

function visit(over: Partial<VisitRow>): VisitRow {
  return {
    ampm: "PM",
    comment: null,
    contact_crm_id: 1,
    contact_name: "Dr. Mona Adel",
    customer_name: null,
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    visit_date: "2026-10-12",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...over,
  } as VisitRow;
}

function achievement(over: Partial<AchievementRow>): AchievementRow {
  return {
    period: "2026-07",
    lineCode: "cns",
    regionCode: "LE-1",
    areaCode: "GZ6",
    areaState: "active",
    isOther: false,
    repSeatId: "seat-1",
    repHrId: "B-158",
    dmSeatId: "seat-dm",
    dmHrId: "A-001",
    productCode: "SA001",
    actualUnits: 10,
    actualValue: 1000,
    targetUnits: 8,
    targetValue: 800,
    achievementValue: 1.25,
    achievementUnits: 1.25,
    hasTarget: true,
    hasActual: true,
    ...over,
  };
}

function managerVisit(over: Partial<ManagerDayVisit>): ManagerDayVisit {
  return {
    awaitingValidation: false,
    bucket: "PM",
    date: "2026-10-12",
    kind: "double",
    listType: "PM",
    pharmacyName: null,
    source: "ride_along",
    ...over,
  } as ManagerDayVisit;
}

const months = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-${String(from + i).padStart(2, "0")}`);

export function runEmployee360NumberAuditTests(): void {
  // ── 1. A Training Manager's sessions are every completed report he wrote, a leaver's included ──
  const tm = summarizeTrainingManagerAnalytics(
    [rep("B-1"), rep("B-2")],
    [
      coaching("B-1", "submitted"),
      coaching("B-1", "locked"),
      coaching("B-9", "submitted"), // resigned since: still a session he delivered
      coaching("B-9", "reviewed_by_employee"),
      coaching("B-9", "locked"),
      coaching("B-1", "draft"), // a draft is never a session
    ],
  );
  assert.equal(tm.sessionsDelivered, 5, "the leaver's three sessions count; the draft does not");
  assert.equal(tm.overFocusedCount, 1, "the leaver was coached three times, so he is the one over-focused rep");
  assert.equal(tm.topFocusShare, 1, "five sessions, all on the top five reps");
  assert.equal(tm.coachedByTm, 1, "coverage is still measured against today's active reps");
  assert.equal(tm.poolSize, 2);

  // ── 2. Before/after impact: only events whose two spans sit wholly inside what was read ──
  const rows = [
    { date: "2026-08-05", isCampaign: false, customer: "a" },
    { date: "2026-08-05", isCampaign: true, customer: "b" },
    { date: "2026-08-20", isCampaign: false, customer: "c" },
  ];
  const observed = { from: "2026-07-01", to: "2026-10-26" };
  const impact = poolImpact(rows, ["2026-07-10", "2026-08-15", "2026-10-20"], 30, observed);
  assert.equal(impact.eventCount, 1, "July 10 has no whole 30 days before it, October 20 no 30 days after it");
  assert.equal(impact.before.sampleVisits, 2, "the 30 days before 15 August");
  assert.equal(impact.after.sampleVisits, 1, "the 30 days after it");
  assert.equal(impact.before.distinctCustomers, 2);
  assert.equal(impact.after.distinctCustomers, 1);

  const quiet = poolImpact([], ["2026-08-15"], 30, observed);
  assert.equal(quiet.eventCount, 1);
  assert.equal(quiet.before.distinctCustomers, null, "no visit in the span is no data, never zero customers");
  assert.equal(quiet.after.visitsPerActiveDay, null);

  // ── 3. Double-visit history counts a partner with no HR id, and accounts for every visitor ──
  const visits: VisitRow[] = [
    visit({ double_crm_id: 501, double_hr_id: "A-1", double_name: "Dina Hamdy" }),
    visit({ double_crm_id: 777, double_hr_id: null, double_name: "Unmatched Manager", visit_date: "2026-10-13" }),
    visit({ double_crm_id: 777, double_hr_id: null, double_name: "Unmatched Manager", visit_date: "2026-10-14" }),
  ];
  for (let i = 0; i < 11; i += 1) {
    visits.push(visit({ double_crm_id: 900 + i, double_hr_id: `X-${i}`, double_name: `Visitor ${i}`, visit_date: "2026-10-15" }));
  }
  const history = buildDoubleVisitHistory(visits, new Set(), new Map(), "none");
  assert.equal(history.totalReceived, 14, "the two visits with an unresolved partner are counted");
  assert.equal(history.distinctVisitors, 13);
  assert.equal(history.byVisitor[0].hrId, "crm:777", "keyed by his CRM id, so his two visits are one visitor");
  assert.equal(history.byVisitor[0].count, 2);
  assert.equal(history.byVisitor.length, 10);
  assert.deepEqual(history.otherVisitors, { people: 3, visits: 3 }, "the visitors past the top ten are named as a count");
  assert.equal(
    history.byVisitor.reduce((n, v) => n + v.count, 0) + history.otherVisitors.visits,
    history.totalReceived,
    "the chips add up to the visits received",
  );

  // ── 4. Expenses say where the record stops ──
  assert.equal(expenseRecordedUntilNote([{ month: "2026-08" }, { month: "2026-10" }], "2026-10-27"), null);
  assert.match(
    expenseRecordedUntilNote([{ month: "2026-07" }, { month: "2026-08" }], "2026-10-27") ?? "",
    /No claim is recorded after .*Aug/,
  );
  assert.equal(expenseRecordedUntilNote([], "2026-10-27"), null, "no claim at all is the empty state, not this note");

  // ── 5. A Product Manager's family months with sales but no published closing are named ──
  const window = {
    rows: [
      achievement({ period: "2026-07", productCode: "SA001" }),
      achievement({ period: "2026-10", productCode: "SA001" }),
      achievement({ period: "2026-10", productCode: "SA999" }),
    ],
    publishedKeys: new Set(["cns|2026-07"]),
    productFamilies: new Map([
      ["SA001", "Neuro"],
      ["SA999", "Other Family"],
    ]),
  };
  assert.deepEqual(unpublishedEmployee360FamilyPeriods(window, ["neuro"], "Super Admin"), ["2026-10"]);
  assert.deepEqual(unpublishedEmployee360FamilyPeriods(window, [], "Super Admin"), [], "no family, no months");

  // ── 6. The screen draws what the figures mean ──
  const view = stripComments(readFileSync("src/components/employee-360/employee-360-view.tsx", "utf8"));
  assert.match(view, /otherVisitors\.people > 0/, "the more-visitors chip is drawn");
  assert.match(view, /previousMonthKey\(/, "month-on-month compares with the calendar month before, never the previous row");
  const visitsCard = view.slice(view.indexOf("Visits & Coverage"), view.indexOf("Check-in Timing"));
  assert.match(visitsCard, /Visit split \(self-reported\)/, "the AM · PM · Pharmacies split sits in the visits card, read with or without GPS");

  // ── 7. Cost / visit and Expenses vs sales stop at the last recorded claim month ──
  const lagging = expenseEfficiencyOf({
    totalCost: 700,
    expenseMonthly: months(2, 8).map((month) => ({ month, cost: 100 })), // claims February to August
    visitMonthly: months(2, 10).map((month) => ({ month, regular: 8, campaign: 2 })), // visits run on to October
    salesMonthly: months(7, 9).map((month) => ({ month, sales: 1000 })),
    salesMonths: { from: "2026-07", to: "2026-09" },
    windowTo: "2026-10-27",
  });
  assert.equal(lagging.costPerVisit, 10, "700 over the 70 visits to August — never over the 90 to October");
  assert.equal(lagging.claimsThrough, "2026-08", "the tile names the month the claims stop");
  assert.deepEqual(lagging.matchedMonths, { from: "2026-07", to: "2026-08" }, "September's sales carry no claim, so they are left out");
  assert.equal(lagging.matchedSalesValue, 2000);
  assert.equal(lagging.expenseToSalesPct, 10, "July and August's 200 over July and August's 2,000");

  const current = expenseEfficiencyOf({
    totalCost: 300,
    expenseMonthly: months(8, 10).map((month) => ({ month, cost: 100 })),
    visitMonthly: months(8, 10).map((month) => ({ month, regular: 10, campaign: 0 })),
    salesMonthly: months(8, 10).map((month) => ({ month, sales: 1000 })),
    salesMonths: { from: "2026-08", to: "2026-10" },
    windowTo: "2026-10-27",
  });
  assert.equal(current.claimsThrough, null, "claims that reach the period's last month need no note");
  assert.equal(current.costPerVisit, 10);
  assert.equal(current.expenseToSalesPct, 10);

  const noClaims = expenseEfficiencyOf({
    totalCost: 0,
    expenseMonthly: [],
    visitMonthly: months(8, 10).map((month) => ({ month, regular: 10, campaign: 0 })),
    salesMonthly: months(8, 10).map((month) => ({ month, sales: 1000 })),
    salesMonths: { from: "2026-08", to: "2026-10" },
    windowTo: "2026-10-27",
  });
  assert.deepEqual(noClaims, { costPerVisit: null, claimsThrough: null, expenseToSalesPct: null, matchedSalesValue: null, matchedMonths: null });

  const claimsBeforeSales = expenseEfficiencyOf({
    totalCost: 200,
    expenseMonthly: months(2, 3).map((month) => ({ month, cost: 100 })),
    visitMonthly: months(2, 10).map((month) => ({ month, regular: 10, campaign: 0 })),
    salesMonthly: months(7, 9).map((month) => ({ month, sales: 1000 })),
    salesMonths: { from: "2026-07", to: "2026-09" },
    windowTo: "2026-10-27",
  });
  assert.equal(claimsBeforeSales.expenseToSalesPct, null, "no month holds both a claim and a sale: no figure, never 0%");
  assert.equal(claimsBeforeSales.matchedMonths, null);

  // ── 8. A leader's visit is in AM, PM or Pharmacies — exactly one (owner: "AM ALONE PM ALONE PHARMACIES ALONE") ──
  const leader = leaderVisitFigures([
    managerVisit({ listType: "PM", pharmacyName: "El Ezaby Pharmacy" }), // a doctor's visit naming a pharmacy: PM only
    managerVisit({ listType: "AM", bucket: "AM" }),
    managerVisit({ listType: "Pharmacy", pharmacyName: "Seif Pharmacy" }), // a pharmacy-list visit: Pharmacies only
    managerVisit({ kind: "chain", listType: "PM", awaitingValidation: true }),
    managerVisit({ source: "own", kind: "single", listType: null, bucket: "AM" }), // his own list: the half decides
    managerVisit({ source: "own", kind: "single", listType: "Pharmacy", pharmacyName: "Seif Pharmacy" }),
  ]);
  assert.deepEqual(leader.rideSplit, { am: 1, pm: 1, pharmacies: 1 }, "the pharmacy named on a doctor's visit is never added to Pharmacies");
  assert.equal(leader.rideAwaitingValidation, 1);
  assert.equal(
    leader.rideSplit.am + leader.rideSplit.pm + leader.rideSplit.pharmacies + leader.rideAwaitingValidation,
    leader.rides.doubles + leader.rides.chains + leader.rides.productManagerVisits,
    "AM + PM + Pharmacies + awaiting validation is every ride-along, once",
  );
  assert.deepEqual(leader.ownSingle, { visits: 2, split: { am: 1, pm: 0, pharmacies: 1 } });

  // ── 9. A team wider than 15 territories reads the 15 most visited, and says so ──
  const seats = Array.from({ length: 20 }, (_, i) => ({ seatId: `s${i}`, name: `Territory ${i}` }));
  const seatVisits = new Map(seats.map((seat, i) => [seat.seatId, i] as const));
  seatVisits.set("s5", 30);
  seatVisits.set("s6", 30);
  seatVisits.delete("s19"); // no visit this month
  const busiest = busiestTerritories(seats, seatVisits, 15);
  assert.deepEqual(
    busiest.map((seat) => seat.seatId),
    ["s5", "s6", "s18", "s17", "s16", "s15", "s14", "s13", "s12", "s11", "s10", "s9", "s8", "s7", "s4"],
    "most visited first; a tie keeps the team's order",
  );
  const small = busiestTerritories(seats.slice(15), seatVisits, 15);
  assert.deepEqual(small.map((seat) => seat.seatId), ["s18", "s17", "s16", "s15", "s19"], "a team inside the cap is read whole; no visit comes last");

  const gradeSettings = { gradeTargets: { PM: { A: 3, B: 2, C: 1 }, AM: { A: 1, B: null, C: null } } };
  const doctor = (id: string) => customerFrequencyRow({ customerId: id, name: `Dr ${id}`, listType: "PM", grade: "A", visits: 2, planned: 2 }, gradeSettings);
  const wide = shapeFrequency({
    month: "2026-10",
    inProgress: true,
    reports: Array.from({ length: 15 }, (_, i) => ({ rows: [doctor(String(i))], awaitingValidation: 0, leaveUnread: false })),
    teamTerritories: 20,
  });
  if (wide.state !== "data") throw new Error("expected frequency data for the wide team");
  assert.equal(wide.value.territories, 15);
  assert.equal(wide.value.teamTerritories, 20, "the section knows it read 15 of the team's 20");
  const whole = shapeFrequency({ month: "2026-10", inProgress: true, reports: [{ rows: [doctor("1")], awaitingValidation: 0, leaveUnread: false }] });
  if (whole.state !== "data") throw new Error("expected frequency data");
  assert.equal(whole.value.teamTerritories, whole.value.territories, "a team read whole is its own count");

  // ── 10. The screens and the loader carry it through ──
  assert.match(view, /expenseVsSalesMonths/, "the Expenses vs sales tile names the months it compares");
  assert.match(view, /claimsThrough/, "the Cost / visit tile names the month the claims stop");
  const sections = stripComments(readFileSync("src/components/employee-360/crm-insights-sections.tsx", "utf8"));
  assert.match(sections, /value\.teamTerritories > value\.territories/, "the frequency section says when it read part of the team");
  const insights = stripComments(readFileSync("src/lib/employee-360/crm-insights.ts", "utf8"));
  assert.doesNotMatch(insights, /CRM_FREQUENCY_MAX_TERRITORIES\)\s*return \{ state: "empty" \}/, "a wide team is never dropped");
  assert.match(insights, /busiestTerritories\(\s*team,/, "a wide team is ranked before it is read");
  const reportsSource = stripComments(readFileSync("src/lib/phoenix-crm/server/reports.ts", "utf8"));
  const ranking = reportsSource.slice(
    reportsSource.indexOf("export async function countValidatedVisitsBySeat"),
    reportsSource.indexOf("export async function loadCustomerFrequencyReport"),
  );
  assert.match(ranking, /\.select\("id, seat_id"\)/, "the ranking read is one light column");
  assert.match(ranking, /\.eq\("customer_validated", true\)/, "it ranks by the visits the Frequency report counts");
}
