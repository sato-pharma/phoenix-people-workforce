import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isSettledInPart1 } from "../src/lib/automated-payroll/recommend.ts";
import {
  describePartSplitConflicts,
  findPartSplitConflicts,
} from "../src/lib/automated-payroll/part-split-conflict.ts";
import type { DraftRow } from "../src/lib/automated-payroll/types.ts";

/**
 * A DEDUCTION IS CHARGED IN ONE INSTALMENT, AND CHANGING SOMEBODY'S PAYMENT MODE DOES NOT MOVE IT.
 *
 * FINDING 22. Whether an employee's loan, CRM or unpaid vacation is taken in Part 1 or in Part 2 is
 * decided by `isSettledInPart1`, which reads their payment mode and lifecycle LIVE, every time any
 * step is opened. The columns it routes the money into are permanent.
 *
 * So correcting someone from one-part to two-part between the two confirms left their loan sitting
 * in the Part 1 column from before, offered it again on the Part 2 step, and deducted it twice. The
 * mirror correction means it reaches no step at all and is never taken. Nothing detects either: the
 * double-deduction warning is switched off on every Part 1 deduction step, and the one-part to
 * two-part case only sometimes trips the overpaid acknowledgement, whose message says nothing about
 * a duplicate.
 *
 * THE FIX IS TO STAMP, NOT TO WARN. `confirmPart1` writes the routing onto the draft row in the
 * same write as the frozen First Part, and from that moment every step reads the stamp. Before the
 * confirm the live rule still answers, which is correct: nothing has been routed anywhere yet.
 *
 * THE SECOND INPUT MOVES TOO. Lifecycle is half the predicate, so an employee who resigns between
 * the two confirms flips exactly the same way with nobody having touched a payment mode at all.
 */

const TWO_PARTS = { paymentMode: "two_parts" as const };
const ONE_PART = { paymentMode: "one_part" as const };
const REGULAR = { lifecycle: "regular" as const };
const LEAVER = { lifecycle: "leaver" as const };

function draft(over: Partial<DraftRow>): DraftRow {
  return { employeeHrId: "B-1", excluded: false, ...over } as DraftRow;
}

