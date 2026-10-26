import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeCallRate, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";
import type { CheckinForMatch } from "../src/lib/crm/checkin-match.ts";
import { kpiIndexOf } from "../src/lib/crm/kpi-index.ts";
import {
  buildKpiPodium,
  joinKpiRows,
  stampKpiJustStarted,
  sumKpiTeamTotals,
  type KpiDirectoryEntry,
  type KpiRepRow,
} from "../src/lib/crm/kpis-board.ts";
import { KPI_EXPORT_MARKERS } from "../src/lib/crm/kpis-board-workbook.ts";
import {
  amBandOf,
  coverageBandOf,
  kpiFlagsOf,
  kpiJustStartedOf,
  pmBandOf,
} from "../src/lib/crm/kpis-filters.ts";
import { buildKpiManagerRows, kpiRepMeasures } from "../src/lib/crm/kpis-manager-rows.ts";

// OWNER, 2026-10-26 — the KPIs Summary, as the Pedia National Sales Manager saw it for October: a
// medical rep hired on the 24th, two working days in, read "Never reached a planned doctor", "Logged
// no calls at all", "0% · 0 of 70 planned doctors · Below floor · 95%" and a 0% overall. Her 70
// planned doctors sat in the team's coverage denominator and her 0% in her district manager's
// average. And every rep on the older rules was measured over the TEAM's days: she read "0 of 34 AM
// asked for" over 17 days she had not been employed for.
//
// The fix: each rep is measured over her own employed days (rule 4, which the Phoenix rules already
// apply), and a rep hired inside the window who has worked under a third of it — the board's own
// KPI_VERDICT_THRESHOLD, through isTooEarlyToScore — is shown as just started and judged by nothing.

// 2026-08-01 is a Saturday, so 1–26 August is four Sat–Wed weeks: 20 working days.
const WINDOW = { dateFrom: "2026-08-01", dateTo: "2026-08-26" };
const COMPANY = { kind: "company", basis: "company", label: "test" } as const;

function visit(crmId: number, contact: number, day: string, ampm = "PM"): VisitForCallRate {
  return {
    agent_crm_id: crmId,
    agent_hr_id: `AI-000${crmId}`,
    agent_name: `Rep ${crmId}`,
    ampm,
    comment: null,
    contact_crm_id: contact,
    crm_save_date: `${day}T11:00:00`,
    speciality: null,
    visit_date: day,
    visit_type: 0,
    visit_type_description: "Regular Visit",
  };
}

