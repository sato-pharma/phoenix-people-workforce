/**
 * Verifying a plan — the orchestration, and the one place Phoenix writes into the customer's CRM.
 *
 * THE ORDER OF THESE STEPS IS THE DESIGN. Getting it wrong produces the two failures that matter:
 * a Phoenix board claiming a plan is verified when the CRM never accepted it, or a manager told his
 * click failed after it had already succeeded.
 *
 *   1. Re-read the plan from the mirror. Never trust the browser's idea of its status or its rep.
 *   2. Check the viewer's scope against the plan's OWN rep, read in step 1.
 *   3. Ask `decidePlanVerification` — the pure rule, which refuses a downgrade.
 *   4. Write to the CRM. If this throws, STOP: nothing in Phoenix has changed, and the manager is
 *      told the CRM refused, with the vendor's own words.
 *   5. Only now update the mirror. The CRM is the record; the mirror is a copy of it.
 *   6. Audit, then tell the rep. Both AFTER the write and both non-fatal — see below.
 *
 * Steps 6 cannot fail the operation. By the time they run the customer's CRM has already been
 * changed, so throwing would report a failure for an action that fully succeeded — and a manager
 * who then clicked Verify again would be told the plan is already verified, which reads as the
 * system contradicting itself. Their outcomes come back in the result instead, so the UI can say
 * "verified, but the rep could not be emailed" rather than picking one of the two to hide.
 *
 * WHAT THIS DELIBERATELY CANNOT DO: unverify, reject, or return a plan for editing. The owner
 * dropped reject and return-for-edit when he specified the tab, and "leave pending" is the absence
 * of an action rather than an action of its own. There is no code path here that lowers a status.
 */

import { getIReports360Config } from "@/lib/crm/config";
import { getPlanForVerification } from "@/lib/crm/plan-board";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { iReports360Login, iReports360SetPlanStatus } from "@/lib/crm/client";
import { notifyRepPlanVerified } from "@/lib/crm/plan-notifications";
import { CRM_PLAN_ENTRIES_TABLE } from "@/lib/crm/tables";
import { decidePlanVerification, planStatusLabel } from "@/lib/crm/plan-verification";
import { scopeAllowsAgent, type PlanVerificationScope } from "@/lib/crm/plan-verification-access";
import { writeAuditLog } from "@/lib/admin/audit";

/**
 * The verifying manager's real name.
 *
 * The route only holds a login id and an hr id, and both are raw codes — the owner's standing rule
 * is that a screen (and an email) never shows one. This is the rep's notification saying "Ahmed
 * verified your plan" rather than "AAA-0012 verified your plan". Falls back to whatever identifier
 * exists rather than to an empty string, so the sentence always names somebody.
 */
async function resolveActorName(hrId: string | null, fallback: string | null): Promise<string | null> {
  if (!hrId?.trim()) return fallback;
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("full_name")
    .eq("hr_id", hrId)
    .limit(1);
  if (error) return fallback;
  const name = ((data ?? [])[0] as { full_name: string | null } | undefined)?.full_name?.trim();
  return name || fallback;
}

export type VerifyPlanOutcome =
  | {
      ok: true;
      /** The status now stored in the CRM and mirrored in Phoenix. */
      status: number;
      statusLabel: string;
      /** False when the CRM write succeeded but the rep could not be told. Never a failure. */
      repNotified: boolean;
      repNotifyReason: string | null;
    }
  | { ok: false; reason: string; status: number };

/**
 * Verifies one plan.
 *
 * `actor` carries the viewer's identity for the audit row and the "verified by" line in the rep's
 * notification. `scope` must be the scope resolved from the live AccessContext — passing a wider
 * one is how a manager verifies another district's plan.
 */
