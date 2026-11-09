import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  kpiCoverageByGrade,
  kpiCoverageBySpeciality,
  kpiCoverageByWeek,
  kpiDaysBetween,
  kpiFloorPath,
  kpiFloorSentence,
  kpiGradeGroupOf,
  kpiLateAgeing,
  kpiLateAgeOf,
  kpiLateDays,
  kpiMonthWeekOf,
  kpiRepCoverageSummary,
  KPI_NO_PLAN_WEEK,
  KPI_NO_SPECIALITY,
} from "../src/lib/crm/kpi-coverage-rep-detail.ts";
import type { KpiCoverageDetail, KpiCoverageDoctor } from "../src/lib/crm/kpis-board.ts";
import {
  EMPTY_KPI_DOCTOR_FILTER,
  filterKpiDoctors,
  KPI_DOCTOR_NO_SPECIALITY,
} from "../src/lib/crm/kpis-doctor-filters.ts";
import { KPI_FLAGS_OFF_REPORT, kpiFlagsOf, kpiFlagsShownOn, type KpiFilterableRow } from "../src/lib/crm/kpis-filters.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE OPEN REP'S COVERAGE PANEL (premium pass, owner, 9 Nov 2026: "eyeball every report in My Team's
 * Reports, premium polish big work, every single component").
 *
 * What would go wrong, each without an error anyone could see:
 *
 *   1. tiles that do not add up to the rep's row — Covered + Late + Not due yet must be Planned, or a manager
 *      checking one against the other stops trusting both;
 *   2. a "short of the floor" count that rounds the wrong way, so a rep at 94.6% reads as clearing 95%;
 *   3. "see these first" handing over more or fewer doctors than the floor needs, a covered doctor, or a
 *      doctor still ahead before one already late;
 *   4. a late doctor in two age buckets, in none, or softened to "this week" because his date could not be
 *      read;
 *   5. a grade or speciality row whose link opens a DIFFERENT set of doctors than the row counted;
 *   6. a doctor counted in two weeks, so the weeks add up to more than his Planned;
 *   7. another report's flag ("More below-plan doctors than above") on every Coverage row — and, the other
 *      way, the flag FILTER losing it, which would hide reps a manager asked for;
 *   8. the gloss finish, a rounded corner or a sideways scroll coming into the new panel.
 */

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

let nextId = 1;

function doctor(shape: {
  name?: string | null;
  grade?: string | null;
  speciality?: string | null;
  visits?: number;
  planDates?: string[];
  due?: boolean;
}): KpiCoverageDoctor {
  const visits = shape.visits ?? 0;
  return {
    contactCrmId: nextId++,
    name: shape.name === undefined ? `Doctor ${nextId}` : shape.name,
    speciality: shape.speciality ?? null,
    grade: shape.grade ?? null,
    visits,
    lastVisitDate: visits > 0 ? "2026-11-03" : null,
    planDates: shape.planDates ?? ["2026-11-02"],
    due: shape.due ?? true,
  };
}

function detailOf(doctors: KpiCoverageDoctor[]): KpiCoverageDetail {
  return {
    repKey: "crm:1",
    repName: "Hassan Ali",
    covered: doctors.filter((entry) => entry.visits > 0),
    notCovered: doctors.filter((entry) => entry.visits === 0),
  };
}

const AS_OF = "2026-11-20";

/** 20 planned: 14 covered (9 once, 3 twice, 2 three or more), 4 late, 2 not due yet. */
function hassan(): KpiCoverageDetail {
  const doctors: KpiCoverageDoctor[] = [];
  for (let index = 0; index < 9; index += 1) doctors.push(doctor({ grade: index < 4 ? "A" : "B", speciality: "Pediatrics", visits: 1 }));
  for (let index = 0; index < 3; index += 1) doctors.push(doctor({ grade: "C", speciality: "ENT", visits: 2 }));
  for (let index = 0; index < 2; index += 1) doctors.push(doctor({ grade: null, speciality: null, visits: 4 }));
  // Late: one missed yesterday (grade C), one missed 10 days ago twice (grade A), one 20 days ago (grade B),
  // and one whose only planned day could not be read (grade A).
  doctors.push(doctor({ name: "Late C fresh", grade: "C", speciality: "ENT", planDates: ["2026-11-19"] }));
  doctors.push(doctor({ name: "Late A twice", grade: "A", speciality: "Pediatrics", planDates: ["2026-11-03", "2026-11-10"] }));
  doctors.push(doctor({ name: "Late B old", grade: "B", speciality: "Pediatrics", planDates: ["2026-10-31"] }));
  doctors.push(doctor({ name: "Late A undated", grade: "A", speciality: null, planDates: ["not-a-day"] }));
  // Not due yet.
  doctors.push(doctor({ name: "Ahead 25", grade: "A", speciality: "ENT", planDates: ["2026-11-25"], due: false }));
  doctors.push(doctor({ name: "Ahead 22", grade: "B", speciality: "ENT", planDates: ["2026-11-22", "2026-11-27"], due: false }));
  return detailOf(doctors);
}