function checkin(crmId: number, contact: number, day: string): CheckinForMatch {
  return { agent_crm_id: crmId, contact_crm_id: contact, check_date: `${day}T10:55:00` };
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

// Rep 1 — employed throughout, forty proved PM visits.
// Rep 2 — hired Tuesday the 25th: two working days in, one proved PM visit. The defect's case.
// Rep 3 — hired Wednesday the 12th: eleven working days in, over a third of twenty, so judged.
const VISITS: VisitForCallRate[] = [
  ...range(101, 40).map((contact) => visit(1, contact, "2026-08-02")),
  visit(2, 201, "2026-08-25"),
  ...range(301, 5).map((contact) => visit(3, contact, "2026-08-16")),
];
const CHECKINS: CheckinForMatch[] = [
  ...range(101, 40).map((contact) => checkin(1, contact, "2026-08-02")),
  checkin(2, 201, "2026-08-25"),
  ...range(301, 5).map((contact) => checkin(3, contact, "2026-08-16")),
];

const MANAGER: KpiDirectoryEntry = {
  hrId: "AI-0009",
  displayName: "District Manager",
  lineName: "Pedia",
  regionName: null,
  areaName: null,
  managerName: null,
  managerHrId: null,
  jobTitle: "Senior District Manager",
  hireDate: "2019-01-01",
};
const directoryEntry = (crmId: number, hireDate: string): KpiDirectoryEntry => ({
  hrId: `AI-000${crmId}`,
  displayName: `Rep ${crmId}`,
  lineName: "Pedia",
  regionName: null,
  areaName: null,
  managerName: MANAGER.displayName,
  managerHrId: MANAGER.hrId,
  jobTitle: "Medical Representative",
  hireDate,
});
const DIRECTORY: KpiDirectoryEntry[] = [
  MANAGER,
  directoryEntry(1, "2020-01-01"),
  directoryEntry(2, "2026-08-25"),
  directoryEntry(3, "2026-08-12"),
];

function rowOf(rows: readonly KpiRepRow[], crmId: number): KpiRepRow {
  const found = rows.find((row) => row.agentCrmId === crmId);
  assert.ok(found, `rep ${crmId} is on the board`);
  return found;
}

/** A plan for the coverage measures, as the doctor lists would have supplied it. */
function plan(row: KpiRepRow, planned: number, visited: number) {
  row.hasMeasurablePlan = true;
  row.plannedDoctors = planned;
  row.visitedDoctors = visited;
  row.coveragePct = Math.round((visited / planned) * 100);
  row.meetsCoverageFloor = row.coveragePct >= 95;
}

export function runKpisNewHireTests() {
  // ── 1. The rule itself: under a third of the window, hired inside it ──────────────────────────
  assert.deepEqual(
    kpiJustStartedOf({ hireDate: "2026-10-24", dateFrom: "2026-10-01", workingDaysIn: 2, workingDaysInWindow: 20 }),
    { workingDaysIn: 2 },
    "two working days of twenty is just started",
  );
  assert.equal(
    kpiJustStartedOf({ hireDate: "2026-10-11", dateFrom: "2026-10-01", workingDaysIn: 11, workingDaysInWindow: 20 }),
    null,
    "eleven of twenty is over a third, so she is judged",
  );
  assert.equal(
    kpiJustStartedOf({ hireDate: "2026-10-01", dateFrom: "2026-10-01", workingDaysIn: 1, workingDaysInWindow: 20 }),
    null,
    "a rep employed from the first day shares the team's calendar and is the team gate's business",
  );
  assert.equal(
    kpiJustStartedOf({ hireDate: "2019-03-01", dateFrom: "2026-10-01", workingDaysIn: 0, workingDaysInWindow: 20 }),
    null,
  );
  assert.deepEqual(
    kpiJustStartedOf({ hireDate: "2026-10-26", dateFrom: "2026-10-01", workingDaysIn: 0, workingDaysInWindow: 20 }),
    { workingDaysIn: 0 },
    "hired today, no working day in yet, is just started too",
  );

  // ── 2. Each rep is measured over HER OWN employed days ─────────────────────────────────────────
  const report = computeCallRate(VISITS, CHECKINS, { ...WINDOW, basis: "verified" });
  assert.equal(report.workingDays, 20, "the team's window holds twenty working days");
  const rows = joinKpiRows({
    callRates: report.reps,
    docLists: [],
    scope: COMPANY,
    workingDays: report.workingDays,
    amTarget: 2,
    pmTarget: 10,
    basis: report.basis,
    directory: DIRECTORY,
    employedWindow: WINDOW,
  });
  const veteran = rowOf(rows, 1);
  const newHire = rowOf(rows, 2);
  const joiner = rowOf(rows, 3);
  assert.equal(veteran.workingDays, 20, "a rep employed throughout keeps the team's days");
  assert.equal(newHire.workingDays, 2, "hired on the 25th: the 25th and the 26th, never the team's 20");
  assert.equal(newHire.workingDays * 2, 4, "so AM asks her for 4, not 40");
  assert.equal(newHire.workingDays * 10, 20, "and PM for 20, not 200");
  assert.equal(newHire.pmRate, 0.5, "one proved PM visit over her two days");
  assert.equal(newHire.pmAttainmentPct, 5, "one of the twenty PM visits asked of her");
  assert.equal(joiner.workingDays, 11, "hired on the 12th: eleven working days");
  assert.equal(joiner.pmAttainmentPct, 5, "five of the 110 asked of her, never five of 200");

  // ── 3. Stamped just started; every verdict leaves her row ─────────────────────────────────────
  plan(veteran, 100, 80);
  plan(newHire, 70, 0);
  plan(joiner, 50, 30);
  stampKpiJustStarted(rows, { dateFrom: WINDOW.dateFrom, workingDaysInWindow: 20 });
  assert.deepEqual(newHire.justStarted, { workingDaysIn: 2 });
  assert.equal(joiner.justStarted, null, "eleven of twenty days in is judged like everybody else");
  assert.equal(veteran.justStarted, null);
  assert.deepEqual(
    kpiFlagsOf(newHire),
    ["just-started"],
    "no 'Never reached a planned doctor', no 'Logged no calls at all' — one plain flag",
  );
  assert.equal(newHire.meetsCoverageFloor, null, "no 'Below floor · 95%' two working days in");
  assert.equal(coverageBandOf(newHire), "noplan");
  assert.equal(amBandOf(newHire), "noplan");
  assert.equal(pmBandOf(newHire), "noplan");
  assert.ok(kpiFlagsOf(joiner).includes("below-coverage-floor"), "the judged joiner keeps her real verdicts");

  const overall = kpiIndexOf({ ...newHire, justStarted: Boolean(newHire.justStarted) });
  assert.equal(overall.overallPct, null, "no 0% overall");
  assert.ok(
    overall.components.every((component) => component.excludedBecause === "just started"),
    "every measure says why it left the average",
  );
  assert.equal(KPI_EXPORT_MARKERS.justStarted, "Just started", "the export prints the board's words");

  // ── 4. Her plan never drags the team down ──────────────────────────────────────────────────────
  const totals = sumKpiTeamTotals(rows);
  assert.equal(totals.reps, 3, "she is still a head on the team");
  assert.equal(totals.plannedDoctors, 150, "her 70 planned doctors leave the coverage denominator");
  assert.equal(totals.visitedDoctors, 110);
  assert.equal(totals.repWorkingDays, 31, "and her two days leave the call-rate denominator");

  // ── 5. She is never ranked ─────────────────────────────────────────────────────────────────────
  const ranked = rows.map((row) => (row === newHire ? { ...row, coveragePct: 100, visitedDoctors: 70 } : row));
  const podium = buildKpiPodium(ranked);
  for (const [measure, entries] of Object.entries(podium)) {
    assert.ok(
      entries.every((entry: { repName: string }) => entry.repName !== "Rep 2"),
      `${measure}: a rep too new to judge is never on a podium`,
    );
  }

  // ── 6. Her manager's average is his judged reps only ───────────────────────────────────────────
  const measures = kpiRepMeasures(newHire);
  assert.ok(
    Object.values(measures).every((value) => value == null),
    "she adds nothing to any average above her",
  );
  const managers = buildKpiManagerRows({ reps: rows, directory: DIRECTORY });
  const manager = managers.find((row) => row.name === "District Manager");
  assert.ok(manager, "the district manager has a row");
  assert.equal(manager.coveragePct, 70, "the mean of 80% and 60% — her 0% is not in it");

  // ── 7. The footer's words (owner, 2026-10-26) ──────────────────────────────────────────────────
  const view = readFileSync(new URL("../src/components/crm/kpis-board-view.tsx", import.meta.url), "utf8");
  assert.ok(
    !view.includes("nothing on this board blends"),
    "the footer no longer claims nothing blends the measures — the Overall KPI does",
  );
  assert.ok(view.includes("{footerDay(board.asOf)}"), "coverage's end date prints as a human date");
  assert.ok(view.includes("${footerDay(board.range.dateTo)}"), "and so does the call rate's");
}
