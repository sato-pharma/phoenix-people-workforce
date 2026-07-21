import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { createRecurringAdjustment } from "./recurring.ts";
import type { CopilotPeriod, ProposedAction } from "./types.ts";

/**
 * Deterministic application of confirmed actions.
 *
 * The LLM proposes ProposedAction[]; this module persists each as an audited
 * payroll_copilot_adjustments row (and, for a loan, creates the recurring
 * schedule). It performs NO salary arithmetic itself — assemble.ts folds these
 * adjustments into the draft using the locked policy. Flags for touched
 * employees are marked answered.
 */
export async function applyActions(input: {
  runId: string;
  period: CopilotPeriod;
  actions: ProposedAction[];
  actor: string | null;
}): Promise<number> {
  const supabase = getSupabaseAdmin();
  let applied = 0;

  for (const action of input.actions) {
    let recurringId: string | null = null;
    let amount: number | null = null;
    let field: string | null = null;
    let workedDays: number | null = null;
    const reason = "reason" in action && action.reason ? action.reason : null;

    if (action.kind === "loan") {
      recurringId = await createRecurringAdjustment({
        employeeHrId: action.hrId,
        kind: "loan",
        monthlyAmount: action.monthlyAmount,
        installments: action.installments,
        startMonth: input.period.month,
        startYear: input.period.year,
        createdBy: input.actor,
        note: action.reason,
      });
      amount = action.monthlyAmount;
    } else if (action.kind === "bonus" || action.kind === "penalty" || action.kind === "advance") {
      amount = action.amount;
    } else if (action.kind === "override") {
      amount = action.value;
      field = action.field;
    } else if (action.kind === "prorate") {
      workedDays = action.workedDays;
    }

    try {
      const { error } = await supabase.from("payroll_copilot_adjustments").insert({
        run_id: input.runId,
        employee_hr_id: action.hrId,
        kind: action.kind,
        amount,
        field,
        worked_days: workedDays,
        reason,
        recurring_id: recurringId,
        source: "chat",
        created_by: input.actor,
      });
      if (error) {
        logError("Failed to insert payroll copilot adjustment", {
          labels: { event: "negotiation_adjustment_insert_failed", runId: input.runId, hrId: action.hrId, kind: action.kind },
          error,
        });
        continue;
      }
      applied += 1;
    } catch (error) {
      logError("Inserting payroll copilot adjustment threw an exception", {
        labels: { event: "negotiation_adjustment_insert_threw", runId: input.runId, hrId: action.hrId, kind: action.kind },
        error,
      });
    }
  }

  const touched = Array.from(new Set(input.actions.map((action) => action.hrId)));
  if (touched.length > 0) {
    try {
      await supabase
        .from("payroll_copilot_flags")
        .update({ status: "answered", updated_at: new Date().toISOString() })
        .eq("run_id", input.runId)
        .in("employee_hr_id", touched);
    } catch (error) {
      logError("Payroll copilot flag status update threw an exception", {
        labels: { event: "negotiation_flag_update_threw", runId: input.runId },
        error,
      });
    }
  }

  return applied;
}
