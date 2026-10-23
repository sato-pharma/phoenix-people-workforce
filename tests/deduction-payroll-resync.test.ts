import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeDeductionResyncNotApplied,
  payrollStepsForCategory,
  planDeductionResync,
  resyncPayrollDeductionSteps,
  type ResyncDeps,
} from "../src/lib/automated-payroll/deduction-resync.ts";
import {
  CLEARABLE_DEDUCTION_COLUMNS,
  CLEARABLE_DEDUCTION_SELECT,
} from "../src/lib/automated-payroll/draft-store.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { DraftRow, MonthlySalaryRun, StepState } from "../src/lib/automated-payroll/types.ts";
import { monthRequiresPush } from "../src/lib/deductions/push-cutover.ts";
import { decisionMovesPayroll } from "../src/lib/deductions/service.ts";
import { visibleDeductionsCategories, type DeductionsCategory } from "../src/lib/deductions/types.ts";

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
export async function runDeductionPayrollResyncTests() {
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

  // ---- The re-collect CARRY path resyncs too (owner, 2026-10-07) ----------------------------------
  // A vacation/CRM re-collect supersedes a decided candidate and carries, drops or retires its
  // decision onto a replacement. When that decision was Approved, the figure a confirmed step froze
  // has just moved — so reconcile must resync exactly as the single-decision paths do, or an
  // approved deduction stays frozen on the sheet after a routine nightly re-collect. This is the
  // last approval path that did not, and the gap the owner reported ("any approved deduction, even
  // a manual one, should appear in Automated Payroll"). It is one call site, so pin it.
  const reconcileBody = service.slice(
    service.indexOf("export async function reconcileCandidateDrafts"),
    service.indexOf("function mapCandidateRow"),
  );
  assert.ok(reconcileBody.length > 0, "reconcileCandidateDrafts must be found in the service");
  assert.ok(
    reconcileBody.includes("resyncPayrollDeductionSteps"),
    "reconcileCandidateDrafts must resync the payroll steps, or a re-collect leaves an approved deduction frozen",
  );
  assert.ok(
    reconcileBody.includes('"Approved for Payroll"') && reconcileBody.includes("payrollResyncCompacts"),
    "it must gate the resync on the SUPERSEDED decision having been Approved — a non-approved row charges 0.00 either side, so re-opening a step for it would only make HR re-confirm the same figure",
  );

  // ---- The step labels name the real gate ---------------------------------------------------------
  const steps = readFileSync("src/lib/automated-payroll/step-definitions.ts", "utf8");
  const windowLabel = steps.slice(steps.indexOf("export function stepWindowLabel"));
  assert.ok(
    windowLabel.includes("Approved for Payroll") && windowLabel.includes("pushed or not"),
    "stepWindowLabel must say an APPROVED deduction is paid, pushed or not",
  );

  // ---- A LEAVER'S CRM CLEAR MUST FOLLOW THE SAME SPLIT THE FREEZE DID ------------------------------
  // recommend.ts freezes a leaver's CRM through the Part 1 steps, because isSettledInPart1 falls
  // back to `lifecycle === "leaver"` while the draft's settled_in_part1 flag is still NULL (it is
  // written only at confirmPart1, so it is NULL for the whole Part 1 phase). The resync used to read
  // that raw NULL flag as false and route the clear to the Part 2 CRM step instead — leaving the
  // confirmed Part 1 resignation-CRM step frozen on a stale figure and the first instalment
  // underpaid. This drives the REAL orchestrator with faked data access and asserts it re-opens
  // p1_resignation_crm, never p2_crm. Before the fix reopenedSteps is empty and nothing is re-opened.
  {
    const clears: { columns: string[] }[] = [];
    const upserts: string[] = [];
    const deps: ResyncDeps = {
      findActiveRun: async () => ({ id: "run-1", part2ConfirmedAt: null } as unknown as MonthlySalaryRun),
      listStepStates: async () => [
        { runId: "run-1", stepKey: "p1_resignation_crm", status: "confirmed" } as unknown as StepState,
      ],
      // A leaver, draft flag still NULL (Part 1 phase), no salary source — exactly the shape that
      // made isSettledInPart1 fall back to the live lifecycle derivation.
      loadStepContext: async () => ({
        members: [
          { compact: "ai0001", lifecycle: "leaver", employee: { hrId: "AI-0001" } } as unknown as PopulationMember,
        ],
        sources: new Map(),
      }),
      listDraftRows: async () => [
        { employeeHrIdCompact: "ai0001", employeeHrId: "AI-0001", settledInPart1: null } as unknown as DraftRow,
      ],
      clearDraftColumns: async (_runId, hrIds, columns) => {
        clears.push({ columns });
        return hrIds;
      },
      upsertStepState: async (input) => {
        upserts.push(input.stepKey);
        return {} as unknown as StepState;
      },
      listLatestCellWrites: async () => new Map(),
      holdRun: async (_input, work) => work(),
    };

    const outcome = await resyncPayrollDeductionSteps(
      { monthKey: "2026-10", employees: [{ hrIdCompact: "ai0001", categories: ["crm"] as DeductionsCategory[] }] },
      deps,
    );

    assert.equal(outcome.action, "resync");
    if (outcome.action !== "resync") throw new Error("expected a resync outcome");
    assert.ok(
      outcome.reopenedSteps.includes("p1_resignation_crm"),
      "a leaver frozen via p1_resignation_crm must be re-opened there — reading the NULL settled_in_part1 flag as false routed the clear to p2_crm and left the confirmed Part 1 step frozen too low",
    );
    assert.ok(
      !outcome.reopenedSteps.includes("p2_crm"),
      "a leaver settles in Part 1 — p2_crm is the wrong side of the split and must not be re-opened",
    );
    assert.ok(
      upserts.includes("p1_resignation_crm") && !upserts.includes("p2_crm"),
      "the confirmed Part 1 resignation-CRM step is the one put back to pending, never the Part 2 step",
    );
    assert.ok(
      clears.some((clear) => clear.columns.includes("crm")),
      "the shared `crm` column a leaver's resignation-CRM freeze writes must be the one cleared",
    );
  }

  // ---- A CONFIRMED PART 1 EMPLOYEE WHO LEFT THE LIVE POPULATION STILL CLEARS IN PART 1 ------------
  // After Part 1 is confirmed, `settled_in_part1` is written true for a leaver/one-part employee. If
  // that employee then drops out of the freshly derived members (employment or payroll eligibility
  // changed before the re-collect), the live loop in loadSettledInPart1 never visits them — so
  // reading their ABSENCE as false routed the clear to the Part 2 step and left the frozen Part 1
  // deduction payable. loadSettledInPart1 now seeds from the stored non-null flag FIRST, so the
  // clear follows the step that actually froze them. Before the fix reopenedSteps is empty (p2_crm
  // is not confirmed, p1_crm is never targeted) and the stale Part 1 figure stands.
  {
    const upserts: string[] = [];
    const clears: { columns: string[] }[] = [];
    const deps: ResyncDeps = {
      findActiveRun: async () => ({ id: "run-2", part2ConfirmedAt: null } as unknown as MonthlySalaryRun),
      listStepStates: async () => [
        { runId: "run-2", stepKey: "p1_crm", status: "confirmed" } as unknown as StepState,
      ],
      // The employee is GONE from the live population — no member, no source.
      loadStepContext: async () => ({ members: [], sources: new Map() }),
      // …but the run's own draft still records that Part 1 froze them.
      listDraftRows: async () => [
        { employeeHrIdCompact: "ai0002", employeeHrId: "AI-0002", settledInPart1: true } as unknown as DraftRow,
      ],
      clearDraftColumns: async (_runId, hrIds, columns) => {
        clears.push({ columns });
        return hrIds;
      },
      upsertStepState: async (input) => {
        upserts.push(input.stepKey);
        return {} as unknown as StepState;
      },
      listLatestCellWrites: async () => new Map(),
      holdRun: async (_input, work) => work(),
    };

    const outcome = await resyncPayrollDeductionSteps(
      { monthKey: "2026-10", employees: [{ hrIdCompact: "ai0002", categories: ["crm"] as DeductionsCategory[] }] },
      deps,
    );

    assert.equal(outcome.action, "resync");
    if (outcome.action !== "resync") throw new Error("expected a resync outcome");
    assert.ok(
      outcome.reopenedSteps.includes("p1_crm"),
      "a stored settled_in_part1=true employee missing from the live population must still re-open their Part 1 step — reading the absence as false routed the clear to Part 2 and left the frozen Part 1 deduction payable",
    );
    assert.ok(
      !outcome.reopenedSteps.includes("p2_crm"),
      "the Part 2 step is the wrong side of the split for a Part-1-frozen employee and must not be re-opened",
    );
    assert.ok(
      upserts.includes("p1_crm") && !upserts.includes("p2_crm"),
      "the confirmed Part 1 CRM step is the one put back to pending, never the Part 2 step",
    );
    assert.ok(
      clears.some((clear) => clear.columns.includes("crm")),
      "the `crm` column the Part 1 freeze wrote must be the one cleared",
    );
  }

  // ---- A STORED-ROUTE RESYNC MUST NOT DEPEND ON THE LIVE FEEDER GRAPH -----------------------------
  // Once Part 1 is confirmed the stored settled_in_part1 flag is authoritative and SUFFICIENT, so the
  // resync must not read the live payroll population when every requested employee already has a
  // stored route. Otherwise an unrelated directory/salary-feeder read failure fails the WHOLE resync
  // and leaves a newly approved deduction frozen out of payroll despite its route being known. Before
  // the fix loadStepContext was always awaited (Promise.all) and its throw returned action:"failed";
  // now it is skipped entirely, and the clear/reopen proceed from the stored flag.
  {
    const upserts: string[] = [];
    const deps: ResyncDeps = {
      findActiveRun: async () => ({ id: "run-3", part2ConfirmedAt: null } as unknown as MonthlySalaryRun),
      listStepStates: async () => [
        { runId: "run-3", stepKey: "p1_crm", status: "confirmed" } as unknown as StepState,
      ],
      // The live feeder graph is DOWN — and must never be consulted, because every requested
      // employee already has a stored route.
      loadStepContext: async () => {
        throw new Error("directory/salary feeder unavailable");
      },
      listDraftRows: async () => [
        { employeeHrIdCompact: "ai0003", employeeHrId: "AI-0003", settledInPart1: true } as unknown as DraftRow,
      ],
      clearDraftColumns: async (_runId, hrIds) => hrIds,
      upsertStepState: async (input) => {
        upserts.push(input.stepKey);
        return {} as unknown as StepState;
      },
      listLatestCellWrites: async () => new Map(),
      holdRun: async (_input, work) => work(),
    };

    const outcome = await resyncPayrollDeductionSteps(
      { monthKey: "2026-10", employees: [{ hrIdCompact: "ai0003", categories: ["crm"] as DeductionsCategory[] }] },
      deps,
    );

    assert.equal(
      outcome.action,
      "resync",
      "a resync whose every employee has a stored route must succeed even when the live feeder graph throws — the stored flag is sufficient and the live read must be skipped",
    );
    assert.ok(
      outcome.action === "resync" && outcome.reopenedSteps.includes("p1_crm"),
      "…and it still re-opens the Part 1 step from the stored route",
    );
    assert.ok(upserts.includes("p1_crm"), "the confirmed Part 1 step is put back to pending from the stored route alone");
  }
}