// ── 1. The summary adds up ──────────────────────────────────────────────────────────────────────

function checkSummary() {
  const detail = hassan();
  const summary = kpiRepCoverageSummary(detail, 95);
  assert.ok(summary);
  assert.equal(summary.planned, 20);
  assert.equal(summary.covered + summary.late + summary.notDue, summary.planned, "covered + late + not due yet is planned");
  assert.equal(summary.covered, 14);
  assert.equal(summary.late, 4);
  assert.equal(summary.notDue, 2);
  assert.equal(summary.pct, 70);
  assert.equal(summary.floorTarget, 19, "⌈20 × 95 ÷ 100⌉");
  assert.equal(summary.needed, 5);
  assert.equal(summary.meetsFloor, false);
  assert.equal(summary.catchUp, 3, "even with both doctors still ahead, three must come from the late list");
  assert.equal(summary.seenOnce + summary.seenTwice + summary.seenThreePlus, summary.covered, "the visit depth adds up to Covered");
  assert.deepEqual([summary.seenOnce, summary.seenTwice, summary.seenThreePlus], [9, 3, 2]);
  assert.equal(summary.visits, 9 + 6 + 8);

  // Rounding never flatters: 18 of 19 is 94.7%, and the floor needs ⌈18.05⌉ = 19, so one is still short.
  const close = detailOf([
    ...Array.from({ length: 18 }, () => doctor({ visits: 1 })),
    doctor({ planDates: ["2026-11-02"] }),
  ]);
  const closeSummary = kpiRepCoverageSummary(close, 95)!;
  assert.equal(closeSummary.pct, 95, "the row prints 95% after rounding");
  assert.equal(closeSummary.needed, 1, "but 18 of 19 does not clear a 95% floor, and the panel must say so");
  assert.equal(closeSummary.meetsFloor, false);

  assert.equal(kpiRepCoverageSummary(detailOf([]), 95), null, "nobody planned: no denominator, never 0%");
}

function checkSentence() {
  const summary = kpiRepCoverageSummary(hassan(), 95)!;
  assert.equal(
    kpiFloorSentence(summary),
    "5 doctors short of the 95% floor (19 of 20). Even with both doctors still due, 3 doctors must come from the late list.",
  );
  const cleared = kpiRepCoverageSummary(detailOf(Array.from({ length: 20 }, () => doctor({ visits: 1 }))), 95)!;
  assert.equal(kpiFloorSentence(cleared), "Clears the 95% floor: 20 of 20 covered, 1 more than the 19 it takes.");
  const exact = kpiRepCoverageSummary(
    detailOf([...Array.from({ length: 19 }, () => doctor({ visits: 1 })), doctor({ due: false, planDates: ["2026-11-25"] })]),
    95,
  )!;
  assert.equal(kpiFloorSentence(exact), "Clears the 95% floor exactly: 19 of 20 covered.");
  const aheadOnly = kpiRepCoverageSummary(
    detailOf([
      ...Array.from({ length: 17 }, () => doctor({ visits: 1 })),
      ...Array.from({ length: 3 }, () => doctor({ due: false, planDates: ["2026-11-25"] })),
    ]),
    95,
  )!;
  assert.equal(kpiFloorSentence(aheadOnly), "2 doctors short of the 95% floor (19 of 20). Seeing 2 of the 3 doctors still due clears it.");
  const allPast = kpiRepCoverageSummary(
    detailOf([...Array.from({ length: 17 }, () => doctor({ visits: 1 })), ...Array.from({ length: 3 }, () => doctor({}))]),
    95,
  )!;
  assert.equal(
    kpiFloorSentence(allPast),
    "2 doctors short of the 95% floor (19 of 20). Every planned day has passed, so the late list is the only way there.",
  );
}

