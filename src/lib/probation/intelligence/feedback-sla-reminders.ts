// Probation feedback SLA reminders + escalation (Phase 4, P4-T07).
//
// A STATE-BASED sweep, not a daily blast: for each open feedback task we compute the SLA state
// (due / escalated / overdue) and emit at most ONE notification per (DV-Day, state) via the
// outbox idempotency key. Re-running the sweep never re-sends the same state — only a new state
// transition produces a new notification. This is what stops the "uncontrolled repeated emails"
// the audit called out.

import { systemDeployment } from "@/config/system-settings";
import { normalizeHrId, systemAccessContext } from "@/lib/auth/permissions";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { isProbationSchemaMissing } from "@/lib/probation/service";

import { getProbationConfig } from "./config";
import { computeFeedbackSla, slaReminderKey, type FeedbackSlaState } from "./feedback-sla";
import { listFeedbackTasks, type FeedbackTask } from "./feedback-workflow";

export type FeedbackSlaSweepResult = {
  scanned: number;
  due: number;
  escalated: number;
  overdue: number;
  notificationsEmitted: number;
};

// Only these states trigger a notification (pending is silent — not yet due).
const ACTIONABLE_STATES: FeedbackSlaState[] = ["due", "escalated", "overdue"];

async function resolveHrApproverHrIds(): Promise<string[]> {
  const { data } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", ["HR Manager", "Super Admin"])
    .eq("is_active", true);
  return ((data ?? []) as Array<{ hr_id?: string | null }>)
    .map((r) => normalizeHrId(r.hr_id))
    .filter(Boolean) as string[];
}

// Bulk-resolve each task's human-readable employee name (never surface a bare HR_ID in a
// notification — see CLAUDE.md "show names not codes"). One IN() query for the whole sweep.
async function resolveEmployeeNames(tasks: FeedbackTask[]): Promise<Map<string, string>> {
  const caseIds = Array.from(new Set(tasks.map((t) => t.caseId).filter((id): id is string => Boolean(id))));
  if (caseIds.length === 0) return new Map();
  const { data } = await getSupabaseAdmin()
    .from("probation_cases")
    .select("id, employee_name")
    .in("id", caseIds);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; employee_name: string | null }>) {
    if (row.employee_name) map.set(row.id, row.employee_name);
  }
  return map;
}

function statePriority(state: FeedbackSlaState): "high" | "critical" {
  return state === "overdue" ? "critical" : "high";
}

