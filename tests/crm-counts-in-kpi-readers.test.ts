import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyVisitFilter, type VisitFilterableQuery } from "../src/lib/crm/reads.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * 🔴 TWO KINDS OF READER, ONE DOOR (owner, 7 Nov 2026; risk review the same day).
 *
 * crm_visits_unified serves every old iReports360 row it served before the conversion — a campaign visit, an
 * old visit in the visits archive and an old visit copied into Phoenix CRM included — because the deductions,
 * the half-day and holiday-bridge rules, attendance, outstation, Field Workforce Compliance and the resignation
 * check read it as proof a person WORKED that day. Dropping those rows would turn worked days into absences and
 * deductions. Instead the door marks them: `counts_in_kpi` is false for a row that must count in no visit
 * figure (20261107044059, section 8).
 *
 * So the rule has two halves, and this file pins both:
 *   - every reader that COUNTS visits passes `kpiOnly: true` (KPIs, call rate, the reps list, Employee 360,
 *     double-visit analytics), so nothing retired or copied is counted, and nothing twice;
 *   - no reader that asks "did he work that day" ever passes it or names the column.
 */

type Call = [method: string, ...args: unknown[]];

function recordingQuery(calls: Call[]): VisitFilterableQuery {
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  const query: VisitFilterableQuery = {
    eq: record("eq"),
    gte: record("gte"),
    ilike: record("ilike"),
    in: record("in"),
    is: record("is"),
    lte: record("lte"),
    neq: record("neq"),
    not: record("not"),
    or: record("or"),
  };
  return query;
}

const read = (path: string): string => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

/** Every reader that counts visits, and how many of its door reads pass kpiOnly. */
const KPI_READERS: Record<string, number> = {
  "src/lib/crm/phoenix-kpi-data.ts": 1,
  "src/lib/crm/rep-kpi-reports-data.ts": 1,
  "src/lib/crm/call-rate-service.ts": 1,
  "src/lib/crm/reps-list-activity-data.ts": 1,
  // The Marketing Field Visit Feedback prefill: its AM · PM · Pharmacies figures are clinic counts.
  "src/lib/marketing-functions/service.ts": 1,
  // The person's own record and an earlier record of a re-hired person; both feed the visit mix and counts.
  "src/lib/employee-360/service.ts": 2,
  // The coaching impact's productive visits, and the double visits a leader conducted.
  "src/lib/employee-360/deep-service.ts": 2,
  // Four screens that counted every row until the sweep of 11 Nov 2026 (Marian Samir read 36 on the KPIs board
  // and up to 250 on these): SFE Doctor Coverage (its regular read; its campaign read is a separate question),
  // SFE Field Analytics, Early Birds, and the rep visits drill-down the call rate links to.
  "src/lib/crm/sfe-doctor-coverage.ts": 1,
  "src/lib/crm/sfe-field-analytics.ts": 1,
  "src/lib/early-birds/collect.ts": 1,
  "src/lib/crm/rep-visits-data.ts": 1,
};

/** The readers that keep visits to unvalidated customers under kpiOnly, because they mark them and say so. */
const KEEPS_AWAITING_VALIDATION = new Set(["src/lib/crm/call-rate-service.ts", "src/lib/crm/rep-visits-data.ts"]);

/**
 * Every reader that reads the door as proof of a WORKED day. A row it loses is a day it calls an absence,
 * so none of them may filter the KPI mark. Field Activity is one: it decides what an empty day means beside
 * the payable outstation expenses (field-activity/report.ts).
 */
const WORKED_DAY_READERS = [
  "src/lib/deductions/connectors/crm.ts",
  "src/lib/deductions/connectors/dsm-no-record.ts",
  "src/lib/deductions/connectors/half-day.ts",
  "src/lib/deductions/connectors/holiday-bridge.ts",
  "src/lib/deductions/connectors/vacation.ts",
  "src/lib/deductions/half-day-rule.ts",
  "src/lib/deductions/phoenix-worked-days.ts",
  "src/lib/deductions/proven-worked-days.ts",
  "src/lib/attendance/crm-day-maps.ts",
  "src/lib/crm/visit-workload.ts",
  "src/lib/crm/visit-partners.ts",
  "src/lib/outstation/expense-claim-validation.ts",
  "src/lib/field-workforce-compliance/ireports360-source.ts",
  "src/lib/resignations/crm-work-after-date.ts",
  "src/lib/field-activity/report.ts",
  "src/lib/field-absence/server/evidence.ts",
];

