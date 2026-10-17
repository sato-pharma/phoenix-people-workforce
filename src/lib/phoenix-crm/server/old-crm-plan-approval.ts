/**
 * Phoenix CRM — approving the week of a rep who still works in the OLD CRM (owner, 2026-10-17: "make sure
 * the district manager can validate the reps' plans — Phoenix CRM and the old CRM"; he chose "approve
 * the rep's weekly plan").
 *
 * A Phoenix rep's week is approved on the Team tab (`transitionPlan`). A rep who has not moved has no
 * Phoenix week; his plan is the one he filed in iReports360, and the one write Phoenix makes into that
 * system is the vendor's own supervisor approval (`crm/plan-verification-service.ts`, status 0 → 1). This
 * puts that same write on the Team tab, so the district manager approves every rep's week from one screen
 * and the admin Plan Verification board and this one can never disagree: the rule is `decidePlanVerification`
 * on both, the reach is `getPlanVerificationScope` on both, and the write is `setPlanVerification` on both.
 *
 * What it adds is only the Phoenix framing: "Approve" and "Take back approval" (the vendor has no "return"
 * and no note, so a return is not offered here), and the same refusals a Phoenix week gives — the Super
 * Admin decides nothing, a test account has no old-CRM plan, and the CEO stays observational because the
 * matrix gives him `crm_plans:read` and not `approve`.
 */

import { assertPermission, canAccess } from "@/lib/auth/permissions";
import { isIReports360Configured } from "@/lib/crm/config";
import { IReports360ApiError } from "@/lib/crm/client";
import { resolveVendorSyncStandDown, VENDOR_SYNC_RETIRED_MESSAGE } from "@/lib/crm/cutover";
import { getAgentsWeekPlanEntries } from "@/lib/crm/plan-board";
import { canAccessPlanVerification, getPlanVerificationScope, scopeAllowsAgent } from "@/lib/crm/plan-verification-access";
import { setPlanVerification } from "@/lib/crm/plan-verification-service";
import { addDaysIso } from "@/lib/crm/dates";
import { ApiError, conflictError, forbiddenError, validationError } from "@/lib/http/api-errors";
import { logWarning } from "@/lib/observability/log";
import {
  isOldCrmPlanAction,
  oldCrmActionToVerification,
  oldCrmApprovalOptions,
  oldCrmPlanOf,
  oldCrmStatusLabel,
  OLD_CRM_CATCH_ALL_CONTACT,
} from "@/lib/phoenix-crm/old-crm-plan-rules";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import type { OldCrmRep } from "@/lib/phoenix-crm/server/manager-old-crm-weeks";

/** A rep's old-CRM week as a reviewer sees it on the Team tab. */
export type OldCrmReviewPlan = {
  crmPlanId: number;
  status: number | null;
  statusLabel: string;
  /** Distinct customers on the plan, and the days they are spread over. */
  customers: number;
  days: number;
  canApprove: boolean;
  canTakeBack: boolean;
};

/** Whether this viewer may press Approve at all, before the plan or the rep is looked at. */
async function mayDecideOldCrmPlans(viewer: PhoenixCrmViewer): Promise<boolean> {
  // The Super Admin decides nothing in Phoenix CRM (access.ts), a test account holds no vendor plan, and
  // the role list and the matrix are the admin board's own two gates.
  if (viewer.isSuperAdmin || viewer.isTestPersona) return false;
  if (!canAccessPlanVerification(viewer.access)) return false;
  if (!(await canAccess(viewer.access, "crm_plans", "approve"))) return false;
  if (!isIReports360Configured()) return false;
  return (await resolveVendorSyncStandDown()) === null;
}

/**
 * The old-CRM week of each of these reps, keyed by seat — only reps who filed one that week. A failed read
 * answers nothing and is logged: the Team tab opens as it did before, and the rep reads "Not started".
 */