async function emitForTask(
  task: FeedbackTask,
  hrApproverHrIds: string[],
  employeeName: string,
): Promise<number> {
  const state = task.sla.state as FeedbackSlaState;
  if (!ACTIONABLE_STATES.includes(state)) return 0;

  // Recipients: the evaluator always (every state — due/escalated/overdue — so they never lose
  // visibility of their own open task). HR/Super Admin are added only once a task is genuinely
  // Overdue, not at the mid-way "escalated" warning — HR was previously CC'd on every escalation
  // company-wide (118 emails to 2 accounts in the first weeks live), which trained recipients to
  // stop opening probation email (owner report, 2026-07-16). Overdue is still the one state that
  // needs HR eyes.
  const recipients = new Set<string>();
  const evaluator = normalizeHrId(task.evaluatorHrId);
  if (evaluator) recipients.add(evaluator);
  if (state === "overdue") {
    for (const hr of hrApproverHrIds) recipients.add(hr);
  }
  if (recipients.size === 0) return 0;

  const stateLabel =
    state === "overdue" ? "OVERDUE" : state === "escalated" ? "escalation" : "due";
  const title = `Probation feedback ${stateLabel} — ${employeeName}`;
  const message = `Probation feedback for ${employeeName} (DV day ${task.dvDate}) is ${state}.`;
  const ctaUrl = task.caseId ? `${systemDeployment.productionUrl}/probation/cases/${task.caseId}` : null;

  // Recipients are independent (each has its own idempotency key, and claimDelivery's atomic
  // upsert-on-conflict makes concurrent claims race-safe) — dispatch in parallel instead of
  // serially. With the cron's per-task fan-out also parallel (see processFeedbackSlaReminders),
  // a serial recipient loop here was part of what made the whole run exceed its 30s step budget
  // (see 2026-07-15/16 notifications cron 504 outage).
  await Promise.all(
    Array.from(recipients).map((recipientHrId) =>
      createSystemNotification({
        actorId: "system",
        module: "probation",
        eventType: "reminder_due",
        title,
        message,
        priority: statePriority(state),
        subjectHrId: task.employeeHrId,
        recipientHrId,
        // Telegram carries the full SLA reminder (E3); delivery still gated by the global switch, bot
        // token, and each recipient's per-user opt-in + connected chat (admin/DB, not code).
        channels: ["in_app", "email", "telegram"],
        actionUrl: ctaUrl,
        email: {
          notificationType: "probation",
          subject: title,
          summary: message,
          title,
          tone: state === "overdue" ? "danger" : "warning",
          ctaHref: ctaUrl ?? undefined,
          ctaLabel: "Open live report",
          metrics: [
            { label: "Employee", value: employeeName },
            { label: "DV date", value: task.dvDate },
            { label: "Status", value: state },
            { label: "Hours overdue", value: String(task.sla.hoursOverdue) },
          ],
        },
        metadata: {
          // Dedup: one notification per (DV-Day, state, recipient). A repeated sweep is a no-op.
          idempotencyKey: `${slaReminderKey(task.dvDayId, state)}:${recipientHrId}`,
          dvDayId: task.dvDayId,
          slaState: state,
        },
      }).catch(() => undefined),
    ),
  );
  return recipients.size;
}

/**
 * Sweep all open feedback tasks and emit due/escalation/overdue notifications (deduped by state).
 * Intended to be called from the notifications processing cron. Read + write (outbox).
 */
export async function processFeedbackSlaReminders(
  nowIso: string = new Date().toISOString(),
): Promise<FeedbackSlaSweepResult> {
  const config = await getProbationConfig();
  // System context: sweep ALL open tasks regardless of any single caller's ownership. Before the
  // domain migrations exist (deploy→migrate window), the tables are absent — skip quietly instead of
  // throwing on every 30-min cron tick.
  let tasks: FeedbackTask[];
  try {
    tasks = await listFeedbackTasks(systemAccessContext, nowIso);
  } catch (error) {
    if (isProbationSchemaMissing(error)) return { scanned: 0, due: 0, escalated: 0, overdue: 0, notificationsEmitted: 0 };
    throw error;
  }
  // Recompute SLA against the same nowIso, anchored at the DV-Day creation time (createdAt) so a
  // late-synced / backfilled DV-Day is not born "overdue" and does not fire a critical escalation the
  // evaluator never had the window to answer.
  const withSla = tasks.map((t) => ({ ...t, sla: computeFeedbackSla(t.dvDate, nowIso, config.sla, t.createdAt) }));

  const [hrApproverHrIds, employeeNames] = await Promise.all([
    resolveHrApproverHrIds(),
    resolveEmployeeNames(withSla),
  ]);
  let due = 0, escalated = 0, overdue = 0;
  for (const task of withSla) {
    const state = task.sla.state;
    if (state === "due") due += 1;
    else if (state === "escalated") escalated += 1;
    else if (state === "overdue") overdue += 1;
  }

  // Tasks are independent (each's notifications key off its own DV-Day id) — fan out in
  // parallel rather than a serial per-task await chain (see emitForTask's comment).
  const emittedPerTask = await Promise.all(
    withSla.map((task) =>
      emitForTask(task, hrApproverHrIds, (task.caseId && employeeNames.get(task.caseId)) || task.employeeHrId),
    ),
  );
  const notificationsEmitted = emittedPerTask.reduce((sum, n) => sum + n, 0);

  return { scanned: withSla.length, due, escalated, overdue, notificationsEmitted };
}
