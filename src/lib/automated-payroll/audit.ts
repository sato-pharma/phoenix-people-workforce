import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { StepKey } from "./types.ts";

type AuditClient = Pick<ReturnType<typeof getSupabaseAdmin>, "from">;

/**
 * Append an Automated Payroll audit row (accuracy booster). Best-effort: an audit
 * write must never block or undo a payroll action, so failures are logged, not
 * thrown.
 *
 * `client` is passed only by a caller that was itself handed one — a test's fake. Without it, a
 * test that injected a fake into the caller still sent this one row to the real database, and a
 * local run of the suite loads `.env.local`, which is production. Resolved inside the `try` so that
 * a missing credential is still logged rather than thrown.
 */
export async function writeAutomatedPayrollAudit(input: {
  runId: string;
  actorHrId: string;
  action: string;
  stepKey?: StepKey | null;
  detail?: Record<string, unknown>;
}, client?: AuditClient): Promise<void> {
  try {
    const writer = client ?? getSupabaseAdmin();
    const { error } = await writer.from("automated_payroll_audit").insert({
      run_id: input.runId,
      actor_hr_id: input.actorHrId,
      action: input.action,
      step_key: input.stepKey ?? null,
      detail: input.detail ?? {},
    });
    if (error) {
      logError("Automated payroll: audit log insert failed", {
        labels: {
          event: "automated_payroll_audit_insert_failed",
          runId: input.runId,
          action: input.action,
        },
        error,
      });
    }
  } catch (error) {
    logError("Automated payroll: audit log insert threw an exception", {
      labels: {
        event: "automated_payroll_audit_insert_threw",
        runId: input.runId,
        action: input.action,
      },
      error,
    });
  }
}
