import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  KPI_SHORT_DEPTHS,
  kpiFrequencyByGrade,
  kpiFrequencyBySpeciality,
  kpiFrequencyByWeek,
  kpiFrequencyFirstSteps,
  kpiFrequencyGap,
  kpiFrequencyGapText,
  kpiFrequencyJudged,
  kpiFrequencyOwed,
  kpiFrequencyPasses,
  kpiFrequencyRowsOf,
  kpiFrequencySentence,
  kpiFrequencyStepWhy,
  kpiOneMoreVisitLift,
  kpiRepFrequencySummary,
  kpiShortDepthOf,
  kpiShortDepths,
} from "../src/lib/crm/kpi-frequency-rep-detail.ts";
import { KPI_NO_SPECIALITY } from "../src/lib/crm/kpi-coverage-rep-detail.ts";
import type { KpiCoverageDetail, KpiCoverageDoctor } from "../src/lib/crm/kpis-board.ts";
import type { DoctorFrequency } from "../src/lib/crm/phoenix-kpi-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * ONE REP'S FREQUENCY, READ CLOSELY (the Frequency premium pass, owner 9 Nov 2026: "eyeball every report in My
 * Team's Reports, premium polish big work, every single component").
 *
 * What would go wrong, each without an error anyone could see:
 *
 *   1. tiles that do not add up to the rep's row — the manager reads 13% on the row and 25% in the panel and
 *      stops trusting both;
 *   2. a "short" that counts a doctor whose planned days are all still ahead, accusing a rep of a visit that is
 *      not late;
 *   3. a gap that measures a plan-basis shortfall against the WHOLE month instead of what has come due, or an
 *      excess against what has come due instead of the whole month (`frequencyStatusOf`'s asymmetry);
 *   4. "one more visit each" that counts a never-visited A doctor asked for three, whom one visit cannot pass;
 *   5. a group or week table whose rows do not add up to the list;
 *   6. a panel that slips back to gloss, round corners or a horizontal scroll.
 *
 * Every figure is worked out by hand on a fixed list of nine doctors below, and the panel's finish is read in
 * the source with comments stripped.
 */

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

const AS_OF = "2026-11-15";

function plan(required: number, dueSoFar: number, actual: number, status: DoctorFrequency["status"]): DoctorFrequency {
  return { basis: "plan", required, dueSoFar, actual, status };
}

let nextId = 1;
function doctor(input: {
  name: string | null;
  grade: string | null;
  speciality?: string | null;
  planDates: string[];
  frequency: DoctorFrequency;
  lastVisitDate?: string | null;
}): KpiCoverageDoctor {
  return {
    contactCrmId: nextId++,
    name: input.name,
    speciality: input.speciality ?? null,
    grade: input.grade,
    visits: input.frequency.actual,
    lastVisitDate: input.lastVisitDate ?? (input.frequency.actual > 0 ? "2026-11-10" : null),
    planDates: input.planDates,
    frequency: input.frequency,
    due: input.frequency.status !== "not-due",
  };
}

/**
 * Nine doctors on the original rules (plan basis), as of 15 Nov:
 *
 *   Amal    A  asked 3  due 3  made 3  exact
 *   Basma   A  asked 3  due 2  made 1  below        1 owed
 *   Camelia B  asked 2  due 2  made 0  not visited  2 owed
 *   Dalia   B  asked 2  due 2  made 3  above        (1 extra)
 *   Eman    C  asked 2  due 0  made 0  not due
 *   Fadi    —  asked 4  due 4  made 0  not visited  4 owed
 *   Ghada   C  asked 4  due 4  made 2  below        2 owed
 *   Hala    A  asked 1  due 1  made 0  not visited  1 owed
 *   Ismail  C  asked 5  due 5  made 1  below        4 owed
 */
function sampleDetail(): KpiCoverageDetail {
  nextId = 1;
  const all = [
    doctor({ name: "Dr Amal", grade: "A", speciality: "Pediatrics", planDates: ["2026-11-02"], frequency: plan(3, 3, 3, "exact") }),
    doctor({ name: "Dr Basma", grade: "A", speciality: "Pediatrics", planDates: ["2026-11-03", "2026-11-10", "2026-11-17"], frequency: plan(3, 2, 1, "below") }),
    doctor({ name: "Dr Camelia", grade: "B", speciality: "Cardiology", planDates: ["2026-11-09"], frequency: plan(2, 2, 0, "not-visited") }),
    doctor({ name: "Dr Dalia", grade: "B", speciality: "Cardiology", planDates: ["2026-11-01"], frequency: plan(2, 2, 3, "above") }),
    doctor({ name: "Dr Eman", grade: "C", speciality: null, planDates: ["2026-11-23"], frequency: plan(2, 0, 0, "not-due") }),
    doctor({ name: "Dr Fadi", grade: null, speciality: "Pediatrics", planDates: [], frequency: plan(4, 4, 0, "not-visited") }),
    doctor({ name: "Dr Ghada", grade: "C", speciality: "Pediatrics", planDates: ["2026-11-11"], frequency: plan(4, 4, 2, "below") }),
    doctor({ name: "Dr Hala", grade: "A", speciality: "Cardiology", planDates: ["2026-11-05"], frequency: plan(1, 1, 0, "not-visited") }),
    doctor({ name: "Dr Ismail", grade: "C", speciality: "Pediatrics", planDates: ["2026-11-12"], frequency: plan(5, 5, 1, "below") }),
  ];
  return {
    repKey: "1",
    repName: "Momen Fathy",
    covered: all.filter((entry) => entry.visits > 0),
    notCovered: all.filter((entry) => entry.visits === 0),
  };
}

const named = (rows: ReadonlyArray<{ doctor: KpiCoverageDoctor }>) => rows.map((row) => row.doctor.name);

// ── 1. The verdicts and the gap ─────────────────────────────────────────────────────────────────

function checkVerdictsAndGap() {
  assert.ok(kpiFrequencyPasses("exact") && kpiFrequencyPasses("at-norm"), "exact and at-norm are the two passes");
  for (const status of ["below", "above", "not-visited", "not-due", "ungraded"] as const) {
    assert.equal(kpiFrequencyPasses(status), false, `${status} never passes`);
  }
  assert.equal(kpiFrequencyJudged("not-due"), false, "a doctor whose days are all ahead is not judged yet");
  assert.equal(kpiFrequencyJudged("ungraded"), false, "a doctor with no grade has no norm to be judged on");
  assert.equal(kpiFrequencyJudged("above"), true, "above is judged — a deviation on the original rules");

  // Short is measured against what has come DUE; extra against the WHOLE period (frequencyStatusOf's asymmetry).
  assert.equal(kpiFrequencyGap(plan(3, 2, 1, "below")), -1, "behind today's schedule by one, not by two");
  assert.equal(kpiFrequencyGapText(plan(3, 2, 1, "below")), "1 short");
  assert.equal(kpiFrequencyGap(plan(2, 2, 3, "above")), 1, "past the month's total by one");
  assert.equal(kpiFrequencyGapText(plan(2, 2, 3, "above")), "1 extra");
  assert.equal(kpiFrequencyGapText(plan(3, 1, 2, "exact")), "1 ahead", "ahead of the schedule inside the month is still exact, not extra");
  assert.equal(kpiFrequencyGapText(plan(3, 3, 3, "exact")), "On target");
  assert.equal(kpiFrequencyGap(plan(2, 0, 0, "not-due")), null, "not due: nothing to compare");
  assert.equal(kpiFrequencyGapText(plan(2, 0, 0, "not-due")), "—");
  // The grade basis: the norm is monthly, so dueSoFar is the norm and an extra visit is fine but still "extra".
  const grade = (required: number | null, actual: number, status: DoctorFrequency["status"]): DoctorFrequency => ({
    basis: "grade",
    required,
    dueSoFar: required,
    actual,
    status,
  });
  assert.equal(kpiFrequencyGapText(grade(3, 4, "at-norm")), "1 extra");
  assert.equal(kpiFrequencyGapText(grade(2, 1, "below")), "1 short");
  assert.equal(kpiFrequencyGapText(grade(null, 2, "ungraded")), "—", "an ungraded doctor has no gap");

  assert.equal(kpiFrequencyOwed(plan(3, 2, 1, "below")), 1);
  assert.equal(kpiFrequencyOwed(plan(2, 2, 3, "above")), 0, "an extra visit owes nothing");
  assert.equal(kpiFrequencyOwed(plan(2, 0, 0, "not-due")), 0, "a doctor not due owes nothing — never an accusation");
  assert.equal(
    kpiFrequencyOwed({ basis: "plan", required: 2, dueSoFar: null, actual: 0, status: "not-due" }),
    0,
    "nor when the due count is missing: the verdict says not due, so the whole month is not owed today",
  );
  assert.equal(kpiFrequencyOwed(grade(null, 0, "ungraded")), 0);
}

// ── 2. The summary adds up to the row ───────────────────────────────────────────────────────────

function checkSummary() {
  const detail = sampleDetail();
  assert.equal(kpiFrequencyRowsOf(detail).length, 9, "both lists, every doctor with a verdict");
  const summary = kpiRepFrequencySummary(detail);
  assert.ok(summary, "a list with verdicts has a summary");
  assert.equal(summary.doctors, 9);
  assert.equal(summary.judged, 8, "everyone but Eman, whose only planned day is the 23rd");
  assert.equal(summary.passing, 1, "Amal alone is exact");
  assert.equal(summary.pct, 13, "1 of 8, rounded");
  assert.equal(summary.asked, 26, "3+3+2+2+2+4+4+1+5");
  assert.equal(summary.due, 23, "Eman's two have not come due, Basma's third has not either");
  assert.equal(summary.made, 10, "3+1+0+3+0+0+2+0+1");
  assert.equal(summary.owed, 14, "Basma 1, Camelia 2, Fadi 4, Ghada 2, Hala 1, Ismail 4");
  assert.equal(summary.extra, 1, "Dalia's third visit");
  assert.equal(summary.short, 6);
  assert.equal(summary.neverVisited, 3, "Camelia, Fadi and Hala");
  assert.equal(summary.notDue, 1);
  assert.equal(summary.ungraded, 0);
  assert.deepEqual(
    Object.fromEntries(summary.byStatus),
    { exact: 1, below: 3, "not-visited": 3, above: 1, "not-due": 1 },
    "the verdict counts are the chips' counts",
  );
  // A list with no verdict at all says so, never a 0%.
  assert.equal(kpiRepFrequencySummary({ covered: [], notCovered: [] }), null);
  const allAhead = kpiRepFrequencySummary({
    covered: [],
    notCovered: [doctor({ name: "Dr Later", grade: "A", planDates: ["2026-11-29"], frequency: plan(1, 0, 0, "not-due") })],
  });
  assert.ok(allAhead);
  assert.equal(allAhead.pct, null, "nobody judged yet: no percentage, never 0%");
  assert.equal(allAhead.owed, 0);
}

// ── 3. How far short, and one more visit each ───────────────────────────────────────────────────

function checkDepthsAndLift() {
  const detail = sampleDetail();
  const buckets = kpiShortDepths(detail);
  assert.deepEqual(buckets.map((bucket) => bucket.depth), [...KPI_SHORT_DEPTHS], "four depths, closest to the pass first");
  assert.deepEqual(
    buckets.map((bucket) => [bucket.depth, named(bucket.rows), bucket.owed]),
    [
      ["one", ["Dr Basma"], 1],
      ["two", ["Dr Ghada"], 2],
      ["three-plus", ["Dr Ismail"], 4],
      ["never", ["Dr Camelia", "Dr Fadi", "Dr Hala"], 7],
    ],
  );
  const summary = kpiRepFrequencySummary(detail)!;
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.rows.length, 0), summary.short, "the depths add up to Doctors short");
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.owed, 0), summary.owed, "and their owed visits to Visits owed");
  assert.equal(kpiShortDepthOf(plan(2, 2, 0, "not-visited")), "never", "never visited is its own depth, however few are owed");
  assert.equal(kpiShortDepthOf(plan(6, 6, 2, "below")), "three-plus");
  assert.equal(kpiShortDepthOf(plan(2, 0, 0, "not-due")), null, "a doctor not due is never short");

  // Basma (1 short) and Hala (never visited, asked for 1): one visit each passes both. Camelia, asked for 2, does not.
  const lift = kpiOneMoreVisitLift(summary, buckets);
  assert.deepEqual(lift, { doctors: 2, pct: 38 }, "(1 + 2) of 8, rounded");
  assert.equal(
    kpiOneMoreVisitLift(summary, buckets.map((bucket) => ({ ...bucket, rows: [] }))),
    null,
    "nobody one visit short: no line at all",
  );
}

