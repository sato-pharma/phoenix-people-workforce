import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { PayrollCrmLeaveUnavailableError } from "../src/lib/automated-payroll/recommend.ts";

/**
 * THE PAYROLL VACATION PATH REFUSES ON A FAILED READ — IT NEVER RETURNS AN EMPTY ANSWER.
 *
 * computeVacationDeductionTotals (automated-payroll/recommend.ts) reads three things: the CRM leave
 * dates, the Phoenix v2 vacation dates, and each employee's vacation balance. All three used to be
 * wrapped in a catch that logged and carried on:
 *
 *   - CRM leave read failed  -> empty map -> "nobody took CRM leave" -> zero leave days settled
 *                               against the balance ledger, silently ("CRM leave load failed
 *                               (non-fatal)").
 *   - v2 dates read failed   -> empty map -> a day a Phoenix request already covers is counted
 *                               again as CRM leave.
 *   - balance check failed   -> balanceDays stayed 0 -> every CRM leave day priced as a salary
 *                               deduction.
 *
 * Each of those is a wrong answer that looks like a real one. They now log AND throw
 * PayrollCrmLeaveUnavailableError. Both collaborators are Supabase-backed, so the rule is pinned
 * against the executable source (comments stripped, so this file's own history in comments cannot
 * satisfy a match), plus the error's words, which are what reach the step.
 */

function executableSource(): string {
  const source = readFileSync("src/lib/automated-payroll/recommend.ts", "utf8");
  return stripComments(source);
}

function between(code: string, startMarker: string, endMarker: string): string {
  const start = code.indexOf(startMarker);
  assert.ok(start >= 0, `could not find ${startMarker} in recommend.ts — the pin must be re-pointed, not dropped`);
  const end = code.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `could not find ${endMarker} after ${startMarker} in recommend.ts`);
  return code.slice(start, end);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export function runAutomatedPayrollCrmLeaveFailsClosedTests() {
  const code = executableSource();
  const THROW = "throw new PayrollCrmLeaveUnavailableError(";

  // ---- THE HEADLINE: A FAILED CRM LEAVE READ STOPS THE RUN ------------------
  const crmLeave = between(code, "async function loadCrmLeaveDatesByCompact(", "async function loadV2VacationDatesByCompact(");
  const crmCatch = crmLeave.slice(crmLeave.indexOf("catch (error)"));
  assert.ok(
    crmLeave.includes("catch (error)") && crmCatch.includes(THROW),
    "loadCrmLeaveDatesByCompact's catch must THROW PayrollCrmLeaveUnavailableError — returning the empty map "
      + "silently books zero CRM leave days for the whole month",
  );
  assert.ok(
    crmCatch.includes("logError("),
    "the CRM leave catch must still log before it throws, so the failure is on the error monitor as well as the step",
  );

  // ---- v2 VACATION DATES: BOTH THE ERROR BRANCH AND THE THROWN READ --------
  const v2 = between(code, "async function loadV2VacationDatesByCompact(", "export function leaverVisitTypeStatus(");
  const v2ErrorBranch = between(v2, "if (error) {", "for (const row of");
  assert.ok(
    v2ErrorBranch.includes(THROW) && !v2ErrorBranch.includes("return byCompact"),
    "loadV2VacationDatesByCompact must throw on a Supabase error, not return the empty map — an empty map "
      + "counts a day a Phoenix request already covers as CRM leave again",
  );
  const v2Catch = v2.slice(v2.indexOf("catch (error)"));
  assert.ok(
    v2Catch.includes(THROW),
    "loadV2VacationDatesByCompact's catch must throw PayrollCrmLeaveUnavailableError for a thrown read",
  );
  assert.ok(
    v2Catch.includes("if (error instanceof PayrollCrmLeaveUnavailableError) throw error;"),
    "the v2 catch must pass its own refusal straight through, so a failed read is logged once, not twice",
  );

  // ---- BALANCE CHECK --------------------------------------------------------
  // End marker re-pointed 2026-10-01: `settleCrmLeaveBalanceForPeriod` was removed when the owner
  // made the CRM vacation importer the one path a CRM leave day reaches a balance by. The next
  // executable declaration after this function is `recommendVacation`.
  const totals = between(code, "export async function computeVacationDeductionTotals(", "function recommendVacation(");
  const balanceCatch = between(totals, "Automated payroll: CRM leave balance check failed", "const unpaidDays");
  assert.ok(
    balanceCatch.includes(THROW),
    "the CRM leave balance check's catch must throw — swallowing it leaves balanceDays at 0 and prices every "
      + "CRM leave day as a salary deduction",
  );

  // ---- NO SWALLOWED VARIANT SURVIVES ANYWHERE -------------------------------
  assert.equal(
    code.includes("(non-fatal)"),
    false,
    "no catch on the payroll vacation path may be labelled non-fatal — the three reads fail closed now",
  );
  assert.ok(
    countOccurrences(totals, "loadCrmLeaveDatesByCompact(period)") === 1,
    "computeVacationDeductionTotals must still read CRM leave through loadCrmLeaveDatesByCompact",
  );

  // ---- THE READS FAIL CLOSED WHEREVER THEY ARE CALLED FROM, AND THE CONFIRM NO LONGER CALLS THEM -
  //
  // This section used to pin the ORDER inside confirmStep: compute the vacation totals BEFORE
  // writing the confirmed step state, so a refused read left p2_vacation unconfirmed rather than
  // confirmed with no balance settlement behind it. That ordering mattered only because the confirm
  // then WROTE a settlement. It no longer writes one — the CRM vacation importer is the single path
  // a CRM leave day reaches a balance by (owner, 2026-10-01) — so the confirm does not read CRM
  // leave at all, and the thing to pin is that it stays that way.
  //
  // The fail-closed rule itself is unchanged and still pinned above, against recommend.ts, which is
  // where it lives and where any future caller inherits it.
  const runService = stripComments(readFileSync("src/lib/automated-payroll/run-service.ts", "utf8"));
  assert.equal(
    runService.includes("computeVacationDeductionTotals"),
    false,
    "confirmStep must not compute the CRM vacation totals: nothing downstream consumes the result now, so its "
      + "refusal on an unreadable CRM feed or Egypt holiday calendar would block a payroll confirm for no benefit",
  );
  assert.equal(
    runService.includes("settleCrmLeaveBalanceForPeriod"),
    false,
    "confirming a payroll step must write NO row to payroll_copilot_vacation_settlements — see "
      + "tests/automated-payroll-crm-leave-one-mechanism.test.ts for why a second mechanism double-charges leave",
  );

  // ---- THE WORDS THAT REACH THE STEP ----------------------------------------
  const error = new PayrollCrmLeaveUnavailableError({ month: 8, year: 2026 }, "the CRM leave records");
  assert.ok(error instanceof Error, "the refusal must be a real Error so the route's jsonError handles it");
  assert.equal(error.name, "PayrollCrmLeaveUnavailableError");
  assert.ok(
    error.message.startsWith("Conflict: the CRM leave records for "),
    `the refusal must open with "Conflict:" so it is reported as a visible conflict, got: ${error.message}`,
  );
  assert.ok(
    error.message.includes("cannot compute vacation deductions without CRM leave data"),
    "the refusal must say the run cannot compute vacation deductions without CRM leave data",
  );
}
