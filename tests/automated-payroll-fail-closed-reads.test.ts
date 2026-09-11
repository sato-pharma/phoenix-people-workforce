import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildFeederStates } from "../src/lib/payroll/copilot/feeders.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * A FAILED READ MUST NOT LOOK LIKE A QUIET MONTH.
 *
 * Two reads in the payroll path answered a database failure with an empty result. Neither raised
 * anything a person would see, and in both cases "empty" is a perfectly ordinary answer — which is
 * what makes the failure invisible.
 *
 * FINDING 34 — THE LEAVERS READ. An empty leaver set does not merely lose a signal, it removes
 * people from the run. `recommendPopulation` keeps a payroll-ineligible employee only when they
 * are a leaver this month or are serving notice into a later one, and `employment_status` flips to
 * a terminal value the moment a resignation is approved. So with no leaver rows every one of them
 * is ineligible, not a leaver, not on notice, and is skipped — their final month gone from every
 * step and every sheet.
 *
 * Measured on production: every leaver since June carries a terminal status, so all of them would
 * go. August 2026 alone is 30 people and 579,000 EGP of monthly net salary.
 *
 * FINDING 14 — THE CRM COLLECTOR. Two separate shapes. A discarded error on the job-title read
 * left every title null, and a null title reads as "Saturday off", so every Saturday weighted to
 * zero and the month quietly under-charged. And an empty draft set let one collection run retire
 * every live candidate in scope, because retirement is driven by absence from the fresh set.
 *
 * THE ASYMMETRY IS DELIBERATE. `safeRows` stays defensive for the other feeders: an unpaid-leave
 * read that fails loses a deduction, which is recoverable and must never stop a payroll month. A
 * leavers read that fails loses a person's whole final salary. Same mechanism, different cost, so
 * a different answer.
 */

const JUNE = { month: 6, year: 2026 };

function feederWorld(options: { failOn?: Record<string, string> } = {}) {
  return fakeSupabaseClient(
    {
      v2_vacation_requests: [
        {
          employee_hr_id: "B-1",
          duration_days: 3,
          status: "approved",
          payment_status: "unpaid",
          start_date: "2026-06-05",
          end_date: "2026-06-07",
        },
      ],
      employee_resignations: [
        {
          employee_hr_id: "B-2",
          last_working_date: "2026-06-20",
          exit_status: "approved",
        },
      ],
    },
    options,
  );
}

export async function runAutomatedPayrollFailClosedReadTests() {
  // ---- The healthy case still works --------------------------------------------------------
  const healthy = await buildFeederStates(JUNE, feederWorld() as never);
  assert.equal(healthy.get("b1")?.unpaidLeaveDays, 3, "unpaid leave is still collected");
  assert.equal(
    healthy.get("b2")?.leaverLastWorkingDate,
    "2026-06-20",
    "and the leaver is still found",
  );

  // ---- HEADLINE: a failed leavers read stops the run ----------------------------------------
  await assert.rejects(
    () =>
      buildFeederStates(
        JUNE,
        feederWorld({ failOn: { employee_resignations: "connection reset" } }) as never,
      ),
    /leavers/i,
    "a payroll run that cannot read its leavers must stop and say so — carrying on drops every " +
      "already-resigned employee from the population and loses their final month with no error",
  );

  // The message has to name the consequence, not just the failure: somebody reading it at 4am
  // needs to know what carrying on would have cost.
  const failure = await buildFeederStates(
    JUNE,
    feederWorld({ failOn: { employee_resignations: "connection reset" } }) as never,
  ).catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /dropped from the run/i, "it says what would have happened");
  assert.match(failure.message, /connection reset/, "and carries the underlying cause");

  // ---- The other feeders stay defensive, deliberately ------------------------------------------
  // Losing an unpaid-leave deduction is recoverable and must never stop a payroll month.
  const vacationDown = await buildFeederStates(
    JUNE,
    feederWorld({ failOn: { v2_vacation_requests: "statement timeout" } }) as never,
  );
  assert.equal(
    vacationDown.get("b1")?.unpaidLeaveDays,
    undefined,
    "the unpaid-leave signal is simply absent",
  );
  assert.equal(
    vacationDown.get("b2")?.leaverLastWorkingDate,
    "2026-06-20",
    "and the run still builds, with its leavers intact — a lost deduction is not a lost person",
  );

  // ---- FINDING 14a: the CRM job-title read no longer discards its error -------------------------
  // The weighting rule is what makes this matter: a null title reads as "Saturday off", so a failed
  // read silently zeroes every Saturday. Checked on the source because the read sits inside a
  // collector whose other inputs are a live CRM scan.
  const crmSource = readFileSync("src/lib/deductions/connectors/crm.ts", "utf8");
  const titleBlockStart = crmSource.indexOf("const titleByHrIdKey = new Map<string, string | null>();");
  assert.ok(titleBlockStart > 0, "the job-title lookup must still be findable");
  const titleBlock = crmSource.slice(titleBlockStart, titleBlockStart + 1200);
  assert.match(
    titleBlock,
    /const \{ data, error \} = await/,
    "the job-title read must take its error — discarding it left every title null, which the day " +
      "weighting reads as 'Saturday off' and charges at zero",
  );
  assert.match(titleBlock, /throw new Error\(/, "and a failure must stop the collection, not shrink it");

  // ---- FINDING 14b: an empty source may not retire the whole month ------------------------------
  // Retirement is driven by ABSENCE from the fresh draft set, so a source that produced nothing at
  // all would retire every live candidate in scope. Bounded slice of the reconcile.
  const serviceSource = readFileSync("src/lib/deductions/service.ts", "utf8");
  const reconcileStart = serviceSource.indexOf("export async function reconcileCandidateDrafts");
  const reconcileEnd = serviceSource.indexOf("\nexport ", reconcileStart + 10);
  assert.ok(reconcileStart > 0 && reconcileEnd > reconcileStart, "reconcile and its end must be found");
  const reconcileBody = serviceSource.slice(reconcileStart, reconcileEnd);
  // Bounded so a lost end marker cannot silently widen this to the whole file. The function is
  // ~11.8k today; the ceiling leaves room to grow without letting it swallow its neighbours.
  assert.ok(
    reconcileBody.length > 2000 && reconcileBody.length < 16000,
    `the slice must stay bounded to reconcileCandidateDrafts (got ${reconcileBody.length})`,
  );
  assert.match(
    reconcileBody,
    /input\.drafts\.length === 0 && scoped\.length > 0/,
    "a source that produced no candidates while live ones exist must retire nothing — one such " +
      "run would otherwise wipe the month's deductions",
  );
  assert.match(
    reconcileBody,
    /Nothing was retired/,
    "and it must say so, because a silent no-op is what this whole check is about",
  );
}