// ── 4. Who to go back to first ──────────────────────────────────────────────────────────────────

function checkFirstSteps() {
  const detail = sampleDetail();
  const steps = kpiFrequencyFirstSteps(detail, AS_OF, 8);
  assert.deepEqual(
    named(steps),
    ["Dr Basma", "Dr Hala", "Dr Camelia", "Dr Ismail", "Dr Ghada", "Dr Fadi"],
    "a single visit's pass first (A, by name), then by grade, then the most owed, the ungraded doctor last",
  );
  assert.ok(steps.every((step) => step.owed > 0), "only doctors who owe a visit");
  assert.ok(!named(steps).includes("Dr Eman"), "a doctor not due is never sent for");
  assert.ok(!named(steps).includes("Dr Dalia"), "nor a doctor seen too often");
  assert.deepEqual(steps[0].ahead, ["2026-11-17"], "Basma's plan already brings her back on the 17th");
  assert.equal(kpiFrequencyStepWhy(steps[0]), "1 short · 1 of 2 made · next planned 17\u00a0Nov");
  assert.equal(kpiFrequencyStepWhy(steps[1]), "1 short · never visited", "no visit and no day ahead: nothing more to say");
  assert.equal(kpiFrequencyStepWhy(steps[3]), "4 short · 1 of 5 made · last 10\u00a0Nov");
  assert.equal(kpiFrequencyFirstSteps(detail, AS_OF, 2).length, 2, "the limit caps the panel, never the list below");
}

