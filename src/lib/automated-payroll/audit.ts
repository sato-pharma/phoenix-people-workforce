import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { StepKey } from "./types.ts";

/**
 * Append an Automated Payroll audit row (accuracy booster). Best-effort: an audit
 * write must never block or undo a payroll action, so failures are logged, not
 * thrown.
 */
export async function writeAutomatedPayrollAudit(input: {
  runId: string;
  actorHrId: string;
  action: string;
  stepKey?: StepKey | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin().from("automated_payroll_audit").insert({
      run_id: input.runId,
      actor_hr_id: input.actorHrId,
      action: input.action,
      step_key: input.stepKey ?? null,
      detail: input.detail ?? {},
    });
    if (error) {
      console.error("[automated-payroll:audit] insert failed:", error.message);
    }
  } catch (error) {
    console.error("[automated-payroll:audit] insert threw:", error);
  }
}
