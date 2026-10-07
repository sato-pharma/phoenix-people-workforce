import { logError } from "@/lib/observability/log";
import type { DeductionsCategory } from "@/lib/deductions/types";

import { isTypedByHand } from "./cell-history-labels.ts";
import {
  clearDraftColumns,
  findActiveRun,
  listDraftRows,
  listLatestCellWrites,
  listStepStates,
  upsertStepState,
} from "./draft-store.ts";
import { monthNameAndYear } from "./step-definitions.ts";
import type { StepKey } from "./types.ts";

/**
 * Keeps the payroll deduction steps honest when a deduction's DECISION changes underneath them.
 *
 * Called from `recordDecision` (deductions/service.ts) whenever a decision crosses into or out of
 * "Approved for Payroll", or an approved amount changes. Until 2026-10-07 it was called from the
 * PUSH instead, because the push was the gate for pay; the owner retired that gate that day and
 * payroll reads the decision again, so the trigger moved with it. The account below is how the
 * snapshot problem was found, under the push gate; the mechanism is identical either way.
 *
 * WHY THIS EXISTS (measured on the live September 2026 run, 2026-10-06). Every module-sourced step
 * is a SNAPSHOT: confirming one copies the figure the Deductions module is proposing onto
 * `automated_payroll_draft_rows`, and from that moment the payroll sheet is built from those columns
 * alone (assemble.ts reads `num(draft?.fingerprintValue)`, never the module). The recommendation is
 * still recalculated on every load and then thrown away, because a saved draft value always wins
 * (`pick` in recommend.ts).
 *
 * That was tolerable while the gate was a DECISION — HR decided, then confirmed the step, in that
 * order. The push gate (owner rule 2026-09-22, `DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY`) inverted
 * it: from 2026-09 nothing is deducted until the Super Admin PUSHES that specific line, and a push
 * routinely happens days or weeks after the month's Part 1 steps were confirmed. The September run
 * is exactly that shape — all ten Part 1 steps confirmed 2026-09-24, every push on 2026-10-06 — so
 * 3,333.32 EGP of pushed fingerprint deductions against two one-part employees sat behind a step
 * frozen at 0.00, with the step's own breakdown showing the lines and the sheet charging nothing.
 *
 * Outstation expenses already had this exact safeguard (expense-resync.ts, built after the July 2026
 * run paid 1 Aug figures for decisions made on 2 Aug). This is the same mechanism for deductions:
 * clear the frozen figure for exactly the employees whose pushed set moved, and re-open the step
 * that owns it — which also blocks Part 2 (`assertAllStepsConfirmed`) until HR has looked again.
 *
 * It NEVER throws. The decision itself is already written and is the user's actual intent; a resync
 * failure must not roll it back or surface as "decision failed". It is logged loudly and returned,
 * because a silent no-op here is the exact failure this module exists to end.
 */

/** One employee whose pushed set moved, and the categories it moved in. */
export type DeductionResyncEmployee = {
  /** Compact HR id, as the candidate carries it. */
  hrIdCompact: string;
  categories: readonly DeductionsCategory[];
};

export type DeductionResyncTarget = {
  /** `YYYY-MM`, already normalized by the caller. */
  monthKey: string;
  employees: DeductionResyncEmployee[];
};

export type DeductionResyncSkipReason = "no_active_run" | "part2_already_confirmed";

export type DeductionResyncOutcome =
  | {
      action: "resync";
      monthKey: string;
      runId: string;
      /** HR ids whose frozen figure really moved — rows that actually carried one. */
      clearedHrIds: string[];
      /** Confirmed steps put back to pending. Empty when nothing was confirmed yet. */
      reopenedSteps: StepKey[];
      /**
       * HR ids left untouched on an UNconfirmed step because a person saved that figure (the cell
       * history's `step_saved`). Their figure now differs from the approved deductions, so the
       * caller says so instead of overwriting a person's entry.
       */
      keptSavedHrIds?: string[];
    }
  | { action: "skip"; monthKey: string; reason: DeductionResyncSkipReason }
  | { action: "failed"; monthKey: string; message: string };

/** One payroll step and the draft columns it freezes a module figure into. */
export type DeductionStepColumns = { stepKey: StepKey; columns: readonly string[] };

/**
 * Where a category's money lands on the run, for an employee on each side of the Part 1 split.
 *
 * Mirrors recommend.ts's own routing, which is governed by `isSettledInPart1` (leavers and one-part
 * employees settle in Part 1; everybody else in Part 2) — the split that keeps the two populations
 * disjoint so nobody is charged twice. The column names are the DB columns in
 * `automated_payroll_draft_rows`, because clearing happens there.
 *
 * Fingerprint is the one category with a single destination: `p1_fingerprint` lists EVERY employee
 * regardless of payment mode, so it is returned for both sides.
 *
 * For a Part-1 employee the CRM and vacation entries deliberately include the leaver-remap columns
 * (`crm`, `unpaid_vacations`) alongside the `p1od_*` ones. recommendP1UnpaidVacation and
 * recommendResignationCrm write a LEAVER's figure into those shared columns rather than the p1od
 * pair, and nothing on the candidate says which of the two the employee is. Clearing both is safe:
 * for a one-part non-leaver the shared columns carry nothing the Part 1 steps ever wrote, so the
 * clear is a no-op in money terms, whereas missing the leaver case would leave the very row this
 * module exists to unfreeze still frozen.
 */
