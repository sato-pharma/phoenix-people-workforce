import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isAfterPeriod, isSettledInPart1 } from "../src/lib/automated-payroll/recommend.ts";
import { normalizePayrollPaymentMode } from "../src/lib/payroll/policy.ts";
import { PART1_STEP_KEYS, PART2_STEP_KEYS, type StepRow } from "../src/lib/automated-payroll/types.ts";
import { STEP_DEFINITIONS, STEP_ORDER } from "../src/lib/automated-payroll/step-definitions.ts";
import {
  enteredOnThisStepAmount,
  hasDoubleDeductionConflict,
  settledElsewhereAmount,
} from "../src/lib/automated-payroll/conflicts.ts";

/**
 * Guards the Part 1 / Part 2 split rule (owner-decided 2026-07-25).
 *
 * CRM and unpaid vacation are deductible in two different places: the Part 1
 * manual tabs (p1_crm / p1_unpaid_vacation) and the Part 2 auto steps (p2_crm /
 * p2_vacation). They write to DIFFERENT draft columns (p1od_crm_value vs crm) and
 * assemble.ts sums BOTH into the deduction total — so if the same employee ever
 * appears in both populations, they get deducted twice for the same days (or, once
 * their Second Part clamps to 0, the excess is silently stranded in
 * overpaidResidual, which nothing carries forward).
 *
 * `isSettledInPart1` is the one predicate that keeps the two populations disjoint,
 * used in both directions. These tests pin that behaviour so a future edit to one
 * call site without the other fails here instead of in a live payroll run.
 */
