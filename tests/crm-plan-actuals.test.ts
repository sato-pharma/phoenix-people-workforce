import assert from "node:assert/strict";

import { buildPlanActuals, planDayActual, planRowVerdict } from "../src/lib/crm/plan-actuals.ts";
import { buildPlanDoctorDays } from "../src/lib/crm/plan-doctors.ts";
import type { PlanEntryRow } from "../src/lib/crm/plan-board.ts";

/**
 * PLAN VERSUS ACTUAL — the marks a manager reads beside a plan he is about to sign.
 *
 * Every assertion here is about an accusation against a named rep, so the ones that matter most are
 * the ones proving the board STAYS QUIET: a plan for a day that has not happened, a doctor visited on
 * a different day of the same week, and a visits read that failed. Each of those renders red under a
 * naive implementation, and each would be wrong.
 */
export function runCrmPlanActualsTests() {
  const TODAY = "2026-09-03";

  const actuals = buildPlanActuals(
    [
      // Kept: doctor 1, on the day he was planned.
      { campaign: false, contactCrmId: 1, dateIso: "2026-08-31" },
      // Moved: doctor 2 was planned Monday and seen Tuesday.
      { campaign: false, contactCrmId: 2, dateIso: "2026-09-01" },
      // A campaign call names NO doctor. It counts for the day and can satisfy no planned row.
      { campaign: true, contactCrmId: null, dateIso: "2026-08-31" },
      { campaign: true, contactCrmId: null, dateIso: "2026-08-31" },
      // Seen TODAY. The day is not over, so nothing about it can be judged yet — except this.
      { campaign: false, contactCrmId: 7, dateIso: TODAY },
      // A dateless row is unusable and must not become a phantom day.
      { campaign: false, contactCrmId: 9, dateIso: null },
    ],
    TODAY,
  );

  // ── THE FIVE VERDICTS ─────────────────────────────────────────────────────────────────────────
  assert.equal(
    planRowVerdict(actuals, { contactCrmId: 1, date: "2026-08-31" }),
    "visited",
    "the plain case: planned Sunday, seen Sunday",
  );
  assert.equal(
    planRowVerdict(actuals, { contactCrmId: 2, date: "2026-08-31" }),
    "moved",
    "THE ONE THAT MUST NOT BE 'missed': the doctor was seen inside the week, just not on the planned day — reps reshuffle a route constantly and calling that a miss is how the mark loses its credibility",
  );
  assert.equal(
    planRowVerdict(actuals, { contactCrmId: 3, date: "2026-08-31" }),
    "missed",
    "a doctor not seen anywhere in the window, on a day that has ended",
  );
  assert.equal(
    planRowVerdict(actuals, { contactCrmId: 3, date: TODAY }),
    "upcoming",
    "TODAY IS NOT YET A FAILURE — a plan for this afternoon has not been broken by lunchtime",
  );
  assert.equal(
    planRowVerdict(actuals, { contactCrmId: 3, date: "2026-09-05" }),
    "upcoming",
    "and neither is a day still ahead",
  );
  assert.equal(
    planRowVerdict(actuals, { contactCrmId: 7, date: TODAY }),
    "visited",
    "but a doctor already seen today IS seen — checking the visit before the calendar is what stops the board hiding a rep's own work on the day he does it",
  );
  assert.equal(
    planRowVerdict(actuals, { contactCrmId: null, date: "2026-08-31" }),
    "unknown",
    "a plan row naming no contact cannot be judged",
  );
  assert.equal(
    planRowVerdict(actuals, { contactCrmId: 1, date: null }),
    "unknown",
    "nor can one the CRM left undated",
  );

  // ── A FAILED READ IS NOT A WEEK OF MISSES ─────────────────────────────────────────────────────
  // `loadPlanActuals` answers null on a failed query AND on a departed agent, whose visits every CRM
  // read excludes by standing rule while the plan side does not. Reading on would compare a full plan
  // against zero visits and mark every doctor "not seen" — plausible on screen and completely wrong.
  assert.equal(
    planRowVerdict(null, { contactCrmId: 3, date: "2026-08-31" }),
    "unknown",
    "with no actuals NOTHING is claimed, and the chip renders nothing at all",
  );

  // ── A CAMPAIGN DAY IS NOT AN IDLE DAY ─────────────────────────────────────────────────────────
  assert.equal(
    planRowVerdict(actuals, { contactCrmId: 4, date: "2026-08-31" }),
    "missed",
    "a campaign call names no doctor, so it can never satisfy a planned one",
  );
  const campaignDay = planDayActual(actuals, "2026-08-31", [
    { verdict: "visited" },
    { verdict: "missed" },
    { verdict: "missed" },
  ]);
  assert.equal(campaignDay?.campaignCalls, 2, "but the day still says he logged two campaign calls — without that line a rep who spent the day on a campaign reads as a rep who did nothing");
  assert.equal(campaignDay?.planned, 3);
  assert.equal(campaignDay?.visited, 1);
  assert.equal(campaignDay?.missed, 2);
  assert.equal(campaignDay?.upcoming, false);

  assert.equal(
    planDayActual(actuals, "2026-09-05", [{ verdict: "upcoming" }])?.upcoming,
    true,
    "a day still ahead is flagged so the heading stays silent about it",
  );
  assert.equal(planDayActual(null, "2026-08-31", []), null, "no actuals, no day summary");
  assert.equal(planDayActual(actuals, null, []), null, "and an undated block is never summarised");

  // ── THE WHOLE PIPE, THROUGH buildPlanDoctorDays ───────────────────────────────────────────────
  const entry = (over: Partial<PlanEntryRow>): PlanEntryRow => ({
    ampm: "AM",
    contactCrmId: null,
    contactName: "Doctor",
    frequency: null,
    grade: null,
    onRepList: false,
    planDate: null,
    region: null,
    speciality: null,
    ...over,
  });

  const days = buildPlanDoctorDays(
    [
      entry({ contactCrmId: 1, contactName: "Kept", planDate: "2026-08-31" }),
      entry({ contactCrmId: 2, contactName: "Moved", planDate: "2026-08-31" }),
      entry({ contactCrmId: 3, contactName: "Missed", planDate: "2026-08-31" }),
      entry({ contactCrmId: 3, contactName: "Ahead", planDate: "2026-09-05" }),
    ],
    new Map(),
    actuals,
  );

  const sunday = days.find((day) => day.date === "2026-08-31");
  assert.deepEqual(
    sunday?.rows.map((row) => row.verdict),
    ["visited", "missed", "moved"],
    "each row carries its own verdict — sorted AM-then-name, so this is Kept, Missed, Moved",
  );
  assert.equal(sunday?.actual?.visited, 1);
  assert.equal(sunday?.actual?.moved, 1);
  assert.equal(sunday?.actual?.missed, 1);
  assert.equal(
    sunday?.actual?.planned,
    sunday?.rows.length,
    "the day's total is the rows it holds — summed from the SAME verdicts the chips show, so a heading reading '2 of 3 kept' can never sit over a different set of marks",
  );

  const ahead = days.find((day) => day.date === "2026-09-05");
  assert.deepEqual(ahead?.rows.map((row) => row.verdict), ["upcoming"], "a future day is judged by nobody");

  // Omitting the actuals must leave the board exactly as it read before this feature existed.
  const unmarked = buildPlanDoctorDays([entry({ contactCrmId: 3, planDate: "2026-08-31" })], new Map());
  assert.deepEqual(unmarked[0].rows.map((row) => row.verdict), ["unknown"]);
  assert.equal(unmarked[0].actual, null, "and no day summary either");
}
