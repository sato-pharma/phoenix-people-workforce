import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeDeductionResyncNotApplied,
  payrollStepsForCategory,
  planDeductionResync,
} from "../src/lib/automated-payroll/deduction-resync.ts";
import {
  CLEARABLE_DEDUCTION_COLUMNS,
  CLEARABLE_DEDUCTION_SELECT,
} from "../src/lib/automated-payroll/draft-store.ts";
import { monthRequiresPush } from "../src/lib/deductions/push-cutover.ts";
import { decisionMovesPayroll } from "../src/lib/deductions/service.ts";
import { visibleDeductionsCategories } from "../src/lib/deductions/types.ts";

/**
 * A PUSH AFTER THE STEP WAS CONFIRMED MUST STILL REACH THE PAYSLIP.
 *
 * THE MECHANISM. Every module-sourced payroll step is a snapshot: confirming one copies the figure
 * the Deductions module proposes onto `automated_payroll_draft_rows`, and `assembleRows` reads that
 * copy — never the module — when it works out what anybody is paid.
 *
 * That was safe while the gate was the DECISION: HR decided, then confirmed, in that order. The push
 * gate (owner rule 2026-09-22) inverted it. From 2026-09 nothing is deducted until the Super Admin
 * PUSHES that specific line, and a push routinely lands after the month's Part 1 steps are
 * confirmed. Measured on the live September 2026 run: all ten Part 1 steps confirmed 2026-09-24,
 * every push on 2026-10-06 — so eight pushed fingerprint lines worth 3,333.32 EGP sat behind a step
 * frozen at 0.00, with the step's own breakdown listing them and the sheet charging nothing.
 *
 * Outstation expenses already had this safeguard (expense-resync.ts, built after the July 2026 run
 * paid 1 Aug figures for decisions made on 2 Aug). This pins the deduction twin of it.
 */