// ── 2. How late ─────────────────────────────────────────────────────────────────────────────────

function checkAgeing() {
  assert.equal(kpiDaysBetween("2026-10-31", "2026-11-20"), 20);
  assert.equal(kpiDaysBetween("2026-12-30", "2027-01-02"), 3, "across a year end");
  assert.equal(kpiDaysBetween("2026-11-20", "2026-11-19"), -1);
  assert.equal(kpiDaysBetween("not-a-day", "2026-11-19"), null);
  assert.deepEqual([0, 6, 7, 13, 14].map(kpiLateAgeOf), ["this-week", "this-week", "last-week", "last-week", "older"]);

  const detail = hassan();
  const byName = (name: string) => detail.notCovered.find((entry) => entry.name === name)!;
  assert.equal(kpiLateDays(byName("Late A twice"), AS_OF), 10, "aged from the LAST planned day missed, not the first");
  assert.equal(kpiLateDays(byName("Ahead 25"), AS_OF), null, "a doctor not due yet is not late");
  assert.equal(kpiLateDays(detail.covered[0]!, AS_OF), null, "a covered doctor is not late");

  const buckets = kpiLateAgeing(detail, AS_OF);
  assert.deepEqual(
    buckets.map((bucket) => [bucket.age, bucket.doctors.map((entry) => entry.name)]),
    [
      ["this-week", ["Late C fresh"]],
      ["last-week", ["Late A twice"]],
      ["older", ["Late B old", "Late A undated"]],
    ],
    "every late doctor in exactly one bucket; an unreadable date counts as the oldest, never as fresh",
  );
  const lateTotal = buckets.reduce((sum, bucket) => sum + bucket.doctors.length, 0);
  assert.equal(lateTotal, kpiRepCoverageSummary(detail, 95)!.late, "the three ages add up to the Late tile");
}

// ── 3. Who to see first ─────────────────────────────────────────────────────────────────────────

function checkFloorPath() {
  const detail = hassan();
  const summary = kpiRepCoverageSummary(detail, 95)!;
  const steps = kpiFloorPath(detail, summary, AS_OF);
  assert.equal(steps.length, summary.needed, "exactly as many doctors as the floor needs");
  assert.deepEqual(
    steps.map((step) => step.doctor.name),
    ["Late A twice", "Late A undated", "Late B old", "Late C fresh", "Ahead 22"],
    "late grade A first (the one missed twice before the one missed once), then B, then C, then the earliest doctor still ahead",
  );
  assert.ok(steps.every((step) => step.doctor.visits === 0), "never a doctor already covered");
  assert.deepEqual(steps[0]!.days, ["2026-11-03", "2026-11-10"], "a late doctor carries the days he missed");
  assert.deepEqual(steps.at(-1)!.days, ["2026-11-22"], "a doctor still ahead carries his next planned day");
  assert.equal(steps.at(-1)!.late, false);

  const cleared = detailOf(Array.from({ length: 20 }, () => doctor({ visits: 1 })));
  assert.deepEqual(kpiFloorPath(cleared, kpiRepCoverageSummary(cleared, 95)!, AS_OF), [], "nothing to suggest once the floor is cleared");
}

// ── 4. The breakdowns, and their links ──────────────────────────────────────────────────────────