export function payrollStepsForCategory(
  category: DeductionsCategory,
  settledInPart1: boolean,
): DeductionStepColumns[] {
  switch (category) {
    case "fingerprint":
      return [{ stepKey: "p1_fingerprint", columns: ["fingerprint_days", "fingerprint_value"] }];
    case "crm":
      return settledInPart1
        ? [
            { stepKey: "p1_crm", columns: ["p1od_crm_days", "p1od_crm_value"] },
            { stepKey: "p1_resignation_crm", columns: ["resignation_crm_days", "crm"] },
          ]
        : [{ stepKey: "p2_crm", columns: ["crm"] }];
    case "unpaid_vacation":
    case "insufficient_balance_vacation":
      return settledInPart1
        ? [
            {
              stepKey: "p1_unpaid_vacation",
              columns: ["p1od_vacation_days", "p1od_vacation_value", "unpaid_vacations"],
            },
          ]
        : [{ stepKey: "p2_vacation", columns: ["unpaid_vacations"] }];
    case "loan":
      return settledInPart1
        ? [{ stepKey: "p1_other_deductions", columns: ["p1od_loan_days", "p1od_loan_value"] }]
        : [{ stepKey: "p2_manual_deductions", columns: ["manual_other_deductions"] }];
    // no_records_activity is retired, but historical rows remain valid payroll history and its
    // salary column was always the Other one.
    case "no_records_activity":
    case "other":
      return settledInPart1
        ? [{ stepKey: "p1_other_deductions", columns: ["p1od_other_days", "p1od_other_value"] }]
        : [{ stepKey: "p2_manual_deductions", columns: ["manual_other_deductions"] }];
  }
}

/**
 * Whether a run may be re-opened.
 *
 * A run whose Part 2 is already confirmed is deliberately left alone, exactly as expense-resync
 * leaves it: confirming Part 2 settles the carry-forward ledger, and silently rewinding that from a
 * push would undo money decisions nobody asked to undo. Reported as a skip so the caller can say so
 * out loud rather than imply a resync happened.
 */
export function planDeductionResync(
  run: { part2ConfirmedAt?: string | null } | null,
): { ok: boolean; reason?: DeductionResyncSkipReason } {
  if (!run) return { ok: false, reason: "no_active_run" };
  if (run.part2ConfirmedAt) return { ok: false, reason: "part2_already_confirmed" };
  return { ok: true };
}

/** `YYYY-MM` → the run lookup's month/year. Returns null for anything else. */
function periodFromMonthKey(monthKey: string): { month: number; year: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec((monthKey ?? "").trim());
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { month, year };
}

/**
 * Clear the frozen figures and re-open the steps a pushed/withdrawn deduction feeds.
 *
 * Reads each employee's own `settled_in_part1` off the run's draft row — the run's own answer to
 * which side of the split they are on, which is what `isSettledInPart1` itself prefers. An employee
 * with no draft row has nothing frozen and nothing to clear, so they drop out silently.
 */
