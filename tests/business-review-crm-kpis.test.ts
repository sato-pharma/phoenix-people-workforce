import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { kpiSummaryRows, repRateCell, teamRateCell } from "@/lib/business-review/pack/kpi-sections";
import {
  PACK_LEVELS,
  REVIEW_METRICS,
  defaultSelectionFor,
  metricById,
  needsCrmKpis,
  type ReviewMetricId,
} from "@/lib/business-review/pack/metrics";
import { buildSalesReviewPack, type PackInput, type PackSection } from "@/lib/business-review/pack/model";
import {
  NO_MANAGER_RECORDED,
  reviewKpiMonthOf,
  reviewKpiTeam,
  type ReviewKpiMonth,
} from "@/lib/business-review/sources/crm-kpis";
import { kpiTeamFigures, sumKpiTeamTotals, type KpiRepRow } from "@/lib/crm/kpis-board";

import { stripComments } from "./support/comment-strip.ts";
import { MANAGER, REP, SEAT, fixtureFacts } from "./support/business-review-field-link-fixture.ts";

/**
 * The Business Review pack carries the CRM's own KPIs — owner, 2026-10-01, asked and answered "add
 * all three": each rep's COVERAGE and FREQUENCY against his own plan, and his CALL RATE, AM against
 * 2 a day and PM against 10. And a rep's marketing requests are every request on HIS patch, whoever
 * raised it ("all on his patch").
 *
 * What is pinned here, and why each one matters:
 *
 *   1. The team arithmetic has ONE copy, `kpiTeamFigures`, and the KPIs board reads it — so a
 *      district's coverage in the pack can never differ from the same district on the board.
 *   2. The pack keeps exactly the pack's reps, matched on the board's canonical hr id (mixed case
 *      and the alias table both drop a rep under a plain equality), and groups them by manager.
 *   3. A rep reads his own months side by side in plain lines; AM, PM and pharmacies are three
 *      figures and are never averaged or joined by a slash; "No GPS feed", "No plan", "No calls"
 *      and an unread month each say so instead of drawing a zero.
 *   4. A district reads every rep and the team; a line or the company reads each manager's team.
 *   5. The one-page summary states the last month the board answered, in sentences that start in
 *      English.
 *   6. The catalogue, the route and the loader: the board is read per viewer, month by month, with
 *      `includeReports: false` — and "coverage" and "frequency" are the plan KPIs' words alone.
 *   7. A rep's requests table lists every request for his line in his area, his own as "You", and
 *      says why the cost page counts fewer.
 */

// ─────────────────────────────────────────────────────────────── fixtures ──

/** One KPIs-board row. Annotated, so a field the board adds or renames fails tsc HERE. */
function kpiRow(over: Partial<KpiRepRow> & Pick<KpiRepRow, "agentHrId" | "repName">): KpiRepRow {
  const base: KpiRepRow = {
    actualCalls: 120,
    agentCrmId: null,
    agentHrId: over.agentHrId,
    amAttainmentPct: 90,
    amRate: 1.8,
    amReported: 40,
    amReportedRate: 2,
    amVerified: 36,
    areaName: "Area One",
    campaignCalls: 0,
    campaignOnlyDays: 0,
    campaignShare: 0,
    coveragePct: 85,
    frequencyPct: 40,
    gradeA: 0,
    gradeB: 0,
    gradeC: 0,
    hasCallRate: true,
    hasMeasurablePlan: true,
    jobTitle: "Medical Representative",
    lineName: "Pedia",
    managerName: "Manager One",
    meetsCoverageFloor: false,
    missedDoctors: 15,
    noGpsFeed: false,
    awaitingValidation: 0,
    offPlanDoctors: 0,
    onPlanDoctors: 40,
    overDoctors: 5,
    pharmacyAttainmentPct: null,
    pharmacyRate: 0.6,
    pharmacyReported: 12,
    pharmacyReportedRate: 0.6,
    pharmacyVerified: 12,
    plannedAccounts: 0,
    plannedCalls: 150,
    plannedCallsToDate: 150,
    plannedDoctors: 100,
    pmAttainmentPct: 91,
    pmRate: 9.1,
    pmReported: 190,
    pmReportedRate: 9.5,
    pmVerified: 182,
    regionName: "Delta",
    repName: over.repName,
    totalCalls: 230,
    underDoctors: 40,
    underPlannedVsGrade: 0,
    visitedDoctors: 85,
    workingDays: 20,
  };
  return { ...base, ...over };
}

