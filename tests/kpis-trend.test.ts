import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { KpiRepRow } from "../src/lib/crm/kpis-board.ts";
import { buildKpisQuery, EMPTY_KPI_FILTERS } from "../src/lib/crm/kpis-filters.ts";
import { KPI_TABS, resolveKpiTab } from "../src/lib/crm/kpis-tabs.ts";
import {
  consolidateKpiRows,
  kpiTrendCell,
  kpiTrendPlan,
  kpiTrendSumsOfRow,
  sumKpiTrend,
} from "../src/lib/crm/kpis-trend.ts";
import {
  KPI_TREND_METRICS,
  KPI_TREND_PARAMS,
  KPI_TREND_SCALES,
  resolveKpiTrendMetric,
  resolveKpiTrendScale,
} from "../src/lib/crm/kpis-trend-options.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * KPIs board — the Weekly tab (owner, 2026-09-22): call rate, coverage and frequency week by week
 * beside the month they add up to, or month by month beside the quarter or semester.
 *
 * "For example, we are week three now in September, so I appear week one, week two, week three, and
 * the total consolidated month of those three. So I can identify."
 *
 * Every week and month on the tab is one ordinary getKpisBoard, so its numbers are the ones the rest
 * of the board is already tested for. What is NEW, and what each check below pins, is:
 *
 *   1. WHICH columns appear — only what has begun, and a month total that ends where the last begun
 *      week ends. A column of blanks for week 5 on the 22nd, or a total divided by days nobody has
 *      reached, would both read as a bad month rather than a bug.
 *   2. THE SUMS — a quarter is its calls over its days, never the average of three percentages, and
 *      AM, PM and pharmacy stay three figures (owner, 2026-09-04: "Don't never get average").
 *   3. RULING A1 across a sum — a month with no GPS feed leaves its calls AND its days out together.
 *   4. The URL — the tab's two switches ride only on that tab, and leaving it drops them.
 *   5. The house rules on the new tables — fits the screen, square corners, cards on a phone.
 */

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/** A complete row, so each check varies exactly the field it is about. */
function row(overrides: Partial<KpiRepRow> = {}): KpiRepRow {
  return {
    agentCrmId: 1,
    agentHrId: "a-1",
    repName: "Rep One",
    lineName: "Pedia",
    regionName: "Giza",
    areaName: "GZ3",
    managerName: "Manager One",
    jobTitle: "Medical Rep",
    workingDays: 5,
    amVerified: 8,
    pmVerified: 45,
    amRate: 1.6,
    pmRate: 9,
    amReported: 9,
    pmReported: 47,
    amReportedRate: 1.8,
    pmReportedRate: 9.4,
    totalCalls: 56,
    campaignCalls: 0,
    campaignShare: 0,
    campaignOnlyDays: 0,
    hasCallRate: true,
    noGpsFeed: false,
    amAttainmentPct: 80,
    pmAttainmentPct: 90,
    pharmacyVerified: 3,
    pharmacyRate: 0.6,
    pharmacyReported: 3,
    pharmacyReportedRate: 0.6,
    pharmacyAttainmentPct: null,
    plannedDoctors: 40,
    visitedDoctors: 38,
    missedDoctors: 2,
    coveragePct: 95,
    meetsCoverageFloor: true,
    onPlanDoctors: 30,
    underDoctors: 10,
    overDoctors: 0,
    frequencyPct: 75,
    hasMeasurablePlan: true,
    plannedCalls: 60,
    plannedCallsToDate: 60,
    actualCalls: 56,
    offPlanDoctors: 1,
    plannedAccounts: 2,
    gradeA: 10,
    gradeB: 20,
    gradeC: 10,
    underPlannedVsGrade: 0,
    phoenix: null,
    ...overrides,
  };
}

/** A Phoenix-rules row: frequency divides by the GRADED doctors, not the planned ones (rule 7). */
function phoenixRow(overrides: Partial<KpiRepRow> & { judged: number }): KpiRepRow {
  const { judged, ...rest } = overrides;
  return row({
    ...rest,
    phoenix: { frequency: { judged, met: 0, below: 0, ungraded: 0, pct: null } } as unknown as KpiRepRow["phoenix"],
  });
}

const read = (path: string) => readFileSync(path, "utf8");

