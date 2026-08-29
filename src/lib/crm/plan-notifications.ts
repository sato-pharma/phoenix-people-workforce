/**
 * The two notifications the owner asked for on the Plans tab, 2026-08-28:
 *
 *   1. a rep's plan arrives unverified  ->  tell that rep's district manager;
 *   2. the district manager verifies it ->  tell the medical rep.
 *
 * ## Channels: in-app and email, deliberately not more
 *
 * He asked for emails. In-app costs nothing and puts the same sentence in the product where the
 * manager already works, so both go out on `["in_app", "email"]`. Telegram and push are NOT wired,
 * because he did not ask for them and this repo's own governance would have made adding them a
 * silent no-op anyway: `module: "crm"` appears in neither `notifications/policy.ts` nor
 * `telegram-governance.ts`, and `defaultTelegramPolicyFor` fails closed for an unregistered module.
 * A channel that reports "sent" and delivers nothing is worse than one that was never offered.
 *
 * The `category` is `"general"`, which is already on `PERSONAL_BELL_CATEGORIES`. That list is a
 * read-path allowlist: a category missing from it makes the delivery audit say `in_app: sent` while
 * the recipient's bell stays empty — the one failure mode monitoring cannot catch.
 *
 * ## Why "a plan arrived" is not simply "every pending plan"
 *
 * Notification 1 fires only for plans this sync run saw for the FIRST time. The tempting shortcut —
 * announce every plan currently sitting at status 0 and let the idempotency key stop the repeats —
 * is a bulk-mail incident on its first execution: production holds 204 pending weekly plans going
 * back to January, and the first run after deploy would have emailed a manager for every one of
 * them. The owner's standing rule is never to fire bulk email. So the caller passes the plan ids it
 * actually inserted, `NEW_PLAN_ANNOUNCE_LIMIT` caps a single run, and a run over the cap announces
 * NOTHING and says so rather than picking an arbitrary subset.
 */

import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { planStatusLabel, type PlanKind } from "@/lib/crm/plan-verification";

/**
 * The most new plans one sync run will announce.
 *
 * A normal week brings a handful. Anything above this is a backfill, a first run, or a vendor
 * resending history — none of which a manager should learn about by inbox. The run reports the
 * number it withheld so the event is visible without being delivered.
 */
export const NEW_PLAN_ANNOUNCE_LIMIT = 25;

type EmployeeRow = {
  full_name: string | null;
  hr_id: string;
  manager_hr_id: string | null;
  work_email: string | null;
};

async function readEmployees(hrIds: readonly string[]): Promise<Map<string, EmployeeRow>> {
  const byHrId = new Map<string, EmployeeRow>();
  const unique = [...new Set(hrIds.filter((id) => id?.trim()))];
  // Chunked: a long `.in()` travels in the URL and comes back empty with no error.
  for (let from = 0; from < unique.length; from += 50) {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id, full_name, manager_hr_id, work_email")
      .in("hr_id", unique.slice(from, from + 50));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as EmployeeRow[]) byHrId.set(row.hr_id, row);
  }
  return byHrId;
}

/** How a plan's period reads to a human. Weekly plans have dates; monthly plans have a month. */
export function planPeriodLabel(input: {
  firstDate?: string | null;
  kind: PlanKind;
  lastDate?: string | null;
  month?: number | null;
  year?: number | null;
}): string {
  if (input.kind === "monthly") {
    if (input.month && input.year) {
      const name = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC", year: "numeric" }).format(
        new Date(Date.UTC(input.year, input.month - 1, 1)),
      );
      return name;
    }
    return "an unrecorded month";
  }
  if (input.firstDate && input.lastDate) {
    if (input.firstDate === input.lastDate) return input.firstDate;
    return `${input.firstDate} to ${input.lastDate}`;
  }
  return input.firstDate ?? input.lastDate ?? "an unrecorded week";
}

export type NewPlanAnnouncement = {
  crmPlanId: number;
  firstDate?: string | null;
  kind: PlanKind;
  lastDate?: string | null;
  month?: number | null;
  repHrId: string | null;
  year?: number | null;
};

export type AnnounceResult = {
  /** Plans a manager was told about. */
  announced: number;
  /** Plans skipped, with the reason, so a silent no-send is never mistaken for a quiet week. */
  skipped: Array<{ crmPlanId: number; reason: string }>;
  /** Set when the whole run was withheld by the bulk guard. */
  withheldReason: string | null;
};

/**
 * Notification 1 — tell each rep's manager that a plan is waiting.
 *
 * Best-effort by construction: a notification failure must never fail a sync, because the sync's
 * real job is the mirror and a half-written mirror is a data problem while an unsent email is an
 * inconvenience. Every skip is counted and returned.
 */