function monthOf(month: string, rows: KpiRepRow[], over: Partial<ReviewKpiMonth> = {}): ReviewKpiMonth {
  return {
    ...reviewKpiMonthOf({
      boardRows: rows,
      holidaysComplete: true,
      month,
      repHrIds: rows.map((row) => row.agentHrId ?? ""),
      rules: "legacy",
      workingDays: 20,
    }),
    ...over,
  };
}

const slice = (sales: number, target: number) => ({
  ach: target !== 0 ? Math.round((sales / target) * 10000) / 100 : null,
  graded: sales,
  sales,
  target,
});

const area = (code: string, repHrIds: string[]): PackInput["areas"][number] =>
  ({
    allProducts: slice(104000, 130000),
    area: `Area ${code}`,
    areaCode: code,
    byMonth: { "2026-07": slice(50000, 65000), "2026-08": slice(54000, 65000) },
    customersTotal: 30,
    dm: "Manager One",
    dmSeatId: SEAT,
    doubleVisits: 6,
    marketingCommitted: 5000,
    marketingRequests: 1,
    outstationApproved: 700,
    outstationClaimed: 800,
    products: {},
    repHrIds,
    vacant: false,
    visitsByMonth: { "2026-07": 200, "2026-08": 200 },
  }) as unknown as PackInput["areas"][number];

const person = (hrId: string, name: string, over: Record<string, unknown> = {}): PackInput["people"][number] =>
  ({
    activeMonths: 2,
    areaCode: "CA1",
    avgPerActiveMonth: 200,
    campaignVisits: 0,
    customers: 30,
    customersAm: 2,
    customersByMonth: { "2026-07": 20, "2026-08": 25 },
    customersPharmacy: 5,
    customersPm: 23,
    dmSeatId: SEAT,
    employmentStatus: "active",
    fieldVisits: 400,
    hireDate: null,
    hrId,
    jobTitle: "Medical Representative",
    lastWorkingDate: null,
    marketingRequests: 1,
    name,
    outstationClaimed: 800,
    regularVisits: 380,
    repsCoached: 0,
    ridesLed: 0,
    role: "Medical Rep",
    visitSplit: { am: 80, pharmacies: 80, pm: 240 },
    ...over,
  }) as unknown as PackInput["people"][number];

function packInput(
  level: PackInput["subject"]["level"],
  selection: readonly ReviewMetricId[],
  over: Partial<PackInput> = {},
): PackInput {
  return {
    areas: [],
    concentration: null,
    coverageNote: "Every figure covers Jul – Aug 2026.",
    dms: [],
    generatedAt: "2026-10-01T09:00:00.000Z",
    months: ["2026-07", "2026-08"],
    people: [],
    selection,
    subject: { level, line: "pedia", title: "A pack", windowLabel: "Jul – Aug 2026" },
    visitsAvailable: true,
    ...over,
  };
}

const sectionOf = (sections: readonly PackSection[], metric: ReviewMetricId) => {
  const section = sections.find((s) => s.metric === metric);
  assert.ok(section, `${metric} drew a section — it had: ${sections.map((s) => s.title).join(" · ")}`);
  return section;
};
const cells = (section: PackSection) => [...section.columns, ...section.rows.flat().map((cell) => String(cell ?? ""))];
const rowLabelled = (section: PackSection, label: string) => {
  const row = section.rows.find((r) => r[0] === label);
  assert.ok(row, `no "${label}" row — rows were: ${section.rows.map((r) => r[0]).join(" · ")}`);
  return row;
};
/** "1.6 / 6.5" read to the owner as one number over another (2026-09-04). Never between two figures. */
const SLASH_BETWEEN_FIGURES = /\d\s*\/\s*\d/;