// ── 5. The breakdowns add up ────────────────────────────────────────────────────────────────────

function checkBreakdowns() {
  const detail = sampleDetail();
  const summary = kpiRepFrequencySummary(detail)!;
  const grades = kpiFrequencyByGrade(detail);
  assert.deepEqual(
    grades.map((group) => [group.label, group.doctors, group.judged, group.passing, group.pct, group.asked, group.made, group.owed, group.short]),
    [
      ["Grade A", 3, 3, 1, 33, 7, 4, 2, 2],
      ["Grade B", 2, 2, 0, 0, 4, 3, 2, 1],
      ["Grade C", 3, 2, 0, 0, 11, 3, 6, 2],
      ["No grade", 1, 1, 0, 0, 4, 0, 4, 1],
    ],
    "A, B, C, then no grade — and Eman, not due, is a doctor of Grade C but not one of its judged",
  );
  const sum = (rows: ReadonlyArray<{ doctors: number; owed: number; judged: number; passing: number }>, key: "doctors" | "owed" | "judged" | "passing") =>
    rows.reduce((total, row) => total + row[key], 0);
  for (const key of ["doctors", "owed", "judged", "passing"] as const) {
    assert.equal(sum(grades, key), key === "doctors" ? summary.doctors : summary[key], `the grades add up to the summary's ${key}`);
  }

  const specialities = kpiFrequencyBySpeciality(detail);
  assert.deepEqual(
    specialities.map((group) => [group.label, group.doctors, group.owed]),
    [
      ["Pediatrics", 5, 11],
      ["Cardiology", 3, 3],
      [KPI_NO_SPECIALITY, 1, 0],
    ],
    "the most owed first; a doctor with no speciality filed under the coverage report's own words",
  );
  assert.equal(sum(specialities, "doctors"), 9);

  const weeks = kpiFrequencyByWeek(detail, AS_OF);
  assert.deepEqual(
    weeks.map((week) => [week.key, week.doctors, week.ahead]),
    [
      ["w1", 4, false],
      ["w2", 3, false],
      ["w4", 1, true],
      ["none", 1, false],
    ],
    "by the week first planned, calendar order, a week not begun marked, the doctor booked on no day last",
  );
  assert.equal(weeks[0].label, "Week 1 · 1–7\u00a0Nov");
  assert.equal(weeks.at(-1)!.label, "No day on the plan");
  assert.equal(sum(weeks, "doctors"), 9, "every doctor counted once");
  assert.equal(sum(weeks, "owed"), summary.owed);
  assert.equal(weeks[2].pct, null, "a week whose doctors are all not due has no percentage, never 0%");
}

