import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { CoachingReportSummaryRow } from "../src/lib/coaching/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { buildDoubleVisitHistory, expenseRecordedUntilNote, poolImpact } from "../src/lib/employee-360/deep-service.ts";
import { unpublishedEmployee360FamilyPeriods } from "../src/lib/employee-360/sales-canonical.ts";
import type { VisitRow } from "../src/lib/employee-360/service.ts";
import { summarizeTrainingManagerAnalytics } from "../src/lib/employee-360/tm-analytics.ts";
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
 * - a Product Manager's months with no published closing vanished instead of being named.
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
}
