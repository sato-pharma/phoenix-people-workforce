import assert from "node:assert/strict";

import { DEFAULT_DOCTOR_COVERAGE_NORMS } from "../src/lib/crm/doctor-coverage-config.ts";
import {
  buildRepDoctorListsBoard,
  type PlanRow,
  type VisitRow,
} from "../src/lib/crm/rep-doctor-lists.ts";
import {
  monthKeysBetween,
  nextMonthKey,
  REP_DOCTOR_TREND_FIRST_MONTH,
  REP_DOCTOR_TREND_MAX_MONTHS,
  stitchRepDoctorTrend,
} from "../src/lib/crm/rep-doctor-lists-trend.ts";

// Rep Coverage & Frequency, month over month.
//
// WHY THIS TEST EXISTS SEPARATELY FROM THE MONTH BOARD'S. The month board can only be wrong about
// one month at a time. This one compares months, and its characteristic failure is far worse: it can
// report a TREND that never happened. Two ways, both pinned below.
//
//   1. A rep with no plan in a month must read as a BLANK, never as 0%. Rendering him at zero says
//      "he reached none of his list" about a month he was not measured in — an accusation about
//      nothing. `cells[i] === null` is the only correct answer.
//
//   2. The company line changes population as it goes. Measured in production 2026-08-21, the plan
//      mirror holds 58 agents in January against 78 in August, and 32 of January's carry a NULL
//      `agent_hr_id` — the marker for a rep who has since left. The board drops departed agents, so
//      an early month is scored over the survivors only, and the company line rises for a reason
//      that has nothing to do with anybody's performance. The like-for-like cohort removes that
//      effect, and the fixture below reproduces it in miniature: a rep who leaves after the first
//      month drags the company average and must NOT drag the like-for-like one.

const NORMS = DEFAULT_DOCTOR_COVERAGE_NORMS;

function plan(month: string, overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    agent_crm_id: 101,
    agent_hr_id: "PHX-101",
    contact_crm_id: 1001,
    contact_grade: "A",
    contact_name: "Planned Contact",
    crm_region_name: "Cairo",
    plan_date: `${month}-05`,
    plan_status: 1,
    speciality: "Internal Medicine",
    synced_at: `${month}-20T09:00:00.000Z`,
    ...overrides,
  };
}

function visit(month: string, overrides: Partial<VisitRow> = {}): VisitRow {
  return {
    agent_crm_id: 101,
    agent_hr_id: "PHX-101",
    agent_name: "Rep One",
    contact_crm_id: 1001,
    crm_contact_grade: "A",
    speciality: "Internal Medicine",
    visit_date: `${month}-06`,
    visit_type: 0,
    ...overrides,
  };
}

/** Builds one closed month through the REAL fold, so the trend can never be tested against a
 * definition of coverage the board does not share. `asOf` is pinned past each month's end so every
 * fixture month is complete and the to-date basis never enters these assertions. */
function board(month: string, planRows: PlanRow[], visitRows: VisitRow[]) {
  return buildRepDoctorListsBoard({
    asOf: `${month}-28`,
    employeeNameByHrId: new Map([
      ["PHX-101", "Rep One"],
      ["PHX-202", "Rep Two"],
    ]),
    excludedAgentCrmIds: [],
    month,
    norms: NORMS,
    planRows,
    visitRows,
  });
}