function checkGroups() {
  const detail = hassan();
  const all = [...detail.covered, ...detail.notCovered];
  const grades = kpiCoverageByGrade(detail);
  assert.deepEqual(
    grades.map((row) => row.label),
    ["Grade A", "Grade B", "Grade C", "No grade"],
    "grades in grade order, never alphabetical by accident",
  );
  for (const rows of [grades, kpiCoverageBySpeciality(detail)]) {
    assert.equal(rows.reduce((sum, row) => sum + row.planned, 0), all.length, "the groups add up to Planned");
    assert.equal(rows.reduce((sum, row) => sum + row.covered, 0), detail.covered.length, "and to Covered");
    for (const row of rows) assert.equal(row.covered + row.late + row.notDue, row.planned, `${row.label}: covered + late + not due is planned`);
  }
  const gradeA = grades[0]!;
  assert.deepEqual([gradeA.planned, gradeA.covered, gradeA.late, gradeA.notDue, gradeA.pct], [7, 4, 2, 1, 57]);

  // The link opens the SAME doctors the row counted: the row's label through the doctor filter's own field.
  for (const row of grades) {
    const opened = filterKpiDoctors(all, { ...EMPTY_KPI_DOCTOR_FILTER, grades: [row.label] });
    assert.equal(opened.length, row.planned, `${row.label}: its link opens exactly the doctors it counted`);
    const late = filterKpiDoctors(all, { ...EMPTY_KPI_DOCTOR_FILTER, grades: [row.label], timing: ["late"] });
    assert.equal(late.length, row.late, `${row.label}: its late link opens exactly its late doctors`);
  }
  const specialities = kpiCoverageBySpeciality(detail);
  const none = specialities.find((row) => row.label === KPI_NO_SPECIALITY);
  assert.ok(none, "doctors with no speciality are filed under the filter's own words");
  for (const row of specialities) {
    const choice = row.label === KPI_NO_SPECIALITY ? KPI_DOCTOR_NO_SPECIALITY : row.label;
    const opened = filterKpiDoctors(all, { ...EMPTY_KPI_DOCTOR_FILTER, specialities: [choice] });
    assert.equal(opened.length, row.planned, `${row.label}: its link opens exactly the doctors it counted`);
  }
  assert.equal(kpiGradeGroupOf(" a+ "), "Grade A");
  assert.equal(kpiGradeGroupOf("D"), "No grade");
}

function checkWeeks() {
  assert.deepEqual(kpiMonthWeekOf("2026-11-08"), { key: "w2", label: "Week 2 · 8–14 Nov", from: "2026-11-08", to: "2026-11-14" });
  assert.equal(kpiMonthWeekOf("2026-11-30")!.label, "Week 5 · 29–30 Nov", "the last week stops at the month's own end");
  assert.equal(kpiMonthWeekOf("2026-02-28")!.label, "Week 4 · 22–28 Feb");
  assert.equal(kpiMonthWeekOf("garbage"), null);

  const detail = detailOf([
    doctor({ visits: 1, planDates: ["2026-11-02", "2026-11-16"] }),
    doctor({ planDates: ["2026-11-10"] }),
    doctor({ planDates: ["2026-11-25"], due: false }),
    doctor({ planDates: [] }),
  ]);
  const weeks = kpiCoverageByWeek(detail, AS_OF);
  assert.deepEqual(
    weeks.map((week) => [week.key, week.planned, week.covered, week.late, week.notDue, week.ahead]),
    [
      ["w1", 1, 1, 0, 0, false],
      ["w2", 1, 0, 1, 0, false],
      ["w4", 1, 0, 0, 1, true],
      ["none", 1, 0, 1, 0, false],
    ],
    "each doctor counted once, in the week of his FIRST planned day; a week not begun is marked; no day last",
  );
  assert.equal(weeks.at(-1)!.label, KPI_NO_PLAN_WEEK);
  assert.equal(weeks.reduce((sum, week) => sum + week.planned, 0), 4, "the weeks add up to Planned");
}

// ── 5. Another report's flags stay on that report ───────────────────────────────────────────────