export function runCrmCountsInKpiReadersTests(): void {
  // ── The filter itself ──
  const kpiCalls: Call[] = [];
  applyVisitFilter(recordingQuery(kpiCalls), { dateFrom: "2026-10-01", dateTo: "2026-10-31", kpiOnly: true }, "");
  assert.deepEqual(
    kpiCalls.filter(([method]) => method === "eq"),
    [["eq", "counts_in_kpi", true]],
    "kpiOnly keeps only the rows the door marks as counting",
  );
  // 🔴 "not counted in kpis till validated" (owner, 2026-10-01): kpiOnly also leaves out a Phoenix visit to a
  // customer not validated yet, and keeps every vendor row and day activity (they carry null, never false).
  assert.deepEqual(
    kpiCalls.filter(([method]) => method === "not"),
    [["not", "phoenix_customer_validated", "is", false]],
    "kpiOnly leaves out a visit to a customer not validated yet — 531 November visits counted on the KPIs board on 11 Nov 2026",
  );
  const awaitingCalls: Call[] = [];
  applyVisitFilter(
    recordingQuery(awaitingCalls),
    { dateFrom: "2026-10-01", dateTo: "2026-10-31", keepAwaitingValidation: true, kpiOnly: true },
    "",
  );
  assert.ok(
    !awaitingCalls.some((call) => call.includes("phoenix_customer_validated")),
    "keepAwaitingValidation keeps them, for the one reader that drops them itself and says how many wait",
  );
  for (const [path] of Object.entries(KPI_READERS)) {
    const uses = read(path).split("keepAwaitingValidation: true").length - 1;
    assert.equal(
      uses,
      KEEPS_AWAITING_VALIDATION.has(path) ? 1 : 0,
      `${path}: only the call rate and its drill-down keep visits to unvalidated customers (the rate leaves them out itself, callRateExclusionOf, and the drill-down marks them not scored)`,
    );
  }
  const plainCalls: Call[] = [];
  applyVisitFilter(recordingQuery(plainCalls), { dateFrom: "2026-10-01", dateTo: "2026-10-31" }, "");
  assert.ok(
    !plainCalls.some((call) => call.includes("counts_in_kpi")),
    "without kpiOnly every row is served — the worked-day readers' default",
  );

  // ── The counting readers filter it ──
  for (const [path, expected] of Object.entries(KPI_READERS)) {
    const code = read(path);
    assert.equal(code.split("kpiOnly: true").length - 1, expected, `${path}: every visit count reads only the rows that count (kpiOnly: true)`);
  }

  // ── The worked-day readers never do ──
  for (const path of WORKED_DAY_READERS) {
    const code = read(path);
    assert.doesNotMatch(code, /kpiOnly|counts_in_kpi/, `${path} reads the door as proof of a worked day: it must keep every row, never filter counts_in_kpi`);
  }

  // ── And the range scanners those readers use cannot take it at all ──
  const reads = read("src/lib/crm/reads.ts");
  for (const declaration of [
    "export async function scanVisitsForRange<",
    "export async function scanVisitsForRangeIncludingDeparted<",
    "export async function scanVisitsForRangeCreditingPartners<",
  ]) {
    const start = reads.indexOf(declaration);
    assert.ok(start >= 0, `${declaration} is where it was`);
    const end = reads.indexOf("\nexport ", start + declaration.length);
    assert.doesNotMatch(reads.slice(start, end), /kpiOnly|counts_in_kpi/, `${declaration} serves every row: the deductions and attendance read through it`);
  }
  // The double-visit loader counts by default, and outstation TRIP evidence (money) opts out of it.
  const doubleVisit = read("src/lib/double-visit-analytics/service.ts");
  assert.match(doubleVisit, /kpiOnly: options\?\.kpiOnly \?\? true,/, "the double-visit board counts only the rows that count by default");
  const tripEvidence = doubleVisit.slice(doubleVisit.indexOf("export async function getDoubleVisitExpenseWorkloadEvidence("));
  assert.match(
    tripEvidence.slice(0, tripEvidence.indexOf("\nexport ")),
    /getLiveDoubleVisitRows\(start, end, employees, \{ kpiOnly: false \}\)/,
    "outstation trip evidence decides money: it reads every worked row, never only the KPI-counted ones",
  );
  // queryOwnVisitsOfDepartedAgents passes it only when its caller asks (Employee 360) — never by default.
  const departed = reads.slice(reads.indexOf("export async function queryOwnVisitsOfDepartedAgents<"));
  assert.match(departed.slice(0, departed.indexOf("\nexport ")), /kpiOnly: options\.kpiOnly,/, "an earlier record's visits count only when the caller counts");
}