export function runBusinessReviewCrmKpisTests() {
  // ------------------------------------------------------------------ 1. one copy of the team arithmetic
  {
    const rows = [
      kpiRow({ agentHrId: "rep-1", repName: "Rep One" }),
      kpiRow({
        agentHrId: "rep-2",
        amVerified: 30,
        onPlanDoctors: 30,
        pharmacyVerified: 0,
        plannedDoctors: 50,
        pmVerified: 150,
        repName: "Rep Two",
        visitedDoctors: 45,
      }),
      // No GPS feed (ruling A1): in coverage and frequency, OUT of the call rate — calls AND days.
      kpiRow({
        agentHrId: "rep-3",
        amVerified: 10,
        noGpsFeed: true,
        onPlanDoctors: 10,
        plannedDoctors: 50,
        pmVerified: 50,
        repName: "Rep Three",
        visitedDoctors: 25,
      }),
    ];
    const team = kpiTeamFigures(sumKpiTeamTotals(rows), "legacy");
    assert.equal(team.coveragePct, 78, "coverage = 155 visited of 200 planned, the board's rounding");
    assert.equal(team.frequencyPct, 40, "frequency = 80 exact of 200 planned");
    assert.equal(team.meetsCoverageFloor, false, "78% is under the 95% floor");
    assert.equal(team.amRate, 66 / 40, "the average rep's AM rate: 66 proved calls over 40 rep-days — the no-feed rep is out of both");
    assert.equal(team.pmRate, 332 / 40);
    assert.equal(team.pharmacyRate, 12 / 40);
    assert.equal(team.amAttainmentPct, 83, "AM against ITS target of 2");
    assert.equal(team.pmAttainmentPct, 83, "PM against ITS target of 10 — never blended with AM");
    assert.equal(kpiTeamFigures(sumKpiTeamTotals([]), "legacy").meetsCoverageFloor, null, "no plan is no verdict, never a fail");

    const board = stripComments(readFileSync("src/lib/crm/kpis-board.ts", "utf8")).replace(/\s+/g, " ");
    assert.match(
      board,
      /const team = kpiTeamFigures\(totals, phoenix \? "phoenix" : "legacy"\)/,
      "the KPIs board's own tiles read kpiTeamFigures — the pack and the board share ONE copy",
    );
    assert.equal(
      board.split("denominator * AM_CALL_RATE_TARGET").length - 1,
      1,
      "and the team AM attainment is written exactly once, inside it",
    );
    assert.equal(
      board.split("pct(totals.visitedDoctors, totals.plannedDoctors)").length - 1,
      1,
      "and so is the team coverage",
    );
  }

  // ------------------------------------------------------------------ 2. the pack's reps, and only them
  {
    const month = reviewKpiMonthOf({
      boardRows: [
        kpiRow({ agentHrId: "rep-1", repName: "Rep One" }),
        // The board stamps the canonical key: "aa" for the legacy "AAA" upload id.
        kpiRow({ agentHrId: "aa", managerName: "Manager Two", repName: "Dr Anwar" }),
        kpiRow({ agentHrId: "rep-9", repName: "Somebody Else" }),
        kpiRow({ agentHrId: "rep-3", managerName: null, repName: "Rep Three" }),
      ],
      holidaysComplete: true,
      month: "2026-08",
      repHrIds: ["REP-1", "AAA", "Rep-3"],
      rules: "legacy",
      workingDays: 20,
    });
    assert.deepEqual(
      month.rows.map((row) => row.repName),
      ["Rep One", "Dr Anwar", "Rep Three"],
      "mixed case and the alias table both still match — and a rep outside the pack is cut",
    );
    assert.deepEqual(
      month.teams.map((team) => team.managerName),
      ["Manager One", "Manager Two", NO_MANAGER_RECORDED],
      "one team per manager, the reps with no manager on record last",
    );
    assert.deepEqual(month.team, reviewKpiTeam(month.rows, "legacy"), "the pack's team is the board's arithmetic over its rows");
    assert.equal(month.team.reps, 3);
    assert.equal(month.unread, false);
  }

  // ------------------------------------------------------------------ 2b. a manager stored in capitals reads in title case
  {
    const month = reviewKpiMonthOf({
      boardRows: [
        kpiRow({ agentHrId: "rep-1", managerName: "SAHAR EL GALLAD", repName: "Rep One" }),
        kpiRow({ agentHrId: "rep-2", managerName: "Sahar El Gallad", repName: "Rep Two" }),
        kpiRow({ agentHrId: "rep-3", managerName: "Manager Two", repName: "Rep Three" }),
      ],
      holidaysComplete: true,
      month: "2026-08",
      repHrIds: ["rep-1", "rep-2", "rep-3"],
      rules: "legacy",
      workingDays: 20,
    });
    assert.deepEqual(
      month.teams.map((team) => team.managerName).sort(),
      ["Manager Two", "Sahar El Gallad"],
      "an all-capitals manager reads in title case, and the same person in two spellings is ONE team card",
    );
    assert.equal(month.teams.find((team) => team.managerName === "Sahar El Gallad")?.figures.reps, 2);
  }

  // ------------------------------------------------------------------ 3. a rep's own months, in plain lines
  {
    const july = monthOf("2026-07", [kpiRow({ agentHrId: "rep-1", repName: "Rep One" })]);
    const august = monthOf("2026-08", [
      kpiRow({ agentHrId: "rep-1", amRate: null, noGpsFeed: true, pharmacyRate: null, pmRate: null, repName: "Rep One" }),
    ]);
    const pack = buildSalesReviewPack(
      packInput("rep", ["crm-kpis"], { crmKpis: [july, august], people: [person(REP, "Rep One")] }),
    );
    const section = sectionOf(pack.sections, "crm-kpis");
    assert.equal(section.title, "Your plan and your calls");
    assert.deepEqual(section.columns, ["Measure", "Jul", "Aug"], "his months side by side");
    assert.deepEqual(
      section.rows.map((row) => row[0]),
      [
        "Doctors on your plan",
        "Visited at least once (coverage)",
        "Visited exactly as planned (frequency)",
        "Visited more often than planned",
        "Visited, but less often than planned",
        "Not visited",
        "AM visits a day (target 2)",
        "PM visits a day (target 10)",
        "Pharmacy visits a day",
      ],
      "AM, PM and pharmacies are three lines — never one call rate",
    );
    assert.deepEqual(rowLabelled(section, "Visited at least once (coverage)").slice(1), ["85 of 100 (85%)", "85 of 100 (85%)"]);
    assert.deepEqual(rowLabelled(section, "Visited exactly as planned (frequency)").slice(1), ["40 (40%)", "40 (40%)"]);
    assert.deepEqual(rowLabelled(section, "Visited more often than planned").slice(1), ["5", "5"], "an over-visit is shown on its own");
    assert.deepEqual(rowLabelled(section, "AM visits a day (target 2)").slice(1), ["1.8", "No GPS feed"]);
    assert.deepEqual(rowLabelled(section, "PM visits a day (target 10)").slice(1), ["9.1", "No GPS feed"]);
    assert.deepEqual(rowLabelled(section, "Pharmacy visits a day").slice(1), ["0.6", "No GPS feed"], "a missing feed says so — never a red zero");
    assert.ok(!cells(section).some((cell) => SLASH_BETWEEN_FIGURES.test(cell)), "never a slash between two figures");
    assert.match(section.note, /the floor is 95%/);
    assert.match(section.note, /GPS check-in at that customer the same day/, "he is told how a visit reaches his call rate");

    const noPlan = buildSalesReviewPack(
      packInput("rep", ["crm-kpis"], {
        crmKpis: [
          monthOf("2026-08", [kpiRow({ agentHrId: "rep-1", hasCallRate: false, hasMeasurablePlan: false, repName: "Rep One" })]),
        ],
      }),
    );
    const empty = sectionOf(noPlan.sections, "crm-kpis");
    assert.deepEqual(rowLabelled(empty, "Visited at least once (coverage)").slice(1), ["No plan"], "no plan is not 0%");
    assert.deepEqual(rowLabelled(empty, "AM visits a day (target 2)").slice(1), ["No calls"], "nothing logged is not a rate of zero");

    const unread = buildSalesReviewPack(
      packInput("rep", ["crm-kpis"], {
        crmKpis: [july, { ...monthOf("2026-08", []), unread: true }],
      }),
    );
    const partly = sectionOf(unread.sections, "crm-kpis");
    assert.deepEqual(rowLabelled(partly, "AM visits a day (target 2)").slice(1), ["1.8", "Could not be read"]);
    assert.match(partly.note, /could not be read for Aug 2026/, "and the note says which month, never a zero");

    assert.ok(
      !buildSalesReviewPack(packInput("rep", ["crm-kpis"], { crmKpis: null })).sections.some((s) => s.metric === "crm-kpis"),
      "ticked but not read is dropped, never drawn as zeros",
    );
  }

  // ------------------------------------------------------------------ 4. a district, rep by rep, and the team
  {
    const rows = (month: string) => [
      kpiRow({ agentHrId: "rep-1", repName: "Rep One" }),
      // "Alexandria" sorts before "Area One", so Rep Two leads although he is listed second.
      kpiRow({ agentHrId: "rep-2", areaName: "Alexandria", coveragePct: 60, repName: "Rep Two", visitedDoctors: 60 }),
      kpiRow({ agentHrId: "rep-3", coveragePct: 97, meetsCoverageFloor: true, repName: "Rep Three", visitedDoctors: 97 }),
    ].map((row) => ({ ...row, workingDays: month === "2026-07" ? 22 : 20 }));
    const july = monthOf("2026-07", rows("2026-07"));
    const august = monthOf("2026-08", rows("2026-08"));
    const pack = buildSalesReviewPack(
      packInput("district", ["crm-kpis"], {
        crmKpis: [july, august],
        people: [
          person("REP-1", "Rep One"),
          person("REP-2", "Rep Two"),
          person("REP-3", "Rep Three", { employmentStatus: "resigned", lastWorkingDate: "2026-09-20" }),
        ],
      }),
    );
    const section = sectionOf(pack.sections, "crm-kpis");
    assert.equal(section.title, "Coverage, frequency and call rate, rep by rep");
    assert.deepEqual(section.columns, [
      "Rep",
      "Month",
      "Coverage",
      "Frequency",
      "More often than planned",
      "AM a day (target 2)",
      "PM a day (target 10)",
      "Pharmacies a day",
    ]);
    assert.ok(!section.columns.some((c) => /\bAM\b/.test(c) && /\bPM\b/.test(c)), "no column holds AM and PM together");
    assert.deepEqual(
      section.rows.map((row) => `${row[0]} · ${row[1]}`),
      [
        "Rep Two · Jul",
        "Rep Two · Aug",
        "Rep One · Jul",
        "Rep One · Aug",
        "Rep Three (left 20 Sept 2026) · Jul",
        "Rep Three (left 20 Sept 2026) · Aug",
        "The team · Jul",
        "The team · Aug",
      ],
      "by area then name, each rep's months together, the leaver marked, the team last",
    );
    const teamAugust = section.rows.find((row) => row[0] === "The team" && row[1] === "Aug");
    assert.ok(teamAugust);
    assert.equal(teamAugust[2], `${august.team.visitedDoctors} of ${august.team.plannedDoctors} (${august.team.coveragePct}%)`);
    assert.equal(teamAugust[5], august.team.amRate?.toFixed(1), "the team's AM rate is the board's average rep");
    assert.ok(!cells(section).some((cell) => SLASH_BETWEEN_FIGURES.test(cell)), "never a slash between two figures");
    assert.ok(section.chart, "the coverage chart");
    assert.equal(section.chart.unit, "pct");
    assert.equal(section.chart.reference?.value, 95, "the owner's 95% floor is drawn across");
    assert.deepEqual(
      section.chart.items.map((item) => item.value),
      [60, 85, 97],
      "the last month's coverage, lowest first",
    );
    assert.match(section.note, /never averaged/);
  }

  // ------------------------------------------------------------------ 5. a line or the company, team by team
  {
    const august = monthOf("2026-08", [
      kpiRow({ agentHrId: "rep-1", repName: "Rep One" }),
      kpiRow({ agentHrId: "rep-2", managerName: "Manager Two", repName: "Rep Two" }),
      kpiRow({ agentHrId: "rep-3", coveragePct: 97, managerName: "Manager Two", meetsCoverageFloor: true, repName: "Rep Three", visitedDoctors: 97 }),
    ]);
    const pack = buildSalesReviewPack(packInput("company", ["crm-kpis"], { crmKpis: [august], months: ["2026-08"] }));
    const section = sectionOf(pack.sections, "crm-kpis");
    assert.equal(section.title, "Coverage, frequency and call rate, team by team");
    assert.deepEqual(section.columns, [
      "Manager",
      "Reps",
      "Coverage",
      "Frequency",
      "AM a day (target 2)",
      "PM a day (target 10)",
      "Pharmacies a day",
    ], "one month: no Month column");
    assert.deepEqual(section.rows.map((row) => row[0]), ["Manager One", "Manager Two", "Everyone"]);
    assert.deepEqual(section.rows[1].slice(0, 3), ["Manager Two", "2", "182 of 200 (91%)"], "a team is its reps' sums, never an average of percentages");
    assert.match(section.note, /2 reps were under the 95% floor, of 3 with a plan/);
  }

  // ------------------------------------------------------------------ 6. the one-page summary
  {
    const august = monthOf("2026-08", [kpiRow({ agentHrId: "rep-1", repName: "Rep One" })]);
    const said = kpiSummaryRows(packInput("rep", ["review-summary", "crm-kpis"], { crmKpis: [monthOf("2026-07", []), august] }));
    assert.deepEqual(said, [
      [
        "Your plan",
        "In Aug 2026 you visited 85 of the 100 doctors on your plan (85%, against the 95% floor), and 40% of them got exactly the visits planned.",
      ],
      [
        "Your calls",
        "In Aug 2026 you made 1.8 AM visits a day against a target of 2, and 9.1 PM visits a day against 10; pharmacies 0.6 a day.",
      ],
    ]);
    const team = kpiSummaryRows(
      packInput("district", ["review-summary", "crm-kpis"], {
        crmKpis: [
          monthOf("2026-08", [
            kpiRow({ agentHrId: "rep-1", repName: "Rep One" }),
            kpiRow({ agentHrId: "rep-2", coveragePct: 97, meetsCoverageFloor: true, repName: "Rep Two", visitedDoctors: 97 }),
          ]),
        ],
      }),
    );
    assert.deepEqual(team.map((row) => row[0]), ["Plan", "Call rate"]);
    assert.equal(
      team[0][1],
      "In Aug 2026 the team visited 91% of the doctors on its plans (the floor is 95%) and 40% exactly as often as planned; 1 of 2 reps reached the floor.",
    );
    assert.equal(
      team[1][1],
      "In Aug 2026 the average rep made 1.8 AM visits a day against a target of 2, and 9.1 PM visits a day against 10.",
    );
    for (const [, sentence] of [...said, ...team]) {
      assert.match(String(sentence), /^[A-Za-z]/, "every sentence starts in English — an Arabic opening is laid out right to left");
      assert.ok(!SLASH_BETWEEN_FIGURES.test(String(sentence)), "AM and PM are never joined by a slash");
    }
    // Through the pack: the summary carries them only when the board was read.
    const pack = buildSalesReviewPack(packInput("rep", ["review-summary", "crm-kpis"], { crmKpis: [august] }));
    const summary = sectionOf(pack.sections, "review-summary");
    assert.ok(summary.rows.some((row) => row[0] === "Your plan"));
    const unread = buildSalesReviewPack(packInput("rep", ["review-summary"], { areas: [area("CA1", [REP])], crmKpis: null }));
    assert.ok(!sectionOf(unread.sections, "review-summary").rows.some((row) => row[0] === "Your plan"), "nothing read, nothing said");
    // The two cell helpers say why when there is no number.
    assert.equal(repRateCell(kpiRow({ agentHrId: "x", hasCallRate: false, repName: "X" }), "pm"), "No calls");
    assert.equal(teamRateCell(reviewKpiTeam([kpiRow({ agentHrId: "x", noGpsFeed: true, repName: "X" })], "legacy"), "am"), "No GPS feed");
  }

  // ------------------------------------------------------------------ 7. the catalogue, the route, the loader
  {
    const metric = metricById("crm-kpis");
    assert.ok(metric);
    assert.deepEqual([...metric.levels], [...PACK_LEVELS], "every level can read its plan KPIs");
    assert.deepEqual([...metric.defaultAt], [...PACK_LEVELS], "and every fresh pack carries them");
    assert.equal(metric.needsCrmKpis, true, "the picker marks it as an extra read");
    assert.ok(!metric.needsFieldLink, "it is the board's read, not the linked facts'");
    for (const level of PACK_LEVELS) assert.ok(defaultSelectionFor(level).includes("crm-kpis"), `ticked at ${level}`);
    assert.equal(needsCrmKpis(["achievement", "visits-split"]), false, "an ordinary pack pays for no board");
    assert.equal(needsCrmKpis(["crm-kpis"]), true);
    assert.deepEqual(
      REVIEW_METRICS.filter((m) => /coverage|frequency/i.test(m.label)).map((m) => m.id),
      ["crm-kpis"],
      "\"coverage\" and \"frequency\" are the owner's plan KPIs — no other tick may use the words",
    );
    assert.equal(metricById("coverage-frequency")?.label, "Customers reached");
    const reached = buildSalesReviewPack(packInput("district", ["coverage-frequency"], { people: [person("REP-1", "Rep One")] }));
    assert.equal(sectionOf(reached.sections, "coverage-frequency").title, "Customers reached");

    const route = stripComments(readFileSync("app/api/business-review/pack/route.ts", "utf8")).replace(/\s+/g, " ");
    assert.match(route, /needsCrmKpis\(selection\)/, "the board is read only when its metric is ticked");
    assert.match(
      route,
      /loadReviewKpiMonths\(\{ access, months: figureWindowPeriods\(coverage\), repHrIds: packRepHrIds \}\)/,
      "for THIS viewer, over the figure window, cut to the reps the pack survived to",
    );
    assert.match(route, /packRepHrIds = scope\.kind === "rep" \? \[scope\.hrId\]/, "a rep's read names him alone");
    assert.match(route, /\bcrmKpis,/, "and the pack is handed what was read");

    const loader = stripComments(readFileSync("src/lib/business-review/sources/crm-kpis.ts", "utf8")).replace(/\s+/g, " ");
    assert.match(
      loader,
      /getKpisBoard\(\{ access: input\.access, includeReports: false, month, todayIso \}\)/,
      "the KPIs board itself, per viewer, without the per-rep reports the pack never prints",
    );
    assert.match(loader, /for \(const month of input\.months\)/, "one month at a time");
    assert.ok(!/Promise\.all/.test(loader), "never a semester of company-wide boards in memory at once");
    assert.match(loader, /canonicalHrIdKey/, "matched on the board's own canonical key");
  }

  // ------------------------------------------------------------------ 8. a rep's requests: all on his patch
  {
    const facts = fixtureFacts({
      marketing: [
        {
          areaCode: "CA1",
          bucket: "committed",
          code: "MR-1",
          cost: 5000,
          customerName: "Doctor 1000",
          line: "Pedia",
          period: "2026-08",
          requestId: "mr-1",
          requesterHrId: REP,
          requesterName: "Rep One",
          requiredReturn: 50000,
          returnSoFar: 12500,
          status: "active",
          typeName: "Sponsorship",
        },
        {
          areaCode: "CA1",
          bucket: "committed",
          code: "MR-2",
          cost: 20000,
          customerName: "Doctor 1001",
          line: "Pedia",
          period: "2026-08",
          requestId: "mr-2",
          requesterHrId: MANAGER,
          requesterName: "Manager One",
          requiredReturn: 200000,
          returnSoFar: 40000,
          status: "active",
          typeName: "Conference",
        },
      ],
    });
    const rep = buildSalesReviewPack(
      packInput("rep", ["review-summary", "requests-return", "marketing-committed"], {
        areas: [area("CA1", [REP])],
        fieldLink: facts,
        people: [person(REP, "Rep One")],
      }),
    );
    const requests = sectionOf(rep.sections, "requests-return");
    assert.equal(requests.title, "Marketing requests for your area and what they brought");
    const by = requests.columns.indexOf("Requested by");
    assert.ok(by >= 0, "a rep's table names who raised each request");
    assert.deepEqual(
      requests.rows.map((row) => row[by]),
      ["You", "Manager One"],
      "his own read \"You\"; his manager's request for his doctors is on his table too",
    );
    assert.match(requests.note, /The cost page counts only the requests you raised yourself/, "and it says why the cost page counts fewer");
    const summary = sectionOf(rep.sections, "review-summary");
    assert.equal(
      rowLabelled(summary, "Marketing requests")[1],
      "2 requests for your area were paid in the period, 1 raised by you: EGP 25,000 committed, EGP 52,500 of sales brought back so far.",
    );
    assert.match(
      sectionOf(rep.sections, "marketing-committed").note,
      /Requests others raised for your doctors are listed in "Marketing requests for your area" and are not counted here/,
      "his cost page says whose requests it counts — the ones he raised (it places a request on its requester)",
    );

    const district = buildSalesReviewPack(
      packInput("district", ["requests-return"], { areas: [area("CA1", [REP])], fieldLink: facts, people: [person(REP, "Rep One")] }),
    );
    const managers = sectionOf(district.sections, "requests-return");
    assert.deepEqual(
      managers.rows.map((row) => row[managers.columns.indexOf("Requested by")]),
      ["Rep One", "Manager One"],
      "a manager's pack names everyone — \"You\" is the rep's own voice only",
    );

    const route = stripComments(readFileSync("app/api/business-review/pack/route.ts", "utf8"));
    assert.ok(!/ownRequestsOf/.test(route), "the route no longer narrows a rep to his own requests");
    const loader = stripComments(readFileSync("src/lib/business-review/sources/field-link.ts", "utf8")).replace(/\s+/g, " ");
    assert.ok(!/ownRequestsOf/.test(loader));
    assert.match(
      loader,
      /return lines\.has\(line\) && areas\.has\(area\);/,
      "his line AND his area — an area is not per line (owner, 2026-09-30)",
    );
  }
}