function checkFlags() {
  const row = {
    justStarted: false,
    hasMeasurablePlan: true,
    visitedDoctors: 0,
    hasCallRate: true,
    totalCalls: 40,
    noGpsFeed: false,
    campaignShare: 0.6,
    campaignCalls: 24,
    campaignOnlyDays: 2,
    underDoctors: 6,
    overDoctors: 1,
    amAttainmentPct: 80,
    pmAttainmentPct: 90,
    frequencyPct: 40,
    meetsCoverageFloor: false,
  } as unknown as KpiFilterableRow;
  const all = kpiFlagsOf(row);
  assert.ok(all.includes("under-visiting") && all.includes("campaign-heavy"), "the fixture carries the flags in question");
  const coverage = kpiFlagsShownOn(row, "coverage");
  assert.ok(!coverage.includes("under-visiting"), "the Coverage row leaves the frequency flag to the Frequency report");
  assert.ok(!coverage.includes("campaign-heavy") && !coverage.includes("campaign-only-days"), "and the campaign flags to the Call Rate report");
  assert.ok(coverage.includes("never-reached"), "a coverage flag stays on the Coverage row");
  assert.ok(coverage.includes("below-coverage-floor"), "the floor flag is the Coverage report's own");
  assert.deepEqual(kpiFlagsShownOn(row, "summary"), all, "the Summary shows every flag");
  assert.deepEqual(kpiFlagsShownOn(row, "frequency"), all, "the Frequency report keeps its own flags");
  assert.deepEqual(kpiFlagsShownOn(row), all, "no report named, nothing left out");
  assert.deepEqual(Object.keys(KPI_FLAGS_OFF_REPORT), ["coverage"], "only the Coverage report leaves flags out — a new entry is a decision, not a tidy-up");

  // The flag FILTER is untouched: it still matches through kpiFlagsOf, so a manager asking for under-visiting reps on any tab gets them.
  const filters = stripComments(read("src/lib/crm/kpis-filters.ts"));
  const applyBody = filters.slice(filters.indexOf("export function applyKpiFilters"));
  assert.ok(!/kpiFlagsShownOn/.test(applyBody.slice(0, applyBody.indexOf("\n}\n"))), "the filter never reads the per-report display rule");
}

// ── 6. The finish and the wiring, read in the source ────────────────────────────────────────────

function checkSource() {
  const raw = read("src/components/crm/kpi-coverage-rep-panels.tsx");
  const panels = stripComments(raw);
  const view = stripComments(read("src/components/crm/kpis-board-view.tsx"));
  assert.ok(!/^\s*["']use client["']/m.test(raw), "the rep panels stay a server component");

  const gloss = /bg-gradient-|linear-gradient|shadow-\[|drop-shadow|backdrop-blur/;
  const glossHit = gloss.exec(panels);
  assert.equal(glossHit, null, `kpi-coverage-rep-panels.tsx: "${glossHit?.[0]}" — flat colour only`);
  const banned = /\brounded(?:-[a-z0-9]+)?\b|overflow-x-(?:auto|scroll)|min-w-\[|\btruncate\b|text-ellipsis|line-clamp-/;
  const bannedHit = banned.exec(panels);
  assert.equal(bannedHit, null, `kpi-coverage-rep-panels.tsx: "${bannedHit?.[0]}" breaks a house rule`);
  assert.ok(!panels.includes("…"), "no ellipsis in the panel's words");

  for (const colgroup of panels.matchAll(/<colgroup>([\s\S]*?)<\/colgroup>/g)) {
    const widths = [...colgroup[1].matchAll(/width: "(\d+(?:\.\d+)?)%"/g)].map((match) => Number(match[1]));
    assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, `a colgroup in the rep panels totals ${widths.join(" + ")}`);
  }
  // A table that can sit in half a row switches by its own width, never the viewport's.
  const tables = [...panels.matchAll(/<table className="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(tables.length >= 2);
  for (const table of tables) {
    assert.match(table, /\btable-fixed\b/, "every table is fixed-layout");
    assert.match(table, /@min-\[34rem\]:md:table/, "every table switches on its own container's width AND the desktop gate");
  }
  // No function crosses into the panels: links arrive as strings.
  assert.ok(!/hrefFor\??:\s*\(/.test(panels), "the panels take ready-made links, never a function");

  // The wiring: the summary is built from the WHOLE lists, and the Coverage row is told which report it is on.
  assert.match(view, /<CoverageSummary context=\{context\} detail=\{full\} \/>/, "the header reads the whole lists, not the filtered ones");
  assert.match(view, /kpiRepCoverageSummary\(detail, board\.coverageFloorPct\)/, "the floor is the board's own");
  assert.match(view, /kpiFloorPath\(detail, summary, board\.asOf\)/);
  assert.match(view, /kpiLateAgeing\(detail, board\.asOf\)/);
  assert.match(view, /report="coverage"/, "the Coverage table's rows leave other reports' flags out");
  assert.match(view, /report=\{tab\}/, "the phone card follows the same rule");
  assert.ok(!/function CoverageBreakdown\b/.test(view), "the old two-figure breakdown is gone, not left beside the new one");
}

export function runKpiCoverageRepDetailTests() {
  checkSummary();
  checkSentence();
  checkAgeing();
  checkFloorPath();
  checkGroups();
  checkWeeks();
  checkFlags();
  checkSource();
}
