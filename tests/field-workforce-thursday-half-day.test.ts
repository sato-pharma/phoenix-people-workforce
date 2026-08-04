import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  fieldWorkforceDeductionDayWeight,
  fieldWorkforceDeductionUnits,
  isFieldWorkforceHalfDay,
  isFieldWorkforceThursday,
  isFieldWorkforceWeeklyOff,
  sumFieldWorkforceDeductionDayWeights,
} from "../src/lib/field-workforce-compliance/weekend-policy.ts";

const recommendSource = readFileSync(
  new URL("../src/lib/automated-payroll/recommend.ts", import.meta.url),
  "utf8",
);

const crmConnectorSource = readFileSync(
  new URL("../src/lib/deductions/connectors/crm.ts", import.meta.url),
  "utf8",
);

/**
 * THURSDAY IS A HALF DAY for the field workforce (owner rule, 2026-08-02): "medical reps working
 * days are from sat to wednesday AM and PM, thursday am or meeting or health day only".
 *
 * Nothing in the codebase encoded that. Thursday was an ordinary full working day to every engine,
 * so a rep with no CRM visit on a Thursday morning was measured against a FULL day and deducted a
 * FULL day. Measured on July 2026 production: Thursday produced 89 of 306 flagged employee-days —
 * 29.1%, 43 employees, 81,950 EGP — MORE than any genuine full working day, which is the signature
 * of a rule error and not of behaviour.
 *
 * Dates below are real July 2026 calendar dates so the weekday arithmetic is checkable by hand:
 *   2026-07-04 Sat · 07-05 Sun · 07-06 Mon · 07-07 Tue · 07-08 Wed · 07-09 Thu · 07-10 Fri
 */

const SATURDAY = "2026-07-04";
const SUNDAY = "2026-07-05";
const MONDAY = "2026-07-06";
const TUESDAY = "2026-07-07";
const WEDNESDAY = "2026-07-08";
const THURSDAY = "2026-07-09";
const FRIDAY = "2026-07-10";

const REP = "Medical Representative";
const DSM = "District Sales Manager";