// ── 6. The sentence ─────────────────────────────────────────────────────────────────────────────

function checkSentence() {
  const detail = sampleDetail();
  const summary = kpiRepFrequencySummary(detail)!;
  const lift = kpiOneMoreVisitLift(summary, kpiShortDepths(detail));
  assert.equal(
    kpiFrequencySentence(summary, lift, false),
    "1 of 8 doctors judged are visited exactly as planned. 6 doctors are short, 14 visits owed in all, 3 of them never visited. One more visit each to the 2 doctors one visit short lifts frequency to 38%.",
  );
  assert.ok(kpiFrequencySentence(summary, lift, true).includes("at their grade's norm"), "the Phoenix rules' own words");
  assert.ok(!/floor/i.test(kpiFrequencySentence(summary, lift, false)), "frequency has no floor — the sentence never invents one");
  const nobodyShort = { ...summary, short: 0, owed: 0, neverVisited: 0 };
  assert.equal(
    kpiFrequencySentence(nobodyShort, null, false),
    "1 of 8 doctors judged are visited exactly as planned. Nobody is short; the deviations are doctors seen more often than planned.",
  );
  assert.equal(
    kpiFrequencySentence({ ...summary, judged: 0, passing: 0, pct: null }, null, false),
    "Nobody on this list can be judged yet: every planned day is still ahead.",
  );
}