export async function resyncPayrollDeductionSteps(
  target: DeductionResyncTarget,
): Promise<DeductionResyncOutcome> {
  const monthKey = target.monthKey;
  if (target.employees.length === 0) {
    return { action: "skip", monthKey, reason: "no_active_run" };
  }
  const period = periodFromMonthKey(monthKey);
  if (!period) return { action: "skip", monthKey, reason: "no_active_run" };

  try {
    const run = await findActiveRun(period.month, period.year);
    const plan = planDeductionResync(run);
    if (!plan.ok || !run) {
      const reason = plan.reason ?? "no_active_run";
      // A skip because Part 2 is already confirmed leaves payroll paying a figure the module has
      // since moved, until someone reopens Part 2. No open run for the month is ordinary and stays
      // quiet — the same distinction expense-resync draws.
      if (reason === "part2_already_confirmed" && run) {
        logError(
          "Automated payroll: a deduction decision changed after Part 2 was confirmed and did not reach payroll",
          {
            labels: {
              event: "automated_payroll_deduction_resync_skipped_part2_confirmed",
              runId: run.id,
              monthKey,
              employees: target.employees.length,
              hrIds: target.employees.map((employee) => employee.hrIdCompact).join(","),
            },
          },
        );
      }
      return { action: "skip", monthKey, reason };
    }

    const states = await listStepStates(run.id);
    const confirmed = new Set(
      states.filter((state) => state.status === "confirmed").map((state) => state.stepKey),
    );

    // step -> the compact ids to clear on it, and the columns to clear.
    const byStep = new Map<StepKey, { columns: Set<string>; compacts: Set<string> }>();
    const settledByCompact = await loadSettledInPart1(run.id, target.employees.map((e) => e.hrIdCompact));

    for (const employee of target.employees) {
      const settled = settledByCompact.get(employee.hrIdCompact) ?? false;
      for (const category of employee.categories) {
        for (const destination of payrollStepsForCategory(category, settled)) {
          const entry = byStep.get(destination.stepKey) ?? { columns: new Set(), compacts: new Set() };
          for (const column of destination.columns) entry.columns.add(column);
          entry.compacts.add(employee.hrIdCompact);
          byStep.set(destination.stepKey, entry);
        }
      }
    }

    const clearedHrIds = new Set<string>();
    const keptSavedHrIds = new Set<string>();
    const reopenedSteps: StepKey[] = [];
    for (const [stepKey, entry] of byStep) {
      const compacts = Array.from(entry.compacts);
      const columns = Array.from(entry.columns);
      if (!confirmed.has(stepKey)) {
        // An UNconfirmed step is NOT necessarily live: Save without Confirm writes every row's shown
        // figure onto the draft, and recommend.ts prefers a saved draft value over the module. A save
        // made before the decision changed (September 2026: two bulk saves of p2_manual_deductions on
        // 6 Oct held 0.00 over 8,405.17 EGP of approved "other" lines) would keep charging the old
        // figure. Clear it — unless the cell history shows a PERSON saved it, which is kept and
        // reported. No step_state is written: the step was never confirmed.
        const latest = await listLatestCellWrites(run.id, compacts, columns);
        const personSaved = (compact: string) =>
          columns.some((column) => {
            const write = latest.get(`${compact}|${column}`);
            return write ? isTypedByHand(write) : false;
          });
        const clearable = compacts.filter((compact) => !personSaved(compact));
        for (const compact of compacts) if (personSaved(compact)) keptSavedHrIds.add(compact);
        if (clearable.length > 0) {
          for (const hrId of await clearDraftColumns(run.id, clearable, columns)) clearedHrIds.add(hrId);
        }
        continue;
      }
      const cleared = await clearDraftColumns(run.id, compacts, columns);
      for (const hrId of cleared) clearedHrIds.add(hrId);
      await upsertStepState({
        runId: run.id,
        stepKey,
        status: "pending",
        confirmedAt: null,
        confirmedBy: null,
      });
      reopenedSteps.push(stepKey);
    }

    return {
      action: "resync",
      monthKey,
      runId: run.id,
      clearedHrIds: Array.from(clearedHrIds),
      reopenedSteps,
      keptSavedHrIds: Array.from(keptSavedHrIds),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logError("Automated payroll: deduction step resync failed", {
      labels: { event: "automated_payroll_deduction_resync_failed", monthKey },
      error,
    });
    return { action: "failed", monthKey, message };
  }
}

/**
 * Each employee's own `settled_in_part1` on this run, keyed by compact HR id.
 *
 * The RUN's answer, not a fresh derivation — `isSettledInPart1` itself prefers the stored flag over
 * recomputing from payment mode and lifecycle, so re-deriving here could route a clear to the other
 * side of the split from the one the step actually wrote. An employee with no row defaults to false
 * (Part 2), which is the harmless direction: a Part 2 step this month is still unconfirmed far more
 * often than a Part 1 one, so the worst case is a clear that finds nothing frozen.
 */
async function loadSettledInPart1(runId: string, compacts: string[]): Promise<Map<string, boolean>> {
  const rows = await listDraftRows(runId);
  const wanted = new Set(compacts);
  const map = new Map<string, boolean>();
  for (const row of rows) {
    const compact = row.employeeHrIdCompact || (row.employeeHrId ?? "").toLowerCase().replace(/-/g, "");
    if (!wanted.has(compact)) continue;
    map.set(compact, row.settledInPart1 === true);
  }
  return map;
}

/**
 * Plain-language lines for every outcome where a decision did NOT reach payroll, for the decision
 * response. Without them the Deductions page reads "Approved" while payroll goes on paying the old
 * figure. No open run for the month says nothing: that is normal.
 */
export function describeDeductionResyncNotApplied(outcome: DeductionResyncOutcome): string[] {
  const period = periodFromMonthKey(outcome.monthKey);
  const month = period ? monthNameAndYear(period.month, period.year) : outcome.monthKey;
  if (outcome.action === "skip" && outcome.reason === "part2_already_confirmed") {
    return [
      `Payroll for ${month} already has Part 2 confirmed, so this deduction did not reach it. ` +
        "Reopen Part 2 in Automated Payroll for it to apply.",
    ];
  }
  if (outcome.action === "failed") {
    return [`Payroll for ${month} could not be updated with this deduction. The decision itself is saved.`];
  }
  if (outcome.action === "resync" && (outcome.keptSavedHrIds?.length ?? 0) > 0) {
    return [
      `Payroll for ${month} has a figure someone saved by hand for this employee, so it was left as it is ` +
        "and does not include this decision. Change it in Automated Payroll for it to apply.",
    ];
  }
  return [];
}