/** The source with its comments removed, so a rule is checked against the code and not the prose explaining it. */
const codeOf = (source: string) => stripComments(source);

// ── 1. Which columns appear ───────────────────────────────────────────────────────────────────

export function runKpiTrendPlanTests() {
  // The 22nd of September: weeks 1–4 have begun (the 4th opened today), week 5 (29–30) has not.
  const september = kpiTrendPlan("month", "2026-09", "2026-09-22");
  assert.equal(september.title, "September 2026");
  assert.deepEqual(
    september.columns.map((column) => [column.label, column.span, column.period]),
    [
      ["Week 1", "1–7 Sep", "w1"],
      ["Week 2", "8–14 Sep", "w2"],
      ["Week 3", "15–21 Sep", "w3"],
      ["Week 4", "22–28 Sep", "w4"],
      ["Month", "1–28 Sep", "2026-09-01..2026-09-28"],
    ],
    "the weeks that have begun, then the month through the last of them — never a blank week 5",
  );
  assert.equal(september.running, true, "a total whose last week is still running reads 'so far'");
  assert.deepEqual(
    september.columns.map((column) => column.kind),
    ["week", "week", "week", "week", "total"],
    "the total is always the LAST column",
  );

  // A finished month: all five weeks, and the total is the plain whole month — the Summary tab's
  // own default window, so the two tabs print the same number for it.
  const august = kpiTrendPlan("month", "2026-08", "2026-09-22");
  assert.deepEqual(
    august.columns.map((column) => column.period),
    ["w1", "w2", "w3", "w4", "w5", "month"],
    "every week of a finished month, then the whole month",
  );
  assert.equal(august.columns[5].span, "1–31 Aug");
  assert.equal(august.running, false, "a finished month is a verdict, not 'so far'");

  // The 1st: one week and a total of that week — nothing stretched over days nobody has reached.
  const firstDay = kpiTrendPlan("month", "2026-09", "2026-09-01");
  assert.deepEqual(
    firstDay.columns.map((column) => [column.label, column.period]),
    [
      ["Week 1", "w1"],
      ["Month", "2026-09-01..2026-09-07"],
    ],
  );

  // The quarter and the semester: the months that have begun, then their total, which no single board
  // covers — so it carries no period and is summed from the months before it.
  const quarter = kpiTrendPlan("quarter", "2026-09", "2026-09-22");
  assert.equal(quarter.title, "Q3 2026");
  assert.deepEqual(
    quarter.columns.map((column) => [column.label, column.month, column.period]),
    [
      ["Jul", "2026-07", "month"],
      ["Aug", "2026-08", "month"],
      ["Sep", "2026-09", "month"],
      ["Q3", "2026-09", null],
    ],
  );
  assert.equal(quarter.columns[3].span, "Jul – Sep");

  const semester = kpiTrendPlan("semester", "2026-09", "2026-09-22");
  assert.equal(semester.title, "Semester 2 · 2026");
  assert.deepEqual(
    semester.columns.map((column) => column.label),
    ["Jul", "Aug", "Sep", "S2"],
    "October to December have not begun, so the semester so far is its first three months",
  );
  assert.equal(semester.running, true, "a semester with months still to come is 'so far'");

  const firstHalf = kpiTrendPlan("semester", "2026-03", "2026-09-22");
  assert.deepEqual(
    firstHalf.columns.map((column) => column.label),
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "S1"],
    "a past semester is its six months and its total",
  );
  assert.equal(firstHalf.running, false);

  // Before the CRM's own history there is nothing to show — an empty plan, not six empty columns.
  assert.deepEqual(kpiTrendPlan("quarter", "2025-12", "2026-09-22").columns, []);
  // And a month that has not begun has no column at all.
  assert.deepEqual(kpiTrendPlan("month", "2026-10", "2026-09-22").columns, []);
}

// ── 2 and 3. The sums, and the cell each one prints ───────────────────────────────────────────

