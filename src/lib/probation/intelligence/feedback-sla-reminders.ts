// Probation feedback SLA reminders + escalation (Phase 4, P4-T07).
//
// A STATE-BASED sweep, not a daily blast: for each open feedback task we compute the SLA state
// (due / escalated / overdue) and emit at most ONE notification per (DV-Day, state) via the
// outbox idempotency key. Re-running the sweep never re-sends the same state — only a new state
// transition produces a new notification. This is what stops the "uncontrolled repeated emails"
// the audit called out.

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

function statePriority(state: FeedbackSlaState): "high" | "critical" {
  return state === "overdue" ? "critical" : "high";
}

async function emitForTask(
  task: FeedbackTask,
  hrApproverHrIds: string[],
): Promise<number> {
  const state = task.sla.state as FeedbackSlaState;
  if (!ACTIONABLE_STATES.includes(state)) return 0;

  // Recipients: the evaluator always; HR added once the task escalates/overdue.
  const recipients = new Set<string>();
  const evaluator = normalizeHrId(task.evaluatorHrId);
  if (evaluator) recipients.add(evaluator);
  if (state === "escalated" || state === "overdue") {
    for (const hr of hrApproverHrIds) recipients.add(hr);
  }
  if (recipients.size === 0) return 0;

  const title =
    state === "overdue"
      ? "Probation feedback OVERDUE"
      : state === "escalated"
        ? "Probation feedback escalation"
        : "Probation feedback due";
  const message = `Probation feedback for ${task.employeeHrId} (DV day ${task.dvDate}) is ${state}.`;

  let emitted = 0;
  for (const recipientHrId of recipients) {
    await createSystemNotification({
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
      email: {
        notificationType: "probation",
        subject: title,
        summary: message,
        title,
        tone: state === "overdue" ? "danger" : "warning",
        metrics: [
          { label: "Employee", value: task.employeeHrId },
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
    }).catch(() => undefined);
    emitted += 1;
  }
  return emitted;
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

  const hrApproverHrIds = await resolveHrApproverHrIds();
  let due = 0, escalated = 0, overdue = 0, notificationsEmitted = 0;

  for (const task of withSla) {
    const state = task.sla.state;
    if (state === "due") due += 1;
    else if (state === "escalated") escalated += 1;
    else if (state === "overdue") overdue += 1;
    notificationsEmitted += await emitForTask(task, hrApproverHrIds);
  }

  return { scanned: withSla.length, due, escalated, overdue, notificationsEmitted };
}
