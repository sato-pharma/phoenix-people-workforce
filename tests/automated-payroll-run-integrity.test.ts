import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  compareConfirmedTotals,
  describeTotalsDrift,
  PART2_TOTALS_KEY,
  part2Totals,
  readConfirmedTotals,
} from "../src/lib/automated-payroll/publish-guard.ts";

/**
 * A CONFIRMED RUN STOPS MOVING, AND REOPENING ONE ACTUALLY RE-DERIVES IT.
 *
 * FINDING 18 — THE RUN STAYED EDITABLE AFTER THE MONEY LEFT. `ready` means Part 2 is confirmed and
 * the finance sheet and both bank files are downloadable, which in practice means finance has them.
 * Every step stayed writable anyway: the lock HR sees is a browser property, never a server rule.
 * A stale tab, a retry or a direct call could change a figure after the transfer had gone, and
 * publish — which re-assembles live from current data and checked nothing but the run's phase —
 * would then write the changed row to the payslip. The employee's payslip and their bank transfer
 * would disagree, with nothing recording that they ever differed.
 *
 * Three pieces, and all three are needed:
 *   1. A step write is REFUSED in `ready`.
 *   2. `unconfirmPart2` is the way back — without it, refusing writes would trap the month with
 *      nothing but Cancel as an exit.
 *   3. Publish re-runs the gates and compares the sheet it is about to write against the totals
 *      Part 2 confirm stamped.
 *
 * FINDING 20 — REOPENING PART 1 DID NOT RE-DERIVE. Reopening exists for exactly one purpose: a
 * wrong base salary was found and the first instalment must be refrozen off the corrected record.
 * It cleared the frozen figure but not the Base, allowance, fuel and days-worked figures that
 * confirming the Joiners and Resignations steps stamped onto those same rows — and a stored figure
 * BEATS the employee record. So re-confirming refroze the identical wrong answer, and reported
 * success. A rep hired on 10 August at 5,000 instead of 8,000 stayed on the 5,000.
 *
 * Clearing is safe here in the way finding 19's near-miss was not: `effectiveSalary` reads these
 * through `overrideBase != null`, so an absent figure RECOMPUTES rather than reading as zero. That
 * distinction is the whole reason this fix is a clear and finding 19's could not be.
 */

const CONFIRMED = {
  employees: 100,
  firstPart: 700_000,
  secondPart: 500_000,
  monthSalary: 1_200_000,
  net: 1_250_000,
};

function bounded(source: string, start: string): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `could not find ${start}`);
  const end = source.indexOf("\nexport ", at + start.length);
  const body = source.slice(at, end > 0 ? end : undefined);
  assert.ok(body.length > 200 && body.length < 23000, `${start} slice must stay bounded (${body.length})`);
  return body;
}