export async function loadOldCrmReviewPlans(
  viewer: PhoenixCrmViewer,
  reps: ReadonlyArray<OldCrmRep>,
  weekStart: string,
  isTest: boolean,
): Promise<Map<string, OldCrmReviewPlan>> {
  const found = new Map<string, OldCrmReviewPlan>();
  if (isTest || viewer.isTestPersona || reps.length === 0) return found;
  try {
    const seatOfHr = new Map(reps.map((rep) => [rep.hrId.trim().toLowerCase(), rep.seatId]));
    const entries = await getAgentsWeekPlanEntries(
      reps.map((rep) => rep.hrId),
      weekStart,
      addDaysIso(weekStart, 5),
    );
    if (!entries || entries.length === 0) return found;
    const bySeat = new Map<string, typeof entries>();
    for (const entry of entries) {
      const seatId = seatOfHr.get(entry.agentHrId.trim().toLowerCase());
      if (!seatId || entry.contactCrmId === OLD_CRM_CATCH_ALL_CONTACT) continue;
      const list = bySeat.get(seatId) ?? [];
      list.push(entry);
      bySeat.set(seatId, list);
    }
    if (bySeat.size === 0) return found;

    const may = await mayDecideOldCrmPlans(viewer);
    const scope = may ? await getPlanVerificationScope(viewer.access) : null;
    const hrOfSeat = new Map(reps.map((rep) => [rep.seatId, rep.hrId]));
    for (const [seatId, list] of bySeat) {
      const plan = oldCrmPlanOf(list);
      if (!plan) continue;
      const options = oldCrmApprovalOptions(plan.status);
      const inReach = scope !== null && scopeAllowsAgent(scope, hrOfSeat.get(seatId) ?? null);
      found.set(seatId, {
        crmPlanId: plan.crmPlanId,
        status: plan.status,
        statusLabel: oldCrmStatusLabel(plan.status),
        customers: new Set(plan.entries.map((entry) => entry.contactCrmId)).size,
        days: new Set(plan.entries.map((entry) => entry.planDate)).size,
        canApprove: inReach && options.canApprove,
        canTakeBack: inReach && options.canTakeBack,
      });
    }
  } catch (error) {
    logWarning("Phoenix CRM could not read the old CRM plans for the Team tab", {
      error,
      labels: { event: "phoenix_crm_old_crm_review_unreadable" },
    });
    return new Map();
  }
  return found;
}

export type OldCrmDecisionResult = { crmPlanId: number; action: "approve" | "take_back"; status: number; statusLabel: string; repNotified: boolean };

/**
 * POST: approve a rep's old-CRM week, or take that approval back. The same three gates as the admin
 * board's route (role list, the `crm_plans:approve` matrix grant, the viewer's reach against the plan's own
 * rep, read fresh inside `setPlanVerification`), plus the Phoenix refusals above.
 */
export async function decideOldCrmPlan(viewer: PhoenixCrmViewer, raw: unknown): Promise<OldCrmDecisionResult> {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (!isOldCrmPlanAction(body.action)) throw validationError("Reload the page and try again.");
  const action = body.action;
  const crmPlanId = Number(body.crmPlanId);
  if (!Number.isInteger(crmPlanId) || crmPlanId <= 0) throw validationError("Reload the page and try again.");

  if (viewer.isSuperAdmin) {
    throw forbiddenError("A decision belongs to the rep's own manager chain. The Super Admin does not approve a rep's week.");
  }
  if (viewer.isTestPersona) throw forbiddenError("A test login has no plan in the old CRM.");
  if (!canAccessPlanVerification(viewer.access)) throw forbiddenError("Approving a plan in the old CRM is not available to your role.");
  await assertPermission(viewer.access, "crm_plans", "approve");
  if (await resolveVendorSyncStandDown()) throw conflictError(VENDOR_SYNC_RETIRED_MESSAGE);
  if (!isIReports360Configured()) {
    throw new ApiError(503, "old_crm_not_configured", "The old CRM connection is not set up in this environment.");
  }

  const scope = await getPlanVerificationScope(viewer.access);
  try {
    const outcome = await setPlanVerification({
      action: oldCrmActionToVerification(action),
      actorHrId: viewer.hrId,
      actorLoginId: viewer.access.loginId ?? viewer.hrId,
      actorName: viewer.access.loginId ?? viewer.hrId,
      crmPlanId,
      scope,
    });
    if (!outcome.ok) throw new ApiError(outcome.status, "old_crm_plan_refused", outcome.reason);
    return { crmPlanId, action, status: outcome.status, statusLabel: oldCrmStatusLabel(outcome.status), repNotified: outcome.repNotified };
  } catch (error) {
    // The vendor's own sentence ("Weekly plan not found.") is the actionable one, and it means the write
    // did not happen.
    // Its status is the vendor's, not Phoenix's: a vendor 401 must not read as the manager being signed out.
    if (error instanceof IReports360ApiError) throw new ApiError(error.status === 404 ? 404 : 502, "old_crm_refused", error.message);
    throw error;
  }
}