// ── 7. The Phoenix rules (grade basis) ──────────────────────────────────────────────────────────

/**
 * Six doctors on the Phoenix rules: the norm is monthly, so what has come due IS the norm.
 *
 *   Amal    A  norm 3  made 4  at norm      (1 extra — fine under rule 7)
 *   Basma   A  norm 3  made 2  below        1 owed
 *   Camelia B  norm 2  made 0  not visited  2 owed
 *   Dalia   C  norm 1  made 1  at norm
 *   Eman    —  no norm made 2  ungraded     left out of the percentage
 *   Fadi    C  norm 1  made 0  not visited  1 owed
 */
function phoenixDetail(): KpiCoverageDetail {
  nextId = 100;
  const grade = (required: number | null, actual: number, status: DoctorFrequency["status"]): DoctorFrequency => ({
    basis: "grade",
    required,
    dueSoFar: required,
    actual,
    status,
  });
  const all = [
    doctor({ name: "Dr Amal", grade: "A", planDates: ["2026-11-02"], frequency: grade(3, 4, "at-norm") }),
    doctor({ name: "Dr Basma", grade: "A", planDates: ["2026-11-03"], frequency: grade(3, 2, "below") }),
    doctor({ name: "Dr Camelia", grade: "B", planDates: ["2026-11-09"], frequency: grade(2, 0, "not-visited") }),
    doctor({ name: "Dr Dalia", grade: "C", planDates: ["2026-11-04"], frequency: grade(1, 1, "at-norm") }),
    doctor({ name: "Dr Eman", grade: null, planDates: ["2026-11-05"], frequency: grade(null, 2, "ungraded") }),
    doctor({ name: "Dr Fadi", grade: "C", planDates: ["2026-11-20"], frequency: grade(1, 0, "not-visited") }),
  ];
  return {
    repKey: "2",
    repName: "Sara Adel",
    covered: all.filter((entry) => entry.visits > 0),
    notCovered: all.filter((entry) => entry.visits === 0),
  };
}

function checkPhoenixDetail() {
  const detail = phoenixDetail();
  const summary = kpiRepFrequencySummary(detail);
  assert.ok(summary);
  assert.equal(summary.doctors, 6);
  assert.equal(summary.judged, 5, "Eman has no grade, so no norm: rule 7 leaves her out");
  assert.equal(summary.ungraded, 1);
  assert.equal(summary.passing, 2, "Amal and Dalia — at or over the norm is the pass");
  assert.equal(summary.pct, 40);
  assert.equal(summary.asked, 10, "3+3+2+1+1 — the ungraded doctor asks for nothing");
  assert.equal(summary.due, 10, "the grade norm is monthly, so all of it has come due");
  assert.equal(summary.made, 7, "4+2+0+1+0 — Eman's two visits are hers, not the norm's");
  assert.equal(summary.owed, 4);
  assert.equal(summary.extra, 1, "Amal's fourth visit");
  assert.deepEqual([summary.short, summary.neverVisited], [3, 2]);

  assert.equal(kpiFrequencyGapText(detail.covered[0].frequency!), "1 extra", "seen over the norm is said plainly");
  assert.equal(kpiFrequencyOwed(detail.covered[0].frequency!), 0, "and owes nothing");
  const eman = detail.covered.find((entry) => entry.name === "Dr Eman")!;
  assert.equal(kpiFrequencyGapText(eman.frequency!), "—", "no norm, no gap");
  assert.equal(kpiShortDepthOf(eman.frequency!), null, "an ungraded doctor is never short of a norm her grade does not set");

  const buckets = kpiShortDepths(detail);
  assert.deepEqual(
    buckets.map((bucket) => [bucket.depth, named(bucket.rows), bucket.owed]),
    [
      ["one", ["Dr Basma"], 1],
      ["two", [], 0],
      ["three-plus", [], 0],
      ["never", ["Dr Camelia", "Dr Fadi"], 3],
    ],
  );
  const lift = kpiOneMoreVisitLift(summary, buckets);
  assert.deepEqual(lift, { doctors: 2, pct: 80 }, "Basma and Fadi pass with one visit each: (2 + 2) of 5");

  assert.deepEqual(
    named(kpiFrequencyFirstSteps(detail, AS_OF)),
    ["Dr Basma", "Dr Fadi", "Dr Camelia"],
    "the single visits first, A before C, then the doctor who owes two",
  );
  assert.ok(!named(kpiFrequencyFirstSteps(detail, AS_OF)).includes("Dr Eman"), "the ungraded doctor is never sent for");
  assert.deepEqual(
    kpiFrequencyByGrade(detail).map((group) => [group.label, group.judged, group.passing, group.owed]),
    [
      ["Grade A", 2, 1, 1],
      ["Grade B", 1, 0, 2],
      ["Grade C", 2, 1, 1],
      ["No grade", 0, 0, 0],
    ],
    "the no-grade group is on the table with nobody judged in it",
  );
  assert.equal(kpiFrequencyByGrade(detail).at(-1)!.pct, null, "and no percentage, never 0%");

  assert.equal(
    kpiFrequencySentence(summary, lift, true),
    "2 of 5 doctors judged are at their grade's norm. 3 doctors are short, 4 visits owed in all, 2 of them never visited. One more visit each to the 2 doctors one visit short lifts frequency to 80%.",
  );
  // Over the norm is never a deviation on these rules, so nobody short reads as nobody short — not "deviations".
  assert.equal(
    kpiFrequencySentence({ ...summary, short: 0, owed: 0, neverVisited: 0 }, null, true),
    "2 of 5 doctors judged are at their grade's norm. Nobody is short of what has come due.",
  );
  assert.equal(
    kpiFrequencySentence({ ...summary, judged: 0, passing: 0, pct: null }, null, true),
    "Nobody on this list can be judged yet: every planned doctor is ungraded.",
  );
}