export async function verifyPlan(input: {
  actorHrId: string | null;
  actorLoginId: string | null;
  actorName: string | null;
  crmPlanId: number;
  scope: PlanVerificationScope;
}): Promise<VerifyPlanOutcome> {
  if (!Number.isInteger(input.crmPlanId) || input.crmPlanId <= 0) {
    return { ok: false, reason: "That is not a valid plan id.", status: 400 };
  }

  // 1. Fresh read. A board rendered ten minutes ago is not evidence about either the status or the
  //    rep, and both decisions below depend on them being current.
  const plan = await getPlanForVerification(input.crmPlanId);
  if (!plan) {
    return { ok: false, reason: "That plan is not in Phoenix's mirror.", status: 404 };
  }

  // 2. Scope, against the plan's own rep. A plan outside the viewer's reach answers 404 rather than
  //    403: a manager should not be able to learn that another district's plan exists by probing
  //    ids, and "not found" is the honest answer to "is this one of mine?".
  if (!scopeAllowsAgent(input.scope, plan.agentHrId)) {
    return { ok: false, reason: "That plan is not in Phoenix's mirror.", status: 404 };
  }

  // 3. The pure rule. Refuses an already-verified plan and, critically, refuses to lower a plan an
  //    area manager has signed.
  const decision = decidePlanVerification({ currentStatus: plan.status });
  if (!decision.allowed) {
    return { ok: false, reason: decision.reason, status: 409 };
  }

  // 4. The CRM write. Anything other than success stops the operation here, with nothing in Phoenix
  //    changed and the vendor's own message passed through.
  const config = getIReports360Config();
  const token = await iReports360Login(config);
  await iReports360SetPlanStatus(config, token, {
    kind: plan.kind,
    planId: input.crmPlanId,
    status: decision.nextStatus,
  });

  // 5. The mirror follows the CRM, never leads it. Every entry of the plan carries the header's
  //    status, so all of them move together — a partially stamped plan would render as a plan with
  //    no single status, which is a shape this feature has measured never to occur.
  const { error } = await getSupabaseAdmin()
    .from(CRM_PLAN_ENTRIES_TABLE)
    .update({ plan_status: decision.nextStatus, updated_at: new Date().toISOString() })
    .eq("crm_plan_id", input.crmPlanId);
  if (error) {
    // The CRM IS updated at this point. Reporting a plain failure would be a lie in the other
    // direction, so this says exactly what happened and what will fix it — the next plan sync
    // re-reads the status from the CRM and the mirror catches up on its own.
    return {
      ok: false,
      reason: `The CRM accepted the verification, but Phoenix could not update its own copy (${error.message}). The next plan refresh will correct it.`,
      status: 502,
    };
  }

  const actorName = await resolveActorName(input.actorHrId, input.actorName ?? input.actorLoginId ?? null);

  // 6a. Audit. Non-fatal on purpose: the customer's CRM has already been changed, so a failed audit
  //     row must not turn a completed action into a reported failure.
  await writeAuditLog({
    actorLoginId: input.actorLoginId ?? null,
    entityId: String(input.crmPlanId),
    entityType: "crm_plan_verification",
    newValues: { planStatus: decision.nextStatus },
    oldValues: { planStatus: plan.status },
    summary:
      `${actorName || "A manager"} verified ${plan.kind} plan ` +
      `${input.crmPlanId} (CRM account ${plan.agentCrmId}): ` +
      `${planStatusLabel(plan.status)} -> ${planStatusLabel(decision.nextStatus)}`,
  }).catch(() => undefined);

  // 6b. Tell the rep. Also non-fatal, and its outcome is returned rather than swallowed.
  const notified = await notifyRepPlanVerified({
    crmPlanId: input.crmPlanId,
    firstDate: plan.firstDate,
    kind: plan.kind,
    lastDate: plan.lastDate,
    month: plan.month,
    repHrId: plan.agentHrId,
    status: decision.nextStatus,
    verifiedByHrId: input.actorHrId,
    verifiedByName: actorName,
    year: plan.year,
  });

  return {
    ok: true,
    repNotified: notified.sent,
    repNotifyReason: notified.reason,
    status: decision.nextStatus,
    statusLabel: planStatusLabel(decision.nextStatus),
  };
}