export async function runAutomatedPayrollRunIntegrityTests() {
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");

  // ---- HEADLINE (18a): no step write survives Part 2 confirm ----------------------------------
  const phaseGuard = runService.slice(
    runService.indexOf("function assertStepPhaseAllowed"),
    runService.indexOf("function assertStepPhaseAllowed") + 1800,
  );
  assert.match(
    phaseGuard,
    /if \(run\.phase === "ready"\)/,
    "a step write must be refused once Part 2 is confirmed — finance may already have executed the " +
      "bank files, and publishing a changed row afterwards writes a payslip that disagrees with the " +
      "transfer that was already sent",
  );
  assert.match(
    phaseGuard,
    /Reopen Part 2/,
    "and the refusal must name the way back, or HR is stuck with Cancel as their only exit",
  );

  // ---- (18b) the way back exists, and undoes what the confirm did --------------------------------
  const reopen = bounded(runService, "export async function unconfirmPart2");
  assert.match(reopen, /if \(run\.phase !== "ready"\)/, "reopening only makes sense from ready");
  assert.match(reopen, /releaseCarryForwardForCancelledRun\(runId\)/,
    "reopening must undo this run's carry-forward marks: a run that is no longer confirmed has " +
      "collected nothing, and leaving them forgives real money");
  assert.match(reopen, /phase: "part2"/, "and it must actually put the run back");
  assert.match(reopen, /part2ConfirmedAt: null/, "clearing the confirmation stamp");
  assert.match(reopen, /action: "part2_unconfirmed"/, "on the record, like every other reversal");

  // ---- (20) reopening Part 1 clears what confirming Part 1 stamped -------------------------------
  const reopenPart1 = bounded(runService, "export async function unconfirmPart1");
  for (const column of ["baseForMonth: null", "ecolPaid: null", "fuelPaid: null", "daysWorked: null"]) {
    assert.ok(
      reopenPart1.includes(column),
      `reopening Part 1 must clear ${column.split(":")[0]} — a stored figure beats the employee ` +
        "record, so leaving it refreezes the exact wrong answer the reopen was meant to correct",
    );
  }
  assert.ok(reopenPart1.includes("firstPartFrozen: null"), "and still clear the frozen figure itself");
  assert.match(reopenPart1, /stampedBasisCleared/, "the audit row says how many rows were re-derived");

  // ---- (18c) publish re-runs the gates against what it is about to write -------------------------
  const publish = bounded(runService, "export async function publishToPayslips");
  assert.match(publish, /preflightAtPublish\(rows\)/, "publish must re-run the pre-flight validation");
  assert.match(publish, /const publishTotals = reconcile\(rows\)/, "and the reconciliation");
  assert.match(
    publish,
    /publishTotals\.splitMismatches\.length > 0/,
    "including the split check, against the rows about to be written",
  );
  assert.match(
    publish,
    /assertMatchesPart2Confirm\(confirmedStamp, part2Totals\(rows\.length, publishTotals\), "publish"\)/,
    "and it must compare the sheet it is writing against the one Part 2 confirmed — a difference, or no " +
      "stamp, REFUSES (the refusal itself is pinned in automated-payroll-money-integrity.test.ts)",
  );

  // The stamp has to be written, or there is nothing to compare against.
  const confirm = bounded(runService, "export async function confirmPart2");
  assert.match(
    confirm,
    /const confirmedTotals = part2Totals\(rows\.length, totals\)[\s\S]*\[PART2_TOTALS_KEY\]: confirmedTotals/,
    "Part 2 confirm must stamp the totals of the sheet it confirmed",
  );

  // ---- The stamp read FAILS CLOSED ----------------------------------------------------------------
  const reader = runService.slice(
    runService.indexOf("async function readPart2ConfirmedTotals"),
    runService.indexOf("async function readPart2ConfirmedTotals") + 1400,
  );
  assert.match(
    reader,
    /if \(error\) \{\s*throw new Error\(/,
    "a failed read must stop the publish — 'could not compare' must never read as 'compared and " +
      "matched', which is the exact shape of the fail-open defects already fixed in this module",
  );

  // ---- The pure comparison ------------------------------------------------------------------------
  assert.deepEqual(
    part2Totals(100, {
      totalFirstPart: 700_000,
      totalSecondPart: 500_000,
      totalMonthSalary: 1_200_000,
      totalNet: 1_250_000,
    }),
    CONFIRMED,
    "the stamp carries the employee count and the four money totals",
  );

  assert.deepEqual(
    compareConfirmedTotals(CONFIRMED, CONFIRMED),
    [],
    "an unchanged month publishes",
  );
  assert.deepEqual(
    compareConfirmedTotals(CONFIRMED, { ...CONFIRMED, net: CONFIRMED.net + 0.004 }),
    [],
    "and a sub-cent difference is addition order, not a changed month",
  );

  const drift = compareConfirmedTotals(CONFIRMED, { ...CONFIRMED, monthSalary: 1_200_500 });
  assert.equal(drift.length, 1, "500 EGP appearing after the bank files were built is a refusal");
  assert.equal(drift[0]?.field, "monthSalary");

  const lostPerson = compareConfirmedTotals(CONFIRMED, { ...CONFIRMED, employees: 99 });
  assert.equal(lostPerson.length, 1, "a person leaving the sheet between confirm and publish counts");
  assert.equal(lostPerson[0]?.field, "employees");

  const said = describeTotalsDrift(drift);
  assert.match(said, /total month salary/, "the message names the figure that moved");
  assert.match(said, /Reopen Part 2/, "and what to do about it");

  // ---- Reading a stamp back ------------------------------------------------------------------------
  assert.deepEqual(
    readConfirmedTotals({ [PART2_TOTALS_KEY]: CONFIRMED }),
    CONFIRMED,
    "a stamped audit row reads back",
  );
  assert.equal(readConfirmedTotals({ employees: 100 }), null, "a run predating the stamp reads null");
  assert.equal(readConfirmedTotals(null), null, "and so does an absent detail");
  assert.equal(
    readConfirmedTotals({ [PART2_TOTALS_KEY]: { employees: 100, firstPart: 1 } }),
    null,
    "a half-written stamp is no stamp — comparing on partial figures would pass on the missing ones",
  );

  // ---- Reachability: a reopen nobody can press is not a way back -------------------------------------
  const route = readFileSync("app/api/automated-payroll/runs/[runId]/part2/unconfirm/route.ts", "utf8");
  assert.ok(route.includes("unconfirmPart2"), "the route must call the service function");
  assert.ok(route.includes("assertSameOriginMutation"), "and carry the CSRF guard every sibling has");

  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.ok(
    registry.includes("/api/automated-payroll/runs/:runId/part2/unconfirm"),
    "the route must be in the access registry, which is a required CI check",
  );

  const wizard = readFileSync("src/components/automated-payroll/automated-payroll-wizard.tsx", "utf8");
  assert.ok(
    wizard.includes("/part2/unconfirm"),
    "and the wizard must expose it — refusing every step write while offering no way back would " +
      "leave Cancel as HR's only exit from a confirmed month",
  );
}
