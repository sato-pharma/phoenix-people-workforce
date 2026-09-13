import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
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
  const totals = between(code, "export async function computeVacationDeductionTotals(", "export async function settleCrmLeaveBalanceForPeriod(");
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

  // ---- A REFUSAL LEAVES THE STEP UNCONFIRMED --------------------------------
  // confirmStep used to mark p2_vacation "confirmed" and only THEN compute the vacation totals, so a
  // refusal left a confirmed step with no balance settlement behind it.
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const confirm = runService.slice(runService.indexOf("export async function confirmStep("));
  const computeAt = confirm.indexOf("computeVacationDeductionTotals(members, sources, period, runId)");
  const confirmedAt = confirm.indexOf('status: "confirmed"');
  assert.ok(
    computeAt >= 0 && confirmedAt >= 0 && computeAt < confirmedAt,
    "confirmStep must compute the vacation totals BEFORE it writes the confirmed step state — a refusal must leave "
      + "p2_vacation unconfirmed, never confirmed with no balance settlement",
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