export function runDeductionPayrollResyncTests() {
  // ---- Every category routes somewhere, on BOTH sides of the Part 1 split -------------------------
  // A category with no destination is a deduction that can be pushed and can never be unfrozen —
  // exactly the silent hole this module closes, so an unrouted category must fail here rather than
  // in a payroll month.
  for (const category of visibleDeductionsCategories) {
    for (const settled of [true, false]) {
      const destinations = payrollStepsForCategory(category, settled);
      assert.ok(
        destinations.length > 0,
        `${category} (settled_in_part1=${settled}) routes to no payroll step — it could be pushed and never unfrozen`,
      );
      for (const destination of destinations) {
        assert.ok(destination.columns.length > 0, `${category} -> ${destination.stepKey} names no column to clear`);
        for (const column of destination.columns) {
          assert.ok(
            (CLEARABLE_DEDUCTION_COLUMNS as readonly string[]).includes(column),
            `${column} is not in CLEARABLE_DEDUCTION_COLUMNS, so clearDraftColumns would REFUSE it at runtime`,
          );
        }
      }
    }
  }

  // ---- The read-back select is a LITERAL, and it must name exactly that list --------------------
  // PostgREST parses the select string at compile time, so `columns.join(", ")` loses the read's
  // type entirely (TS2352 — the box caught it). The select is therefore spelled out, and these two
  // assertions are the only thing stopping the literal and the allow-list drifting apart: a column
  // added to the list but not the select would read back as undefined, and `carrying` would then
  // report that nobody was holding a figure while the clear silently nulled it.
  const selected = CLEARABLE_DEDUCTION_SELECT.split(",").map((part) => part.trim());
  assert.equal(selected[0], "employee_hr_id", "the returned HR ids come from this read, so it must select them");
  assert.deepEqual(
    selected.slice(1),
    [...CLEARABLE_DEDUCTION_COLUMNS],
    "CLEARABLE_DEDUCTION_SELECT must name every clearable column, in order, and nothing else",
  );

  // ---- The split is the one that keeps the two populations disjoint -------------------------------
  // Leavers and one-part employees settle in Part 1; everybody else in Part 2. Clearing the wrong
  // side would leave the frozen figure exactly where it was while reporting a successful resync.
  assert.deepEqual(
    payrollStepsForCategory("crm", false).map((destination) => destination.stepKey),
    ["p2_crm"],
  );
  assert.deepEqual(
    payrollStepsForCategory("crm", true).map((destination) => destination.stepKey),
    ["p1_crm", "p1_resignation_crm"],
    "a Part 1 employee's CRM can sit on either tab and nothing on the candidate says which — the " +
      "leaver tab writes the shared `crm` column, so both are cleared",
  );
  assert.deepEqual(
    payrollStepsForCategory("unpaid_vacation", false).map((destination) => destination.stepKey),
    ["p2_vacation"],
  );
  assert.deepEqual(
    payrollStepsForCategory("insufficient_balance_vacation", false),
    payrollStepsForCategory("unpaid_vacation", false),
    "both vacation categories share the one salary column, so they must share the one destination",
  );
  assert.ok(
    payrollStepsForCategory("unpaid_vacation", true)[0]?.columns.includes("unpaid_vacations"),
    "recommendP1UnpaidVacation remaps a LEAVER onto the shared `unpaid_vacations` column rather " +
      "than the p1od pair — missing it leaves the leaver frozen",
  );
  assert.deepEqual(
    payrollStepsForCategory("fingerprint", true),
    payrollStepsForCategory("fingerprint", false),
    "p1_fingerprint lists EVERY employee regardless of payment mode — it has one destination, not two",
  );

  // ---- A run whose Part 2 is already confirmed is left alone --------------------------------------
  // Confirming Part 2 settles the carry-forward ledger; rewinding that from a push would undo money
  // decisions nobody asked to undo. Reported as a skip so the caller can say so out loud.
  assert.deepEqual(planDeductionResync(null), { ok: false, reason: "no_active_run" });
  assert.deepEqual(planDeductionResync({ part2ConfirmedAt: "2026-10-01T00:00:00Z" }), {
    ok: false,
    reason: "part2_already_confirmed",
  });
  assert.deepEqual(planDeductionResync({ part2ConfirmedAt: null }), { ok: true });

  // ---- A skip SAYS SO. "Pushed" on one page while payroll pays the old number is the failure ------
  const settled = describeDeductionResyncNotApplied({
    action: "skip",
    monthKey: "2026-09",
    reason: "part2_already_confirmed",
  });
  assert.equal(settled.length, 1);
  assert.ok(settled[0].includes("September 2026"), "the month is named in Cairo-local words, not as a key");
  assert.ok(settled[0].includes("Reopen Part 2"), "and it says what would make the push apply");
  assert.deepEqual(
    describeDeductionResyncNotApplied({ action: "skip", monthKey: "2026-09", reason: "no_active_run" }),
    [],
    "no open run for the month is ordinary and stays quiet",
  );
  assert.equal(
    describeDeductionResyncNotApplied({ action: "resync", monthKey: "2026-09", runId: "r", clearedHrIds: [], reopenedSteps: [] })
      .length,
    0,
  );
  assert.equal(
    describeDeductionResyncNotApplied({ action: "failed", monthKey: "2026-09", message: "boom" }).length,
    1,
    "a failed resync is reported, because the deduction IS pushed and payroll is the half that did not move",
  );
  assert.equal(
    describeDeductionResyncNotApplied({
      action: "resync",
      monthKey: "2026-09",
      runId: "r",
      clearedHrIds: [],
      reopenedSteps: [],
      keptSavedHrIds: ["ai0002"],
    }).length,
    1,
    "a figure a person saved is kept, and the decision says payroll does not include it",
  );
  // An UNconfirmed step can still hold a SAVED figure that recommend.ts prefers over the module
  // (September 2026: a 6 Oct bulk save held 0.00 over approved "other" lines), so the resync must
  // not skip unconfirmed steps — it clears them unless a person saved the cell.
  const resync = readFileSync("src/lib/automated-payroll/deduction-resync.ts", "utf8");
  assert.doesNotMatch(
    resync,
    /if \(!confirmed\.has\(stepKey\)\) continue;/,
    "an unconfirmed step must not be skipped — a saved draft figure there is as stale as a confirmed one",
  );
  assert.match(resync, /listLatestCellWrites\(/, "a person-saved figure is told apart by the cell history");
  assert.match(resync, /isTypedByHand\(/, "…using the cell history's own definition of a person's save");

  // ---- The push gate is retired (owner, 2026-10-07) -----------------------------------------------
  // Payroll reads the DECISION in every month, so no month is gated on a push any more.
  for (const month of ["2026-08", "2026-09", "2026-10", null, "nonsense"]) {
    assert.equal(monthRequiresPush(month), false, `${month} must not be gated on a push — the gate is the decision`);
  }

  // ---- WHICH decision changes re-open a confirmed step ---------------------------------------------
  const approved = "Approved for Payroll";
  assert.equal(decisionMovesPayroll({ before: null, after: { decisionStatus: approved, appliedAmount: 500 } }), true,
    "a first approval moves money");
  assert.equal(decisionMovesPayroll({ before: { decisionStatus: approved, appliedAmount: 500 }, after: { decisionStatus: "Do Not Take Action", appliedAmount: null } }), true,
    "un-approving moves money back");
  assert.equal(decisionMovesPayroll({ before: { decisionStatus: approved, appliedAmount: "500.00" }, after: { decisionStatus: approved, appliedAmount: 250 } }), true,
    "narrowing an approved deduction's days moves money");
  assert.equal(decisionMovesPayroll({ before: { decisionStatus: approved, appliedAmount: "500.00" }, after: { decisionStatus: approved, appliedAmount: 500 } }), false,
    "re-saving the same approved figure must not re-open a confirmed step");
  assert.equal(decisionMovesPayroll({ before: { decisionStatus: "Pending", appliedAmount: null }, after: { decisionStatus: "Needs Follow-up", appliedAmount: null } }), false,
    "a change between two unpaid decisions charges 0.00 either side");

  // ---- The decision path actually calls it, and the push path no longer does ------------------------
  // The whole fix is one call site. A refactor that drops it would leave every unit above passing
  // and the money still frozen, which is precisely how this got shipped the first time.
  const service = readFileSync("src/lib/deductions/service.ts", "utf8");
  const recordDecisionBody = service.slice(service.indexOf("export async function recordDecision"));
  assert.ok(
    recordDecisionBody.includes("resyncPayrollDeductionSteps"),
    "recordDecision must resync the payroll steps, or an approval after a confirm reaches nobody's payslip",
  );
  const push = readFileSync("src/lib/deductions/push.ts", "utf8");
  assert.ok(
    !push.includes("resyncPayrollDeductionSteps"),
    "a push no longer moves payroll money, so it must not re-open a confirmed payroll step",
  );

  // ---- The step labels name the real gate ---------------------------------------------------------
  const steps = readFileSync("src/lib/automated-payroll/step-definitions.ts", "utf8");
  const windowLabel = steps.slice(steps.indexOf("export function stepWindowLabel"));
  assert.ok(
    windowLabel.includes("Approved for Payroll") && windowLabel.includes("pushed or not"),
    "stepWindowLabel must say an APPROVED deduction is paid, pushed or not",
  );
}