export async function runAutomatedPayrollPartSplitStampTests() {
  // ---- Before Part 1 is confirmed, the live rule is still the right answer --------------------
  assert.equal(isSettledInPart1(REGULAR, TWO_PARTS, null), false, "a two-part employee waits for Part 2");
  assert.equal(isSettledInPart1(REGULAR, ONE_PART, null), true, "a one-part employee settles in Part 1");
  assert.equal(isSettledInPart1(LEAVER, TWO_PARTS, null), true, "a leaver settles in Part 1");
  assert.equal(isSettledInPart1(REGULAR, TWO_PARTS, undefined), false, "an absent stamp reads the same");

  // ---- HEADLINE: once stamped, correcting the payment mode moves nothing ------------------------
  assert.equal(
    isSettledInPart1(REGULAR, TWO_PARTS, true),
    true,
    "stamped into Part 1 and then corrected to two-part: the Part 2 step must STILL skip them, or " +
      "the loan already sitting in their Part 1 column is offered again and charged twice",
  );
  assert.equal(
    isSettledInPart1(REGULAR, ONE_PART, false),
    false,
    "stamped into Part 2 and then corrected to one-part: the Part 2 step must STILL offer it, or " +
      "the deduction reaches no step at all and is never taken",
  );

  // Lifecycle is the other half of the same predicate, and it moves on its own.
  assert.equal(
    isSettledInPart1(LEAVER, TWO_PARTS, false),
    false,
    "resigning between the two confirms must not re-route a deduction either",
  );

  // ---- THE BACKSTOP: money in both columns of a pair is refused ---------------------------------
  const clean = findPartSplitConflicts([
    draft({ p1odLoanValue: 500, manualOtherDeductions: null }),
    draft({ employeeHrId: "B-2", crm: 120, p1odCrmValue: null }),
    draft({ employeeHrId: "B-3", p1odVacationValue: 0, unpaidVacations: 300 }),
  ]);
  assert.deepEqual(clean, [], "one instalment each is the healthy shape and must not be flagged");

  const conflicted = findPartSplitConflicts([
    draft({ employeeHrId: "B-9", p1odLoanValue: 500, manualOtherDeductions: 500 }),
    draft({ employeeHrId: "B-8", p1odCrmValue: 120.5, crm: 60 }),
    draft({ employeeHrId: "B-7", p1odVacationValue: 300, unpaidVacations: 300 }),
  ]);
  assert.equal(conflicted.length, 3, "each pair charged in both instalments is one conflict");
  assert.deepEqual(
    conflicted.map((one) => one.hrId).sort(),
    ["B-7", "B-8", "B-9"],
    "and every affected person is named, because which instalment to clear is a decision about them",
  );

  // The Part 1 tabs split loan and other into two columns; Part 2 carries both in one.
  const split = findPartSplitConflicts([
    draft({ employeeHrId: "B-6", p1odLoanValue: null, p1odOtherValue: 250, manualOtherDeductions: 250 }),
  ]);
  assert.equal(split.length, 1, "the Part 1 'other' column is the same twin as Part 2's single column");

  // An excluded employee is not in this run at all, so their columns are not a charge.
  const excluded = findPartSplitConflicts([
    draft({ employeeHrId: "B-5", excluded: true, p1odLoanValue: 500, manualOtherDeductions: 500 }),
  ]);
  assert.deepEqual(excluded, [], "an excluded row is not on the sheet and cannot be double-charged");

  const said = describePartSplitConflicts(conflicted);
  assert.match(said, /B-9/, "the message names people");
  assert.match(said, /charged in BOTH instalments/, "and says what is wrong in words HR can act on");

  // ---- Every call site reads the stamp ------------------------------------------------------------
  // This is where the defect comes back: one call left reading the live payment mode is one step
  // that re-decides the routing after the money has already been written to a column, and it is
  // silent.
  const recommendSource = readFileSync("src/lib/automated-payroll/recommend.ts", "utf8");
  const liveCalls = recommendSource.match(/isSettledInPart1\(member,\s*source\)/g) ?? [];
  assert.deepEqual(
    liveCalls,
    [],
    "every call must pass the frozen stamp as its third argument — a call left reading the live " +
      "payment mode re-decides the routing after the money has already been written to a column",
  );
  const stamped = recommendSource.match(/isSettledInPart1\(member,\s*source,/g) ?? [];
  assert.ok(stamped.length >= 7, `all the call sites must be wired (found ${stamped.length})`);

  // ---- The stamp is written with the money, and cleared with it -----------------------------------
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");

  const confirmAt = runService.indexOf("export async function confirmPart1");
  const confirmBody = runService.slice(confirmAt, runService.indexOf("\nexport ", confirmAt + 10));
  assert.ok(
    confirmBody.length > 1000 && confirmBody.length < 12000,
    `the confirmPart1 slice must stay bounded (got ${confirmBody.length})`,
  );
  assert.match(
    confirmBody,
    /settledInPart1: isSettledInPart1\(member, lookupSource\(sources, member\.employee\.hrId\)\)/,
    "Part 1 confirm must freeze the routing in the SAME write as the frozen First Part",
  );

  const unconfirmAt = runService.indexOf("export async function unconfirmPart1");
  const unconfirmBody = runService.slice(unconfirmAt, runService.indexOf("\nexport ", unconfirmAt + 10));
  assert.ok(
    unconfirmBody.length > 500 && unconfirmBody.length < 6000,
    `the unconfirmPart1 slice must stay bounded (got ${unconfirmBody.length})`,
  );
  assert.match(unconfirmBody, /reopenPart1Atomically\(/, "Reopen Part 1 goes through the one all-or-nothing call");
  assert.match(
    readFileSync("supabase/migrations/20261114170804_automated_payroll_reopen_part1_atomically.sql", "utf8"),
    /settled_in_part1 = null/,
    "reopening exists so HR can correct the very data this was read from — a surviving stamp would " +
      "pin the run to the answer they just corrected",
  );

  // ---- And the backstop is actually wired into the Part 2 gate --------------------------------------
  const part2At = runService.indexOf("export async function confirmPart2");
  const part2Body = runService.slice(part2At, runService.indexOf("\nexport ", part2At + 10));
  assert.match(
    part2Body,
    /findPartSplitConflicts\(await listDraftRows\(runId\)\)/,
    "the backstop must actually run at the Part 2 gate",
  );
  assert.match(
    part2Body,
    /throw new Error\(`Conflict: \$\{describePartSplitConflicts\(partSplitConflicts\)\}`\)/,
    "and it must REFUSE, not warn — waving it through charges somebody twice",
  );

  // And BEFORE the First Part is frozen (audit 2026-11-07): at Part 2 the double charge had already
  // been taken off money paid from Part 1.
  const part1At = runService.indexOf("export async function confirmPart1");
  const part1Body = runService.slice(part1At, runService.indexOf("\nexport ", part1At + 10));
  const guardAt = part1Body.indexOf("findPartSplitConflicts(draftRows)");
  assert.ok(guardAt > 0, "HEADLINE: Part 1 confirm checks for a deduction in both instalments");
  assert.ok(guardAt < part1Body.indexOf("computePart1Freeze("), "before it freezes anything");
  assert.match(part1Body, /throw new Error\(`Conflict: \$\{describePartSplitConflicts\(part1SplitConflicts\)\}`\)/, "and refuses");
}