export async function announceNewPlansToManagers(plans: readonly NewPlanAnnouncement[]): Promise<AnnounceResult> {
  const result: AnnounceResult = { announced: 0, skipped: [], withheldReason: null };
  if (plans.length === 0) return result;

  if (plans.length > NEW_PLAN_ANNOUNCE_LIMIT) {
    result.withheldReason = `${plans.length} new plans in one run is over the ${NEW_PLAN_ANNOUNCE_LIMIT}-plan ceiling — treated as a backfill and not announced.`;
    return result;
  }

  const repHrIds = plans.map((plan) => plan.repHrId).filter((id): id is string => Boolean(id));
  let employees: Map<string, EmployeeRow>;
  try {
    employees = await readEmployees(repHrIds);
  } catch (error) {
    result.withheldReason = `Could not read the roster to find managers: ${error instanceof Error ? error.message : "unknown error"}.`;
    return result;
  }
  const managerHrIds = [...employees.values()].map((row) => row.manager_hr_id).filter((id): id is string => Boolean(id));
  const managers = managerHrIds.length ? await readEmployees(managerHrIds).catch(() => new Map<string, EmployeeRow>()) : new Map<string, EmployeeRow>();

  for (const plan of plans) {
    if (!plan.repHrId) {
      result.skipped.push({ crmPlanId: plan.crmPlanId, reason: "the plan's CRM account is not linked to an employee" });
      continue;
    }
    const rep = employees.get(plan.repHrId);
    if (!rep) {
      result.skipped.push({ crmPlanId: plan.crmPlanId, reason: "the rep is not on the roster" });
      continue;
    }
    if (!rep.manager_hr_id) {
      result.skipped.push({ crmPlanId: plan.crmPlanId, reason: `${rep.full_name ?? plan.repHrId} has no manager recorded` });
      continue;
    }
    const manager = managers.get(rep.manager_hr_id);
    const period = planPeriodLabel(plan);
    const repName = rep.full_name?.trim() || plan.repHrId;
    const actionUrl = `/admin/plan-verification?plan=${plan.crmPlanId}`;
    try {
      await createSystemNotification({
        actionUrl,
        category: "general",
        channels: ["in_app", "email"],
        email: {
          ctaHref: actionUrl,
          ctaLabel: "Open the plan",
          employeeHrId: rep.manager_hr_id,
          notificationType: "general",
          ...(manager?.work_email ? { recipients: [manager.work_email] } : {}),
          subject: `${repName}'s ${plan.kind} plan is waiting for you`,
          summary: `${repName} has a ${plan.kind} plan for ${period} that has not been verified yet.`,
        },
        eventType: "plan_awaiting_verification",
        // The idempotency key carries the plan and the manager, so the same plan announced to a
        // replacement manager still reaches them, and a re-run never double-sends to the same one.
        metadata: {
          crmPlanId: plan.crmPlanId,
          idempotencyKey: `crm_plan_awaiting:${plan.crmPlanId}:${rep.manager_hr_id}`,
          planKind: plan.kind,
        },
        message: `${repName} has a ${plan.kind} plan for ${period} waiting to be verified.`,
        module: "crm",
        priority: "normal",
        recipientHrId: rep.manager_hr_id,
        subjectHrId: plan.repHrId,
        title: "A plan is waiting for your verification",
      });
      result.announced += 1;
    } catch (error) {
      result.skipped.push({
        crmPlanId: plan.crmPlanId,
        reason: error instanceof Error ? error.message : "the notification could not be sent",
      });
    }
  }
  return result;
}

/**
 * Notification 2 — tell the rep their plan has been verified.
 *
 * Also best-effort, and for a sharper reason than the first: the CRM has ALREADY been written by
 * the time this runs. Throwing here would report a failure for an action that fully succeeded, and
 * a manager who then clicked Verify again would be told the plan is already verified — which reads
 * as the system contradicting itself. The caller surfaces `emailed: false` instead.
 */
export async function notifyRepPlanVerified(input: {
  crmPlanId: number;
  firstDate?: string | null;
  kind: PlanKind;
  lastDate?: string | null;
  month?: number | null;
  repHrId: string | null;
  status: number;
  verifiedByHrId: string | null;
  verifiedByName: string | null;
  year?: number | null;
}): Promise<{ sent: boolean; reason: string | null }> {
  if (!input.repHrId) {
    return { reason: "the plan's CRM account is not linked to an employee, so there is nobody to tell", sent: false };
  }
  let rep: EmployeeRow | undefined;
  try {
    rep = (await readEmployees([input.repHrId])).get(input.repHrId);
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "the roster could not be read", sent: false };
  }
  if (!rep) return { reason: "the rep is not on the roster", sent: false };

  const period = planPeriodLabel(input);
  const by = input.verifiedByName?.trim() || "your manager";
  const actionUrl = `/admin/plan-verification?plan=${input.crmPlanId}`;
  try {
    await createSystemNotification({
      actionUrl,
      ...(input.verifiedByHrId ? { actorId: input.verifiedByHrId } : {}),
      category: "general",
      channels: ["in_app", "email"],
      email: {
        ctaHref: actionUrl,
        ctaLabel: "Open the plan",
        employeeHrId: input.repHrId,
        notificationType: "general",
        ...(rep.work_email ? { recipients: [rep.work_email] } : {}),
        subject: `Your ${input.kind} plan for ${period} was verified`,
        summary: `${by} verified your ${input.kind} plan for ${period}. It now reads "${planStatusLabel(input.status)}" in the CRM.`,
      },
      eventType: "plan_verified",
      metadata: {
        crmPlanId: input.crmPlanId,
        idempotencyKey: `crm_plan_verified:${input.crmPlanId}:${input.repHrId}`,
        planKind: input.kind,
      },
      message: `${by} verified your ${input.kind} plan for ${period}.`,
      module: "crm",
      priority: "normal",
      recipientHrId: input.repHrId,
      ...(input.verifiedByHrId ? { subjectHrId: input.verifiedByHrId } : {}),
      title: "Your plan was verified",
    });
    return { reason: null, sent: true };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "the notification could not be sent", sent: false };
  }
}