// ── 8. The panel in the source ──────────────────────────────────────────────────────────────────

function checkSource() {
  const panels = stripComments(read("src/components/crm/kpi-frequency-rep-panels.tsx"));
  assert.ok(!panels.includes('"use client"'), "markup only: the board stays a server component");
  for (const banned of ["gradient", "shadow-", "rounded", "blur", "glow", "min-w-[", "overflow-x-auto", "truncate", "text-ellipsis"]) {
    assert.ok(!panels.includes(banned), `the rep panel is flat, square and never scrolls sideways: no ${banned}`);
  }
  assert.ok(!panels.includes("cn("), "text-phx-* never goes through cn()");
  assert.equal((panels.match(/table-fixed @min-\[34rem\]:md:table/g) ?? []).length, 2, "both tables wear the CRM desktop gate as well as their container switch");
  assert.equal((panels.match(/@min-\[34rem\]:md:hidden/g) ?? []).length, 2, "and both have their rows beside them");

  const view = stripComments(read("src/components/crm/kpis-board-view.tsx"));
  const body = view.slice(view.indexOf("function FrequencyDoctors("), view.indexOf("// ── The Call Rate report"));
  assert.ok(body.includes("const summary = kpiRepFrequencySummary(detail);"), "the panel counts the WHOLE list, never the filtered rows");
  assert.ok(body.includes("<KpiRepFrequencyTiles phoenix={phoenix} summary={summary} />"));
  assert.ok(body.includes("<KpiFrequencyTrack"));
  assert.ok(body.includes("<KpiFrequencyFirstPanel phoenix={phoenix} steps={steps} total={summary.short} />"));
  assert.ok(body.includes("<KpiShortDepthPanel buckets={buckets} shortHref={doctorHref({ statuses: shortStatuses })} />"));
  assert.ok(body.includes("<KpiFrequencyWeekTable phoenix={phoenix} weeks={weeks} />"));
  assert.ok(body.includes('const shortStatuses: KpiDoctorStatus[] = ["below", "not-visited"];'), "a short link opens exactly the doctors counted short");
  assert.ok(body.includes("short: doctorHref({ ...patch, statuses: shortStatuses }),"), "each group's short count opens that group's short doctors");
  assert.ok(!/function frequencyGap\(/.test(view), "the gap lives in the library, so the screen and the file print the same words");
}

export async function runKpiFrequencyRepDetailTests() {
  checkVerdictsAndGap();
  checkSummary();
  checkDepthsAndLift();
  checkFirstSteps();
  checkBreakdowns();
  checkSentence();
  checkPhoenixDetail();
  checkSource();
}