export function runKpiTrendSumsTests() {
  const legacy = row({ agentCrmId: 1, workingDays: 5, amVerified: 8, pmVerified: 45, pharmacyVerified: 3 });
  // RULING A1: a rep with no GPS feed. His calls AND his days leave the call-rate sums together; his
  // coverage stays, because a plan and a visit need no check-in.
  const noFeed = row({
    agentCrmId: 2,
    workingDays: 5,
    amVerified: 0,
    pmVerified: 0,
    pharmacyVerified: 0,
    hasCallRate: false,
    noGpsFeed: true,
    plannedDoctors: 20,
    visitedDoctors: 10,
    onPlanDoctors: 5,
  });
  const phoenix = phoenixRow({
    agentCrmId: 3,
    workingDays: 4,
    amVerified: 9,
    pmVerified: 41,
    pharmacyVerified: 1,
    plannedDoctors: 35,
    visitedDoctors: 35,
    onPlanDoctors: 27,
    judged: 30,
  });

  const noFeedSums = kpiTrendSumsOfRow(noFeed);
  assert.equal(noFeedSums.callDays, 0, "a no-GPS row's working days leave the call-rate divisor");
  assert.equal(noFeedSums.noGpsFeedRows, 1);
  assert.equal(noFeedSums.plannedDoctors, 20, "but its coverage stays in");
  const noFeedCell = kpiTrendCell(noFeedSums);
  assert.equal(noFeedCell.noGpsFeed, true, "a cell of only no-GPS rows reads No GPS feed");
  assert.equal(noFeedCell.am.attainmentPct, null, "never a red 0%");
  assert.equal(noFeedCell.coverage.pct, 50);

  assert.equal(kpiTrendSumsOfRow(phoenix).frequencyBase, 30, "the Phoenix rules judge frequency on graded doctors");
  assert.equal(kpiTrendSumsOfRow(legacy).frequencyBase, 40, "the old rules on every planned doctor");

  const team = kpiTrendCell(sumKpiTrend([legacy, noFeed, phoenix].map(kpiTrendSumsOfRow)));
  assert.equal(team.callDays, 9, "5 + 4 days: the no-GPS rep's 5 are out with his calls");
  assert.equal(team.am.verified, 17);
  assert.equal(team.am.attainmentPct, 94, "17 AM calls over 9 days × 2");
  assert.equal(team.pm.attainmentPct, 96, "86 PM calls over 9 days × 10");
  // NOT THE AVERAGE. The legacy rep reached 80% of his AM target and the Phoenix rep 112.5%; their
  // average is 96%. The team did 17 of the 18 AM calls its days asked for, which is 94%.
  const averaged = Math.round((8 / 10 + 9 / 8) * 50);
  assert.equal(averaged, 96);
  assert.notEqual(team.am.attainmentPct, averaged, "the total is calls over days, never an average of percentages");

  // AM, PM and pharmacy stay three figures — no combined rate exists to print.
  assert.deepEqual(
    Object.keys(team.am).sort(),
    ["attainmentPct", "rate", "target", "verified"],
  );
  assert.ok(!("combined" in team) && !("calls" in team), "the cell carries no joined AM+PM figure");
  assert.equal(team.pharmacy.target, null, "pharmacy has no target yet");
  assert.equal(team.pharmacy.attainmentPct, null, "so no percentage");
  assert.equal(team.pharmacy.rate, 4 / 9, "only the raw rate");

  assert.equal(team.coverage.pct, 87, "83 of 95 planned doctors — the no-GPS rep's plan counts");
  assert.equal(team.frequency.base, 90, "40 planned (old rules) + 20 planned (old rules) + 30 graded (Phoenix)");
  assert.equal(team.frequency.pct, 69, "62 of 90");
  assert.equal(team.noGpsFeed, false, "one no-GPS rep does not make the team read No GPS feed");
  assert.equal(team.noGpsFeedRows, 1);

  // Nothing logged is "No calls", not 0%; nothing planned is no percentage, not 0%.
  const silent = kpiTrendCell(kpiTrendSumsOfRow(row({ hasCallRate: false, amVerified: 0, pmVerified: 0 })));
  assert.equal(silent.logged, false);
  assert.equal(silent.am.rate, null);
  assert.equal(silent.am.attainmentPct, null);
  const unplanned = kpiTrendCell(kpiTrendSumsOfRow(row({ plannedDoctors: 0, visitedDoctors: 0, onPlanDoctors: 0 })));
  assert.equal(unplanned.coverage.pct, null);
  assert.equal(unplanned.frequency.pct, null);
}

// ── A rep's months, consolidated into one row ─────────────────────────────────────────────────