export function runFieldWorkforceThursdayHalfDayTests() {
  // ---- the weekday itself -------------------------------------------------
  assert.equal(isFieldWorkforceThursday(THURSDAY), true, "2026-07-09 is a Thursday");
  assert.equal(isFieldWorkforceThursday(WEDNESDAY), false);
  assert.equal(isFieldWorkforceThursday("not-a-date"), false, "an unparseable date must not read as Thursday");

  // ---- THE HEADLINE: a no-activity Thursday costs half a day ---------------
  assert.equal(
    fieldWorkforceDeductionDayWeight({ dateIso: THURSDAY, title: REP }),
    0.5,
    "Thursday is AM-only (or a meeting/health day) so it must cost HALF a day — charging a full day is the bug that took 81,950 EGP across 43 people in July 2026",
  );

  // ---- the full working days must be untouched ----------------------------
  for (const [dateIso, label] of [
    [SUNDAY, "Sunday"],
    [MONDAY, "Monday"],
    [TUESDAY, "Tuesday"],
    [WEDNESDAY, "Wednesday"],
  ] as const) {
    assert.equal(
      fieldWorkforceDeductionDayWeight({ dateIso, title: REP }),
      1,
      `${label} is a full working day (Sat-Wed are AM and PM) and must still cost a full day — a fix that softened every day would quietly stop deducting real absence`,
    );
  }

  // ---- Saturday is title-dependent, and getting it wrong costs money -------
  assert.equal(
    fieldWorkforceDeductionDayWeight({ dateIso: SATURDAY, title: REP }),
    1,
    "Medical Reps work Saturday, so it is a full deductible day",
  );
  assert.equal(
    fieldWorkforceDeductionDayWeight({ dateIso: SATURDAY, title: DSM }),
    1,
    "District Sales Managers work Saturday too",
  );
  assert.equal(
    fieldWorkforceDeductionDayWeight({ dateIso: SATURDAY, title: null }),
    0,
    "with NO title Saturday falls back to weekly-off — this is exactly why every caller must pass a real job title rather than a possibly-null roleName, or 23 of July's flagged Saturdays would silently weight to zero",
  );

  // ---- Friday is off, and off is not half ---------------------------------
  assert.equal(fieldWorkforceDeductionDayWeight({ dateIso: FRIDAY, title: REP }), 0, "Friday is a weekly off — never deducted");
  assert.equal(
    isFieldWorkforceHalfDay({ dateIso: FRIDAY, title: REP }),
    false,
    "a day off must never be reported as a half day",
  );
  assert.equal(isFieldWorkforceHalfDay({ dateIso: THURSDAY, title: REP }), true);
  assert.equal(
    isFieldWorkforceHalfDay({ dateIso: SATURDAY, title: null }),
    false,
    "a Saturday that is a weekly off for this title is off, not half",
  );

  // Weekly-off behaviour itself must be unchanged by this work.
  assert.equal(isFieldWorkforceWeeklyOff({ dateIso: FRIDAY, title: REP }), true);
  assert.equal(isFieldWorkforceWeeklyOff({ dateIso: SATURDAY, title: REP }), false);
  assert.equal(isFieldWorkforceWeeklyOff({ dateIso: THURSDAY, title: REP }), false, "Thursday is worked, just not all day");

  // ---- weighted sums: what `deductionDays` actually receives ---------------
  assert.equal(
    sumFieldWorkforceDeductionDayWeights([SUNDAY, MONDAY, THURSDAY], REP),
    2.5,
    "two full days plus a Thursday is 2.5 days, not 3 — this is the number multiplied by Base/30",
  );
  assert.equal(
    sumFieldWorkforceDeductionDayWeights([THURSDAY, THURSDAY], REP),
    1,
    "two Thursdays make one full day",
  );
  assert.equal(
    sumFieldWorkforceDeductionDayWeights([FRIDAY], REP),
    0,
    "a Friday contributes nothing even if it somehow reached the list",
  );
  assert.equal(sumFieldWorkforceDeductionDayWeights([], REP), 0, "no dates is no deduction, never NaN");

  // A whole real working week for a rep: Sat-Wed full + Thu half = 5.5, not 6.
  assert.equal(
    sumFieldWorkforceDeductionDayWeights([SATURDAY, SUNDAY, MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY], REP),
    5.5,
    "a rep's full week is 5 full days plus a Thursday half plus a Friday off = 5.5 deductible days",
  );

  // ---- half-day units, used to split a breakdown so it still foots ---------
  assert.equal(fieldWorkforceDeductionUnits(THURSDAY, REP), 1, "Thursday is 1 half-day unit");
  assert.equal(fieldWorkforceDeductionUnits(MONDAY, REP), 2, "a full day is 2 half-day units");
  assert.equal(fieldWorkforceDeductionUnits(FRIDAY, REP), 0, "a day off carries no units");

  // ---- the money sites must actually use the weight -----------------------
  // A pure rule nothing calls is worth nothing: this module's rules have been half-implemented
  // before, with one surface corrected while the others kept paying the old figure.
  //
  // Since 2026-08-04 Automated Payroll computes NO deduction figure at all —
  // continuing OR leaver. Every one is whatever the Deductions module confirmed
  // (owner rule: "the deductions module [is] the only source of truth of
  // deductions... no any deduction type should be read [from anywhere else]").
  // The module's own CRM connector applies this weighting before a candidate is
  // ever created, so the rule now has exactly ONE home and the connector
  // assertions below are what keep it honest.
  //
  // This is the stronger guard, not a weaker one: it fails if payroll ever
  // starts recomputing a deduction again, which is the drift that put two
  // disagreeing figures on screen in the first place.
  assert.doesNotMatch(
    recommendSource,
    /sumFieldWorkforceDeductionDayWeights/,
    "payroll must not weight CRM days itself — weighting belongs to the Deductions module's connector, because payroll no longer computes any deduction",
  );
  assert.doesNotMatch(
    recommendSource,
    /computeLeaverCrmDates/,
    "the leaver CRM scan must be gone from payroll — a leaver's CRM deduction is the module's confirmed figure like everyone else's",
  );
  assert.match(
    crmConnectorSource,
    /sumFieldWorkforceDeductionDayWeights\(noActivityDates, input\.jobTitle\)/,
    "the deductions module's leaver candidate must weight its estimated amount",
  );
  assert.match(
    crmConnectorSource,
    /sumFieldWorkforceDeductionDayWeights\(recommendation\.dates, jobTitle\)/,
    "the deductions module's continuing-employee candidates must weight too — they are the bulk of the population",
  );

  // ---- national holidays: a degraded calendar must not become a deduction --
  // The Google Egypt calendar is the only source of MOVING Islamic/Coptic holidays. When it cannot
  // be read, getConfirmedNationalHolidays degrades to company + fixed-date holidays and reports
  // calendarReachable:false — every moving holiday then reads as an ordinary working day, and the
  // degraded result is cached for 10 minutes so one outage poisons a whole run window.
  assert.match(
    crmConnectorSource,
    /holidayResult\.calendarReachable === false \|\| holidayResult\.connected === false/,
    "the deductions module's leaver path must refuse to run on a degraded holiday calendar rather than charge Eid as a working day",
  );
  // Automated Payroll needs no such guard any more, and that is the point: it
  // never reads the holiday calendar for a deduction, because it never computes
  // one. The guard lives with the calculation, in the connector above.
  assert.doesNotMatch(
    recommendSource,
    /getConfirmedNationalHolidays/,
    "payroll must not consult the holiday calendar for deductions — it pays the Deductions module's confirmed figure, and the outage guard belongs where the calculation is",
  );
}