export function runCrmRepDoctorTrendTests(): void {
  // ── Month arithmetic — string only, never a Date ───────────────────────────────────────────
  assert.equal(nextMonthKey("2026-01"), "2026-02", "next month inside a year");
  assert.equal(nextMonthKey("2026-12"), "2027-01", "December must roll the year, not the month");
  assert.equal(nextMonthKey("2026-09"), "2026-10", "the 09 → 10 step must not lose its zero padding");

  assert.deepEqual(
    monthKeysBetween("2026-01", "2026-04"),
    ["2026-01", "2026-02", "2026-03", "2026-04"],
    "the range is inclusive at both ends",
  );
  assert.deepEqual(monthKeysBetween("2026-05", "2026-05"), ["2026-05"], "a single-month range is that month");
  assert.deepEqual(monthKeysBetween("2026-06", "2026-03"), [], "an inverted range yields nothing, never a crash");
  assert.deepEqual(
    monthKeysBetween("2025-01", "2026-02"),
    [REP_DOCTOR_TREND_FIRST_MONTH, "2026-02"],
    "a start before the mirror's first month is clamped, not scanned — earlier months hold no plan at all and would render as a truthful-looking 0%",
  );
  assert.equal(
    monthKeysBetween("2026-01", "2099-01").length,
    REP_DOCTOR_TREND_MAX_MONTHS,
    "an unbounded range is capped rather than left to scan forever",
  );

  // ── A rep absent from a month is BLANK, never 0% ───────────────────────────────────────────
  //
  // Rep 101 works both months. Rep 202 appears only in February. January's cell for rep 202 must be
  // null — and his coverage change must be measured from February, his first MEASURED month, not
  // from an invented January zero.
  const janOnlyOne = board(
    "2026-01",
    [plan("2026-01"), plan("2026-01", { contact_crm_id: 1002, contact_name: "Second Doctor" })],
    [visit("2026-01")],
  );
  const febBoth = board(
    "2026-02",
    [
      plan("2026-02"),
      plan("2026-02", { contact_crm_id: 1002, contact_name: "Second Doctor" }),
      plan("2026-02", { agent_crm_id: 202, agent_hr_id: "PHX-202", contact_crm_id: 2001, contact_name: "Two's Doctor" }),
    ],
    [
      visit("2026-02"),
      visit("2026-02", { contact_crm_id: 1002 }),
      visit("2026-02", { agent_crm_id: 202, agent_hr_id: "PHX-202", agent_name: "Rep Two", contact_crm_id: 2001 }),
    ],
  );

  const twoMonths = stitchRepDoctorTrend([janOnlyOne, febBoth]);
  assert.deepEqual(twoMonths.months, ["2026-01", "2026-02"], "the x axis is the boards' own months, in order");

  const repTwo = twoMonths.reps.find((series) => series.repName === "Rep Two");
  assert.ok(repTwo, "rep two must appear in the series");
  assert.equal(repTwo.cells.length, 2, "every series carries one cell per month, aligned by index");
  assert.equal(
    repTwo.cells[0],
    null,
    "a rep with no plan in January must be BLANK for January — a 0% there accuses him of a month he was never measured in",
  );
  assert.equal(repTwo.cells[1]?.coveragePct, 100, "February is his first measured month and he reached his one doctor");
  assert.equal(
    repTwo.coverageChange,
    null,
    "one measured month is no change at all — it must not be reported as +100 against a January he was absent from",
  );
  assert.equal(repTwo.measuredMonths, 1, "measuredMonths counts non-null cells only");

  const repOne = twoMonths.reps.find((series) => series.repName === "Rep One");
  assert.ok(repOne, "rep one must appear in the series");
  assert.equal(repOne.cells[0]?.coveragePct, 50, "January: one of two planned doctors reached");
  assert.equal(repOne.cells[1]?.coveragePct, 100, "February: both reached");
  assert.equal(repOne.coverageChange, 50, "first measured month to latest, in points");
  assert.equal(repOne.cells[1]?.coverageDelta, 50, "the per-month delta is against the previous MEASURED point");
  assert.equal(repOne.cells[0]?.coverageDelta, null, "the first point in a series has nothing to compare against");
  assert.equal(repOne.cells[1]?.listDelta, 0, "his list did not change size between the two months");

  // ── The company line moves with its population; like-for-like does not ─────────────────────
  //
  // January: rep 101 reaches 1 of 2 (50%), rep 202 reaches 2 of 2 (100%) — company 3 of 4 = 75%.
  // February: rep 202 has LEFT and is excluded, exactly as a departed agent is in production.
  // Rep 101 still reaches 1 of 2. The company line therefore FALLS 75% → 50% purely because the
  // stronger rep left, while rep 101 himself did not change at all.
  const janTwoReps = board(
    "2026-01",
    [
      plan("2026-01"),
      plan("2026-01", { contact_crm_id: 1002, contact_name: "Second Doctor" }),
      plan("2026-01", { agent_crm_id: 202, agent_hr_id: "PHX-202", contact_crm_id: 2001, contact_name: "Two's First" }),
      plan("2026-01", { agent_crm_id: 202, agent_hr_id: "PHX-202", contact_crm_id: 2002, contact_name: "Two's Second" }),
    ],
    [
      visit("2026-01"),
      visit("2026-01", { agent_crm_id: 202, agent_hr_id: "PHX-202", agent_name: "Rep Two", contact_crm_id: 2001 }),
      visit("2026-01", { agent_crm_id: 202, agent_hr_id: "PHX-202", agent_name: "Rep Two", contact_crm_id: 2002 }),
    ],
  );
  const febOneLeft = board(
    "2026-02",
    [plan("2026-02"), plan("2026-02", { contact_crm_id: 1002, contact_name: "Second Doctor" })],
    [visit("2026-02")],
  );

  const withDeparture = stitchRepDoctorTrend([janTwoReps, febOneLeft]);
  assert.equal(withDeparture.company[0].coveragePct, 75, "January company: 3 of 4 planned doctors reached");
  assert.equal(withDeparture.company[1].coveragePct, 50, "February company: 1 of 2, because the stronger rep is gone");
  assert.equal(
    withDeparture.company[1].coverageDelta,
    -25,
    "the company line falls 25 points on a change in WHO is measured, not on anybody's performance",
  );
  assert.equal(withDeparture.company[0].measuredReps, 2, "January measured two reps");
  assert.equal(withDeparture.company[1].measuredReps, 1, "February measured one");

  assert.equal(withDeparture.likeForLikeReps, 1, "only rep 101 is present in both months");
  assert.equal(withDeparture.likeForLike.length, 2, "the cohort line covers every month in the range");
  assert.equal(withDeparture.likeForLike[0].coveragePct, 50, "cohort January: rep 101 alone, 1 of 2");
  assert.equal(withDeparture.likeForLike[1].coveragePct, 50, "cohort February: rep 101 alone, still 1 of 2");
  assert.equal(
    withDeparture.likeForLike[1].coverageDelta,
    0,
    "THE POINT OF THE COHORT: the same rep did the same thing, so the like-for-like line is flat while the company line fell 25 points",
  );

  // The cohort is re-aggregated from summed COUNTS, never by averaging the reps' percentages — a
  // rep with 21 doctors and one with 234 both exist in production and must not weigh the same.
  assert.equal(withDeparture.likeForLike[0].plannedDoctors, 2, "cohort planned doctors are summed, not averaged");
  assert.equal(withDeparture.likeForLike[0].visitedDoctors, 1, "cohort visited doctors are summed, not averaged");
  assert.equal(
    withDeparture.likeForLike[0].measuredReps,
    1,
    "the cohort is the same size in every month by construction — that is what makes it comparable",
  );

  // A rep measured in NO month of the range cannot form a cohort of zero that then divides by zero.
  const emptyCohort = stitchRepDoctorTrend([]);
  assert.deepEqual(emptyCohort.months, [], "an empty board list is an empty series, not a crash");
  assert.equal(emptyCohort.likeForLikeReps, 0, "no boards means no cohort");
  assert.deepEqual(emptyCohort.likeForLike, [], "and no cohort line to read");

  // ── Frequency travels with coverage, on the same population rule ───────────────────────────
  //
  // Rep 101 plans doctor 1001 twice in February and visits twice — exactly on plan. Doctor 1002 is
  // planned once and never visited. So 1 of 2 due doctors is on plan: 50%.
  const febFrequency = board(
    "2026-02",
    [
      plan("2026-02"),
      plan("2026-02", { plan_date: "2026-02-12" }),
      plan("2026-02", { contact_crm_id: 1002, contact_name: "Second Doctor" }),
    ],
    [visit("2026-02"), visit("2026-02", { visit_date: "2026-02-13" })],
  );
  const freqTrend = stitchRepDoctorTrend([febFrequency]);
  assert.equal(freqTrend.company[0].frequencyPct, 50, "one of two due doctors matched the plan exactly");
  assert.equal(freqTrend.company[0].dueDoctors, 2, "both doctors are due in a closed month");
  assert.equal(
    freqTrend.company[0].onPlanDoctors,
    1,
    "the doctor planned twice and visited twice is the only exact match",
  );
  assert.equal(
    freqTrend.reps[0].cells[0]?.frequencyPct,
    50,
    "the rep's own frequency matches the company's when he is the only rep",
  );

  // ── Ranking: worst change first, unrankable reps last ──────────────────────────────────────
  //
  // The whole purpose of a trend is to find who is sliding, so the biggest FALL must sort first —
  // and a rep with only one measured month has no change to rank on and must not displace one.
  const ranked = stitchRepDoctorTrend([janOnlyOne, febBoth]);
  assert.equal(
    ranked.reps[ranked.reps.length - 1].repName,
    "Rep Two",
    "a rep with a single measured month sorts last, behind everyone who has a real change",
  );
}