export function runKpiTrendConsolidateTests() {
  const july = row({ workingDays: 22, amVerified: 40, pmVerified: 200, plannedDoctors: 100, visitedDoctors: 90, onPlanDoctors: 80 });
  // August had no GPS feed (ruling A1): its 21 days leave with its calls.
  const august = row({
    workingDays: 21,
    amVerified: 0,
    pmVerified: 0,
    hasCallRate: false,
    noGpsFeed: true,
    plannedDoctors: 100,
    visitedDoctors: 60,
    onPlanDoctors: 50,
  });
  const september = row({
    workingDays: 12,
    amVerified: 30,
    pmVerified: 130,
    plannedDoctors: 60,
    visitedDoctors: 60,
    onPlanDoctors: 50,
    areaName: "GZ4",
  });

  const quarter = consolidateKpiRows([july, august, september]);
  assert.equal(quarter.workingDays, 34, "22 + 12 — August's no-GPS days are out with its calls");
  assert.equal(quarter.amVerified, 70);
  assert.equal(quarter.amAttainmentPct, 103, "70 AM calls over 34 days × 2");
  assert.equal(quarter.pmAttainmentPct, 97, "330 PM calls over 34 days × 10");
  assert.equal(quarter.pharmacyAttainmentPct, null, "no pharmacy target, no percentage");
  assert.equal(quarter.plannedDoctors, 260, "coverage keeps every month's plan, August's included");
  assert.equal(quarter.coveragePct, 81, "210 of 260");
  assert.equal(quarter.meetsCoverageFloor, false);
  assert.equal(quarter.frequencyPct, 69, "180 of 260");
  assert.equal(quarter.noGpsFeed, false, "one no-GPS month does not blank a quarter the other months scored");
  assert.equal(quarter.areaName, "GZ4", "identity is where he sits NOW — the latest month");
  assert.equal(quarter.phoenix, null, "a running month's daily follow-up has no meaning over three");

  // The quarter's row and the quarter's cell are the same numbers — the row decides the filters, the
  // cell is what the table prints, and a disagreement would list a rep under a band his cell denies.
  const cell = kpiTrendCell(sumKpiTrend([july, august, september].map(kpiTrendSumsOfRow)));
  assert.equal(cell.am.attainmentPct, quarter.amAttainmentPct);
  assert.equal(cell.pm.attainmentPct, quarter.pmAttainmentPct);
  assert.equal(cell.coverage.pct, quarter.coveragePct);
  assert.equal(cell.frequency.pct, quarter.frequencyPct);

  const allDark = consolidateKpiRows([august, august]);
  assert.equal(allDark.noGpsFeed, true, "a span with no feed in any month reads No GPS feed");
  assert.equal(allDark.amAttainmentPct, null, "and never 0%");

  assert.throws(() => consolidateKpiRows([]), "an empty list is a programming error, not an empty rep");
}

// ── 4. The tab and its URL ────────────────────────────────────────────────────────────────────

export function runKpiTrendUrlTests() {
  assert.ok(KPI_TABS.includes("weekly"), "the Weekly tab is on the board");
  assert.equal(KPI_TABS[KPI_TABS.length - 1], "weekly", "appended after the owner's four and his two reports");
  assert.equal(resolveKpiTab("weekly"), "weekly");

  const base = { month: "2026-09", filters: EMPTY_KPI_FILTERS };
  assert.equal(
    buildKpisQuery({ ...base, period: "w3", tab: "weekly", trend: "month", measure: "am" }),
    "month=2026-09&tab=weekly",
    "the Weekly tab lays out every week itself, so it carries no period — and defaults are left out",
  );
  assert.equal(
    buildKpisQuery({ ...base, period: "month", tab: "weekly", trend: "quarter", measure: "coverage" }),
    "month=2026-09&tab=weekly&trend=quarter&measure=coverage",
  );
  assert.equal(
    buildKpisQuery({ ...base, period: "w3", tab: "summary", trend: "quarter", measure: "pm" }),
    "month=2026-09&period=w3",
    "leaving the tab drops its switches instead of carrying them somewhere they mean nothing",
  );

  // kpis-filters.ts spells the parameter names and defaults out, so it can keep importing nothing.
  // A round trip through the URL is what proves the two files agree.
  for (const scale of KPI_TREND_SCALES) {
    const query = new URLSearchParams(buildKpisQuery({ ...base, period: "month", tab: "weekly", trend: scale }));
    assert.equal(resolveKpiTrendScale(query.get(KPI_TREND_PARAMS.scale)), scale, `the ${scale} view survives its URL`);
  }
  for (const metric of KPI_TREND_METRICS) {
    const query = new URLSearchParams(buildKpisQuery({ ...base, period: "month", tab: "weekly", measure: metric }));
    assert.equal(resolveKpiTrendMetric(query.get(KPI_TREND_PARAMS.metric)), metric, `the ${metric} measure survives its URL`);
  }

  assert.equal(resolveKpiTrendScale(" Quarter "), "quarter", "a hand-typed link is forgiven");
  assert.equal(resolveKpiTrendScale("year"), "month", "an unknown view falls back to the month, never a blank");
  assert.equal(resolveKpiTrendMetric("PM"), "pm");
  assert.equal(resolveKpiTrendMetric("am+pm"), "am", "there is no joined measure to ask for");
  assert.deepEqual([...KPI_TREND_METRICS].slice(0, 3), ["am", "pm", "pharmacy"], "three call rates, apart");
}