export function runAutomatedPayrollPart1ScopeTests() {
  const leaver = { lifecycle: "leaver" as const };
  const joiner = { lifecycle: "joiner" as const };
  const regular = { lifecycle: "regular" as const };
  const onePart = { paymentMode: "one_part" as const };
  const twoParts = { paymentMode: "two_parts" as const };

  // ---- leavers are always settled in Part 1, whatever their payment mode -----
  // They are gone before Part 2 runs; the Resignations step computes their CRM +
  // unpaid vacation instead.
  assert.equal(isSettledInPart1(leaver, twoParts), true);
  assert.equal(isSettledInPart1(leaver, onePart), true);
  assert.equal(isSettledInPart1(leaver, undefined), true);

  // ---- one-part employees are settled in Part 1 regardless of lifecycle ------
  // A Part-2 deduction cannot land for them: they have no meaningful Second Part
  // to net it against.
  assert.equal(isSettledInPart1(regular, onePart), true);
  assert.equal(isSettledInPart1(joiner, onePart), true);

  // ---- continuing two-part employees are NOT settled in Part 1 --------------
  // They keep the automatic Part 2 CRM / Vacation treatment.
  assert.equal(isSettledInPart1(regular, twoParts), false);
  assert.equal(isSettledInPart1(joiner, twoParts), false);

  // ---- a missing salary source must NOT drag a continuing employee into Part 1
  // (paymentMode is only "one_part" when explicitly set; the module's own
  // normalizer defaults everything else to two_parts, and 19 production
  // employees currently carry a null payment_mode).
  assert.equal(isSettledInPart1(regular, undefined), false);
  assert.equal(isSettledInPart1(regular, { paymentMode: normalizePayrollPaymentMode(null) }), false);
  assert.equal(isSettledInPart1(regular, { paymentMode: normalizePayrollPaymentMode("") }), false);

  // ---- the Part 1 manual deduction tabs all exist and sit in Part 1 ----------
  // (each is scoped by isSettledInPart1 inside recommend.ts). p1_resignation_crm
  // is the dedicated leaver CRM tab (owner request 2026-07-26).
  const part1ManualTabs = [
    "p1_crm",
    "p1_resignation_crm",
    "p1_unpaid_vacation",
    "p1_no_record",
    "p1_other_deductions",
  ] as const;
  for (const key of part1ManualTabs) {
    assert.equal(STEP_DEFINITIONS[key].phase, "part1", `${key} must be a Part 1 step`);
    assert.equal(PART1_STEP_KEYS.includes(key), true, `${key} missing from PART1_STEP_KEYS`);
  }

  // ---- each category lives in exactly ONE tab, so no single tab can write two
  // categories that another tab also writes -----------------------------------
  const fieldOwners = new Map<string, string>();
  for (const key of part1ManualTabs) {
    for (const field of STEP_DEFINITIONS[key].fields) {
      assert.equal(
        fieldOwners.has(field.key),
        false,
        `field ${field.key} appears in both ${fieldOwners.get(field.key)} and ${key}`,
      );
      fieldOwners.set(field.key, key);
    }
  }
  // CRM / Vacation / No-Record are single-category tabs; Loan+Other carries two.
  // p1_crm has 4 (owner request 2026-07-25 added the Working Days complement).
  // p1_resignation_crm (owner request 2026-07-26) mirrors that same shape.
  assert.equal(STEP_DEFINITIONS.p1_crm.fields.length, 4);
  assert.equal(STEP_DEFINITIONS.p1_resignation_crm.fields.length, 4);
  assert.equal(STEP_DEFINITIONS.p1_unpaid_vacation.fields.length, 3);
  assert.equal(STEP_DEFINITIONS.p1_no_record.fields.length, 3);
  assert.equal(STEP_DEFINITIONS.p1_other_deductions.fields.length, 6);

  // ---- the Part 2 twins still exist and stay in Part 2 ----------------------
  for (const key of ["p2_crm", "p2_vacation"] as const) {
    assert.equal(STEP_DEFINITIONS[key].phase, "part2", `${key} must be a Part 2 step`);
    assert.equal(PART2_STEP_KEYS.includes(key), true, `${key} missing from PART2_STEP_KEYS`);
  }

  // ---- STEP_ORDER stays in sync with the phase key lists -------------------
  assert.deepEqual(STEP_ORDER, [...PART1_STEP_KEYS, ...PART2_STEP_KEYS]);

  // ---- CRM/Vacation double-deduction risk is now STRUCTURALLY ELIMINATED
  // (owner request 2026-07-25). The two tabs used to show the SAME leaver
  // twice — once as an auto-computed Resignations settlement, once as an
  // optional manual top-up here, with a warning banner to catch double entry.
  // The computation itself moved INTO these dedicated tabs instead, so there is
  // no longer a second place the same amount can be entered — the warning
  // machinery is retired for every Part 1 manual tab. --------------------------
  for (const key of [
    "p1_crm",
    "p1_resignation_crm",
    "p1_unpaid_vacation",
    "p1_no_record",
    "p1_other_deductions",
  ] as const) {
    assert.equal(
      STEP_DEFINITIONS[key].conflictContextKey,
      undefined,
      `${key} must not declare a conflict key — nothing computes a competing figure elsewhere anymore`,
    );
    assert.equal(
      STEP_DEFINITIONS[key].contextColumns.some((column) => column.key === "Settled in Resignations"),
      false,
      `${key} must not show a "Settled in Resignations" column`,
    );
  }

  // The conflict-detection helpers themselves still degrade safely for a step
  // that declares no conflict key (kept generic on purpose; exercised here so
  // the degrade path itself stays covered even with no consumer left).
  const noRecordStep = STEP_DEFINITIONS.p1_no_record;
  const plainRow: StepRow = {
    hrId: "A-12",
    fullName: "Someone",
    jobTitle: null,
    line: null,
    context: {},
    values: { p1odNoRecordValue: 500 },
    recommended: { p1odNoRecordValue: 0 },
    reason: null,
    onHold: false,
    lifecycle: "regular",
  };
  assert.equal(settledElsewhereAmount(noRecordStep, plainRow), 0);
  assert.equal(hasDoubleDeductionConflict(noRecordStep, plainRow), false);
  // enteredOnThisStepAmount reports what HR typed regardless of any conflict key
  // (it is not itself conflict-gated) — 500 here, matching plainRow's own entry.
  assert.equal(enteredOnThisStepAmount(noRecordStep, plainRow), 500);

  // ---- "Resignation Date" column, so a leaver showing up in a Part 1 manual
  // tab is legible (owner request 2026-07-25) ---------------------------------
  for (const key of part1ManualTabs) {
    assert.equal(
      STEP_DEFINITIONS[key].contextColumns.some((column) => column.key === "Resignation Date"),
      true,
      `${key} must show the Resignation Date context column`,
    );
  }

  // ---- CRM/Vacation computation now lives in the DEDICATED tabs, not
  // Resignations (owner request 2026-07-25 — the same figure used to appear in
  // both places, which read as duplication). Leaver CRM moved a SECOND time
  // (owner request 2026-07-26) into its OWN p1_resignation_crm tab — p1_crm is
  // now continuing (one-part) employees only, keeping the whole-month /30
  // behavior for them. p1_unpaid_vacation's Days field deliberately carries NO
  // auto-calc wiring for a leaver's real figure: it is a composite (balance-aware
  // Phoenix amount + a separate CRM-leave amount), not a flat day rate — the real
  // Value is written directly, and Days is read-only reference via its own
  // context column instead. -----------------------------------------------------
  const crmStep = STEP_DEFINITIONS.p1_crm;
  const crmDaysField = crmStep.fields.find((field) => field.key === "p1odCrmDays");
  assert.equal(crmDaysField?.kind, "days");
  assert.equal(crmDaysField?.autoCalcMoneyKey, "p1odCrmValue");

  // ---- Working Days / Non-Working Days complement pair (owner request
  // 2026-07-25): both must sum to the month's calendar days, and the money
  // divisor must stay the FIXED 30 the deduction formula always uses — never
  // the actual calendar-day-count, which is a DIFFERENT number in a 31-day
  // month. Conflating the two would silently change the deduction amount. ----
  const workingDaysField = crmStep.fields.find((field) => field.key === "p1odCrmWorkingDays");
  assert.equal(workingDaysField?.kind, "days");
  assert.equal(workingDaysField?.complementFieldKey, "p1odCrmDays");
  assert.equal(workingDaysField?.complementTotalContextKey, "Days In Month");
  assert.equal(workingDaysField?.autoCalcMoneyKey, undefined, "Working Days must never drive money directly");
  assert.equal(crmDaysField?.complementFieldKey, "p1odCrmWorkingDays");
  assert.equal(crmDaysField?.complementTotalContextKey, "Days In Month");
  // The money field's own divisor key must be undefined (uses the client's
  // hardcoded default of 30), NOT the complement's total-days context key.
  assert.equal(
    crmDaysField?.autoCalcDivisorContextKey,
    undefined,
    "the CRM money divisor must stay fixed at 30, not read the complement's calendar-days total",
  );

  // ---- Resignations CRM (owner request 2026-07-26): the fix for a real bug —
  // the shared CRM tab capped Working+Non-Working at the WHOLE MONTH, so a
  // leaver who worked only 9 days could show 22 "non-working" days (the days
  // AFTER he had already left) and be deducted for them. This dedicated tab
  // caps the complement at DAYS WORKED instead, and unifies the deduction rate
  // with the settlement's own Base ÷ actual-month-days (NOT /30). ---------------
  const resigCrmStep = STEP_DEFINITIONS.p1_resignation_crm;
  const resigNonWorkingField = resigCrmStep.fields.find((field) => field.key === "resignationCrmDays");
  const resigWorkingField = resigCrmStep.fields.find((field) => field.key === "resigCrmWorkingDays");
  assert.equal(resigNonWorkingField?.kind, "days");
  assert.equal(resigNonWorkingField?.autoCalcMoneyKey, "crm");
  assert.equal(
    resigNonWorkingField?.autoCalcDivisorContextKey,
    "Days In Month",
    "the resignation CRM deduction must divide by the month's ACTUAL calendar days, unified with the settlement rate — not the fixed 30",
  );
  assert.equal(resigWorkingField?.complementFieldKey, "resignationCrmDays");
  assert.equal(resigNonWorkingField?.complementFieldKey, "resigCrmWorkingDays");
  assert.equal(
    resigWorkingField?.complementTotalContextKey,
    "Days Worked",
    "the complement must cap at DAYS WORKED (the employment span), never the whole month",
  );
  assert.equal(resigNonWorkingField?.complementTotalContextKey, "Days Worked");
  // Field keys ARE the literal DraftRow columns (resignationCrmDays/crm), so the
  // generic persist-loop in stepEditToPatch writes them directly — no remap
  // needed (unlike the vacation tab below), confirmed by the write-path checks
  // further down finding no p1_resignation_crm-specific remap branch.
  assert.equal(STEP_DEFINITIONS.p1_resignation_crm.phase, "part1");
  assert.equal(PART1_STEP_KEYS.includes("p1_resignation_crm"), true, "p1_resignation_crm missing from PART1_STEP_KEYS");
  assert.ok(STEP_ORDER.includes("p1_resignation_crm"), "p1_resignation_crm missing from STEP_ORDER");

  const vacationStep = STEP_DEFINITIONS.p1_unpaid_vacation;
  assert.equal(
    vacationStep.fields.some((field) => field.kind === "days" && field.autoCalcMoneyKey === "p1odVacationValue"),
    true,
    "the manual-entry auto-calc must still exist for non-leaver (one-part) employees",
  );
  assert.equal(
    vacationStep.contextColumns.some((column) => column.key === "Unpaid Vacation Days"),
    true,
    "Unpaid Vacation Days must be a read-only reference column for a leaver's real day count",
  );

  // The Resignations step no longer computes or shows CRM/Vacation at all —
  // confirms the "showing in two places" complaint is structurally impossible now.
  const resignationsStep = STEP_DEFINITIONS.p1_resignations;
  assert.equal(
    resignationsStep.fields.some((field) => ["resignationCrmDays", "crm", "unpaidVacations"].includes(field.key)),
    false,
    "Resignations must not carry CRM/Vacation fields anymore — they moved to the dedicated tabs",
  );
  assert.equal(
    resignationsStep.contextColumns.some((column) => column.key === "Unpaid Vacation Days"),
    false,
    "Resignations must not show Unpaid Vacation Days either — see the dedicated tab instead",
  );

  // ---- the WRITE path must remap a leaver's VACATION edit onto the SAME
  // unpaidVacations draft column Resignations always used — never ALSO onto
  // p1odVacationValue, which would double-count via otherPart1DeductionsTotal
  // and reintroduce the exact double-deduction bug this module already guards
  // against elsewhere. (Leaver CRM needs no such remap anymore — its dedicated
  // p1_resignation_crm tab's field keys ARE resignationCrmDays/crm already, see
  // the STEP_DEFINITIONS assertions above — so there must be no p1_crm-specific
  // leaver branch left in stepEditToPatch; that branch is exactly what produced
  // the whole-month bug this tab was built to fix.) stepEditToPatch/stepRowToPatch
  // are private to run-service.ts, so this pins the contract at the source level
  // — comments stripped first (a bare identifier match would also hit a doc
  // comment mentioning the same function name and pass even if the real call
  // were deleted; caught exactly that way once already this session). ----------
  const runServiceSource = readFileSync(
    new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url),
    "utf8",
  );
  const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const stepEditToPatchBody = stripComments(
    runServiceSource.slice(
      runServiceSource.indexOf("function stepEditToPatch"),
      runServiceSource.indexOf("function stepRowToPatch"),
    ),
  );
  assert.ok(
    !stepEditToPatchBody.includes('stepKey === "p1_crm"'),
    "there must be no leaver-specific remap branch left for p1_crm — its leavers moved to p1_resignation_crm entirely",
  );
  assert.ok(
    stepEditToPatchBody.includes("patch.unpaidVacations = generic.p1odVacationValue"),
    "a leaver's Vacation edit must remap onto unpaidVacations, not stay on p1odVacationValue",
  );
  assert.ok(
    stepEditToPatchBody.includes("delete generic.p1odVacationValue"),
    "the p1odVacationValue key must be deleted after remapping — leaving it would double-write both columns",
  );
  // The Resignations CRM tab's reason field (resigCrmReason) reuses the SAME
  // p1od_crm_reason column the old p1_crm leaver branch wrote — confirmed via
  // OTHER_DEDUCTIONS_REASON_FIELDS, not a remap branch (a reason field is a
  // simple 1:1 lookup, not numeric patch logic).
  assert.ok(
    stepEditToPatchBody.includes('resigCrmReason: "p1odCrmReason"') ||
      runServiceSource.includes('resigCrmReason: "p1odCrmReason"'),
    "resigCrmReason must map onto the existing p1od_crm_reason column",
  );
  const stepRowToPatchBody = stripComments(
    runServiceSource.slice(
      runServiceSource.indexOf("function stepRowToPatch"),
      runServiceSource.indexOf("async function requireRun"),
    ),
  );
  assert.ok(
    stepRowToPatchBody.includes('row.lifecycle === "leaver"'),
    "stepRowToPatch (used at confirm time) must pass the row's own lifecycle into the remap",
  );

  // ---- notice-period employees must not vanish from earlier months (owner-confirmed
  // real bug, 2026-07-25 — B-157 Sameh Ahmed Ezzat Mohamed Hussien: employment_status
  // already "resigned" but last_working_date=2026-08-31, a full month after the July
  // run being processed). isAfterPeriod is the one predicate that tells "already
  // departed before this period" apart from "departing later, still owed this
  // period's pay" — resolvePayrollPopulationAndSources uses it alongside
  // isPayrollIneligibleEmployee so a terminal status alone can never wrongly exclude
  // someone still actively working through a future exit. -----------------------
  const july = { month: 7, year: 2026 };
  // Sameh's real shape: still active through August, for the July run.
  assert.equal(isAfterPeriod("2026-08-31", july), true);
  // An employee who already left in an EARLIER month must stay excluded.
  assert.equal(isAfterPeriod("2026-06-30", july), false);
  // A leaver exiting THIS SAME month is handled by the leaver path, not this one —
  // isAfterPeriod itself must say false so isPayrollIneligibleEmployee still applies
  // (that employee is included via isLeaver instead, never via this predicate).
  assert.equal(isAfterPeriod("2026-07-31", july), false);
  // Across a year boundary: exiting January next year is still "after" December.
  assert.equal(isAfterPeriod("2027-01-15", { month: 12, year: 2026 }), true);
  // No date at all (still actively employed, no resignation on file) — never "after."
  assert.equal(isAfterPeriod(null, july), false);

  // ---- THE SAME PREDICATE, NOW GUARDING THE HIRE DATE (owner-reported real bug,
  // 2026-08-04): two employees hired 2026-08-02 were on the JULY sheet.
  //
  // The failure was not "an extra row". `isJoiner` is isInPeriod(hireDate,
  // period), which is FALSE for a future hire — an August hire's month is not
  // July — so they fell straight through to lifecycle "regular" and were paid a
  // FULL, UNPRORATED July salary for a month they had not worked. A genuine
  // joiner at least gets prorated; this population got everything.
  //
  // Nothing else could have caught it: a future hire is perfectly "active" and
  // payroll-eligible today, so isPayrollIneligibleEmployee passes them happily.
  // resolvePayrollPopulationAndSources must therefore drop them BEFORE that
  // check, on the hire date alone.
  assert.equal(
    isAfterPeriod("2026-08-02", july),
    true,
    "Mahmoud Eldaly and Adel Srour (both hired 2026-08-02) must be excluded from the July run — they were paid a full month they never worked",
  );
  // The boundary that must NOT be excluded: hired on the last day of the period
  // is a real joiner and is owed that day's prorated pay.
  assert.equal(isAfterPeriod("2026-07-31", july), false, "a last-day hire is a joiner, not a future hire");
  assert.equal(isAfterPeriod("2026-07-01", july), false, "a first-day hire is plainly in the period");
  // A future hire relative to an EARLIER run stays excluded there too, and a
  // year boundary must not read as "before".
  assert.equal(isAfterPeriod("2027-01-05", { month: 12, year: 2026 }), true);

  // The assertions above only prove the PREDICATE works — it always did. The bug
  // was that the population filter never called it on the hire date. This checks
  // the wiring, which is the thing that actually broke, and it is a source guard
  // because resolvePayrollPopulationAndSources reads the employee directory and
  // cannot be exercised without a database.
  const populationSource = readFileSync(
    new URL("../src/lib/automated-payroll/recommend.ts", import.meta.url),
    "utf8",
  ).slice(
    readFileSync(new URL("../src/lib/automated-payroll/recommend.ts", import.meta.url), "utf8").indexOf(
      "export async function resolvePayrollPopulationAndSources",
    ),
  );
  assert.match(
    populationSource.slice(0, 3000),
    /isAfterPeriod\(employee\.hireDate, period\)\)\s*continue/,
    "the payroll population must drop anyone hired after the period ends — without this they are paid a full unprorated month they never worked",
  );

  // ---- notice-period employees are VISIBLE but never SETTLED (owner request
  // 2026-07-25, after B-157's resignation was completed by mistake and he looked
  // like an ordinary employee with no resignation shown anywhere).
  //
  // The safety property: a future exit date must NEVER reach the field that
  // drives proration. PopulationMember carries it in `noticeLastWorkingDate`;
  // `lastWorkingDate` stays leaver-only, because effectiveSalary feeds THAT one
  // into computeResignationSettlement. Putting a future date there would prorate
  // the employee's current-month pay and underpay them.
  const recommendSource = readFileSync(
    new URL("../src/lib/automated-payroll/recommend.ts", import.meta.url),
    "utf8",
  );
  const populationPush = recommendSource.slice(
    recommendSource.indexOf("members.push({"),
    recommendSource.indexOf("unpaidDaysInSpan: feeder?.unpaidDaysBeforeLastWorkingDate"),
  );
  assert.ok(
    populationPush.includes("lastWorkingDate: leaverLastWorkingDate"),
    "lastWorkingDate must stay leaver-only — it drives settlement proration",
  );
  assert.ok(
    populationPush.includes("noticeLastWorkingDate: stillActiveThroughFutureExit"),
    "a future exit must be carried in noticeLastWorkingDate, never in lastWorkingDate",
  );
  assert.equal(
    populationPush.includes("lastWorkingDate: employee.lastWorkingDate"),
    false,
    "the employee's own (possibly future) lastWorkingDate must never be assigned to the proration field",
  );

  // Both the save and confirm paths must drop read-only rows, so a notice-period
  // employee can never have this month's figures written to their draft row.
  // (runServiceSource/stripComments already declared above for the leaver
  // CRM/Vacation remap checks — reused here rather than re-reading the file.)
  const confirmStepBody = stripComments(
    runServiceSource.slice(
      runServiceSource.indexOf("export async function confirmStep"),
      runServiceSource.indexOf("function summarizeStep"),
    ),
  );
  assert.ok(
    confirmStepBody.includes("filter((row) => !row.readOnly)"),
    "confirmStep must skip read-only rows — otherwise confirming writes a notice-period employee's draft row",
  );

  // ---- Special Situations (owner rule 2026-07-25): a genuine Part 1 step, NOT a
  // phase-agnostic novelty — it lives in PART1_STEP_KEYS like its siblings, so it
  // locks the same way (stepLocked in automated-payroll-wizard.tsx checks
  // run.phase !== stepPhase(stepKey)) once Part 1 is confirmed. No extra runtime
  // gating was needed for "only allow First Part before Part 1 is confirmed" —
  // it falls out of the existing per-step lock every Part 1 tab already has. ----
  assert.equal(STEP_DEFINITIONS.p1_special_situations.phase, "part1");
  assert.equal(PART1_STEP_KEYS.includes("p1_special_situations"), true);
  // No conflict twin — this step is deliberately independent of the Resignations
  // step's auto-computed CRM/vacation, so it must never claim a warning key.
  assert.equal(STEP_DEFINITIONS.p1_special_situations.conflictContextKey, undefined);

  const specialFields = STEP_DEFINITIONS.p1_special_situations.fields;
  const specialDeductionDays = specialFields.find((field) => field.key === "specialDeductionDays");
  const specialAdditionDays = specialFields.find((field) => field.key === "specialAdditionDays");
  assert.equal(specialDeductionDays?.kind, "days");
  assert.equal(specialDeductionDays?.autoCalcMoneyKey, "specialDeductionValue");
  assert.equal(specialAdditionDays?.kind, "days");
  assert.equal(specialAdditionDays?.autoCalcMoneyKey, "specialAdditionValue");

  // The ONE shared routing choice (owner-confirmed: "whatever i choose is
  // actually synced the same for addition field") — a single select field, not
  // two independent first/second dropdowns for deduction vs addition.
  const routingFields = specialFields.filter((field) => field.kind === "select");
  assert.equal(routingFields.length, 1, "Special Situations must have exactly ONE routing select field");
  assert.equal(routingFields[0]?.key, "specialSituationPart");
  assert.deepEqual(
    routingFields[0]?.options?.map((option) => option.value),
    ["first", "second"],
  );
}