// ── 5. The pages, and the house rules on the new tables ──────────────────────────────────────

export function runKpiTrendWiringAndLookTests() {
  for (const page of ["app/employee-portals/kpis/page.tsx", "app/(admin)/admin/kpis/page.tsx"]) {
    const source = read(page);
    assert.match(source, /if \(tab === "weekly"\) \{\s*[\s\S]*?getKpisTrend\(\{ access,/, `${page} builds the Weekly tab for the viewer`);
    assert.ok(source.includes("board = trend.anchor;"), `${page} heads the Weekly tab with the trend's anchor board`);
    assert.ok(source.includes("trend={trend}"), `${page} hands the trend to the board view`);
  }

  // SCOPE IS THE SECURITY BOUNDARY, and it lives inside getKpisBoard. The trend module reads nothing
  // itself: every column is a board built for the same viewer, so no column can hold a rep the
  // viewer's own board would not.
  const trend = codeOf(read("src/lib/crm/kpis-trend.ts"));
  assert.ok(!/getSupabaseAdmin|\.from\(|\.rpc\(/.test(trend), "kpis-trend.ts reads no table of its own");
  assert.equal(trend.match(/access: input\.access,/g)?.length, 2, "both of its board calls pass the viewer's access");
  // A band filter is a verdict on the consolidated span: applied per week it would blank a rep's good
  // weeks out of the very row that shows he recovered.
  assert.ok(
    trend.includes("return { ...filters, coverage: [], frequency: [], amRate: [], pmRate: [], flags: [] };"),
    "the week and month boards are built with the identity filters only",
  );

  const view = codeOf(read("src/components/crm/kpis-trend-view.tsx"));
  assert.ok(!view.includes('"use client"'), "a server component — no function crosses to the browser");
  assert.ok(!/\brounded/.test(view), "square corners (the owner's square-edge rule)");
  assert.ok(!/overflow-x-auto|min-w-\[|\btruncate\b|line-clamp/.test(view), "fits the screen: no scroll, no floor, no ellipsis");
  assert.ok(!view.includes("cn("), "text-phx-* sizes never go through cn()");
  assert.ok(!/AM ?\/ ?PM/.test(view), "AM and PM are never joined with a slash");
  assert.equal(view.match(/className="w-full table-fixed"/g)?.length, 2, "both tables are fixed-layout and full width");
  assert.equal(view.match(/<colgroup>/g)?.length, 2, "and each carries a colgroup");
  assert.equal(view.match(/className="hidden md:block"/g)?.length, 2, "desktop gets the tables");
  assert.equal(view.match(/md:hidden/g)?.length, 2, "a phone gets cards");

  // Each colgroup is a first column plus the periods sharing the rest — together exactly 100%.
  const firsts = [...view.matchAll(/<col style=\{\{ width: "(\d+)%" \}\} \/>/g)].map((match) => Number(match[1]));
  const shares = [...view.matchAll(/const periodWidth = `\$\{\((\d+) \/ columns\.length\)/g)].map((match) => Number(match[1]));
  assert.deepEqual(firsts, [22, 24]);
  assert.deepEqual(
    firsts.map((first, index) => first + (shares[index] ?? 0)),
    [100, 100],
    "each table's columns add up to exactly its width",
  );
}
