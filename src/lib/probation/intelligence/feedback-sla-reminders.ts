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
import { createProbationDailyCap, type ProbationDailyCap } from "./notification-cap";
import { isBeforeProbationEmailFreshStart } from "./email-fresh-start";

export type FeedbackSlaSweepResult = {
  scanned: number;
  due: number;
  escalated: number;
  overdue: number;
  notificationsEmitted: number;
};

// Only these states trigger a notification (pending is silent — not yet due).
const ACTIONABLE_STATES: FeedbackSlaState[] = ["due", "escalated", "overdue"];

async function activeHrIdsByRole(roles: string[]): Promise<string[]> {
  const { data } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", roles)
    .eq("is_active", true);
  return ((data ?? []) as Array<{ hr_id?: string | null }>)
    .map((r) => normalizeHrId(r.hr_id))
    .filter(Boolean) as string[];
}

const resolveHrApproverHrIds = () => activeHrIdsByRole(["HR Manager", "Super Admin"]);
const resolveCeoHrIds = () => activeHrIdsByRole(["CEO"]);

// The System Admin CC on the reminder-2 escalation (MOD-2, owner decision 2026-07-17). The synthetic
// "Phoenix System Administrator" account (PHX-1) has no deliverable mailbox — employees.work_email is
// UNIQUE and the intended address omar.anwar@satopharma.com already belongs to B-10 — so the escalation
// is routed to the real system-administrator account B-10 (Omar Anwar, HR Manager + Super Admin), whose
// work_email is that inbox. Resolved defensively by hr_id + is_active so a deactivation drops it rather
// than emailing a dead account. (PHX-1 remains the cap-exempt in-app oversight account, see notification-cap.)
const SYSTEM_ADMIN_CC_HR_ID = "B-10";
async function resolveSystemAdminHrId(): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .eq("hr_id", SYSTEM_ADMIN_CC_HR_ID)
    .eq("is_active", true)
    .maybeSingle();
  return normalizeHrId((data as { hr_id?: string | null } | null)?.hr_id);
}

// Bulk-resolve each case's employee name (never surface a bare HR_ID — CLAUDE.md "show names not
// codes") AND the probationer's Direct Manager (probation_cases.manager_hr_id, the reminder-2 CC).
// One IN() query for the whole sweep.
type CaseInfo = { name: string | null; managerHrId: string | null };
async function resolveCaseInfo(tasks: FeedbackTask[]): Promise<Map<string, CaseInfo>> {
  const caseIds = Array.from(new Set(tasks.map((t) => t.caseId).filter((id): id is string => Boolean(id))));
  if (caseIds.length === 0) return new Map();
  const { data } = await getSupabaseAdmin()
    .from("probation_cases")
    .select("id, employee_name, manager_hr_id")
    .in("id", caseIds);
  const map = new Map<string, CaseInfo>();
  for (const row of (data ?? []) as Array<{ id: string; employee_name: string | null; manager_hr_id: string | null }>) {
    map.set(row.id, { name: row.employee_name, managerHrId: normalizeHrId(row.manager_hr_id) });
  }
  return map;
}

function statePriority(state: FeedbackSlaState): "high" | "critical" {
  return state === "overdue" ? "critical" : "high";
}

// Plain-English content per state (owner feedback, 2026-07-17): the email must say, in the body
// text, WHY the recipient is getting it and WHAT to do — not just restate the internal state word.
// "DV day" (internal shorthand) becomes "Double-Visit day"; the SLA state word never appears
// verbatim in the copy, only as a status label a reader can act on.
const STATE_COPY: Record<"due" | "escalated" | "overdue", { statusLabel: string; headline: string; body: (employeeName: string) => string }> = {
  due: {
    statusLabel: "Feedback needed",
    headline: "Probation feedback needed",
    body: (name) =>
      `A Double-Visit day was completed with ${name}, and their probation record needs your feedback. ` +
      `Please open the report below and submit your assessment.`,
  },
  escalated: {
    statusLabel: "Reminder — still needed",
    headline: "Reminder: probation feedback still needed",
    body: (name) =>
      `Your feedback for ${name}'s Double-Visit day is still outstanding. This is a required part of their 90-day ` +
      `probation record, so please submit your assessment as soon as you can.`,
  },
  overdue: {
    statusLabel: "Overdue",
    headline: "Probation feedback is overdue",
    body: (name) =>
      `Feedback for ${name}'s Double-Visit day is now overdue. If you are the evaluating manager, please submit your ` +
      `assessment now. HR has been copied on this message so the case can be followed up.`,
  },
};

type EscalationParties = {
  hrApproverHrIds: string[];
  ceoHrIds: string[];
  systemAdminHrId: string | null;
  directManagerHrId: string | null;
  cap: ProbationDailyCap;
};

async function emitForTask(
  task: FeedbackTask,
  employeeName: string,
  parties: EscalationParties,
): Promise<number> {
  const state = task.sla.state as FeedbackSlaState;
  if (!ACTIONABLE_STATES.includes(state)) return 0;

  // Recipient escalation ladder (owner-confirmed 2026-07-17), in priority order so the evaluator
  // claims their daily-cap slot before the CC audience. The evaluator (the manager who owes the
  // feedback) is on EVERY stage. Each stage widens the audience:
  //   1) due       → evaluator only.
  //   2) escalated → + the probationer's Direct Manager + the System Admin (PHX-1).
  //   3) overdue   → + CEO + HR + Super Admin.
  // HR was previously CC'd from the escalated stage company-wide (118 emails to 2 accounts in the
  // first weeks) which trained recipients to stop opening probation email — so HR now only joins at
  // the genuinely urgent overdue stage.
  const ordered: string[] = [];
  const evaluator = normalizeHrId(task.evaluatorHrId);
  if (evaluator) ordered.push(evaluator);
  if (state === "escalated") {
    if (parties.directManagerHrId) ordered.push(parties.directManagerHrId);
    if (parties.systemAdminHrId) ordered.push(parties.systemAdminHrId);
  }
  if (state === "overdue") {
    ordered.push(...parties.ceoHrIds, ...parties.hrApproverHrIds);
  }
  // De-dup (keep first occurrence / priority order) then apply the per-recipient daily cap (MOD-3):
  // an over-cap recipient is skipped this run and re-tried by tomorrow's idempotent sweep.
  const recipients = [...new Set(ordered)].filter((h) => parties.cap.allow(h));
  if (recipients.length === 0) return 0;

  const copy = STATE_COPY[state as "due" | "escalated" | "overdue"];
  const title = `${copy.headline} — ${employeeName}`;
  const message = copy.body(employeeName);
  const ctaUrl = task.caseId ? `${systemDeployment.productionUrl}/probation/cases/${task.caseId}` : null;
  // Plain-English table rows (owner feedback, 2026-07-17): no raw state word, no "Hours overdue: 0"
  // when the task isn't actually overdue yet — that read as meaningless noise.
  const metrics = [
    { label: "Employee", value: employeeName },
    { label: "Visit date", value: task.dvDate },
    { label: "Status", value: copy.statusLabel },
    ...(state === "overdue" ? [{ label: "Overdue by", value: `${task.sla.hoursOverdue}h` }] : []),
  ];

  // Recipients are independent (each has its own idempotency key, and claimDelivery's atomic
  // upsert-on-conflict makes concurrent claims race-safe) — dispatch in parallel instead of
  // serially. With the cron's per-task fan-out also parallel (see processFeedbackSlaReminders),
  // a serial recipient loop here was part of what made the whole run exceed its 30s step budget
  // (see 2026-07-15/16 notifications cron 504 outage).
  await Promise.all(
    recipients.map((recipientHrId) =>
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
          ctaLabel: "Open probation report",
          metrics,
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
  return recipients.length;
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
  const allWithSla = tasks.map((t) => ({ ...t, sla: computeFeedbackSla(t.dvDate, nowIso, config.sla, t.createdAt) }));
  // FRESH START (owner directive 2026-07-17): only DV-Days captured on/after the reset instant may
  // send reminders. This suppresses catch-up reminders for the pre-reset backlog (62 open DV-days at
  // re-enable) that dedup would NOT have caught (a new due→escalated→overdue transition is a new key).
  //
  // TRAINING-MANAGER OPT-OUT (owner directive 2026-07-18): Training Manager feedback is OPTIONAL, so a
  // TM-evaluated Double-Visit day never generates an SLA reminder or escalation. The task still exists
  // (a TM may submit feedback if they choose) but is never chased. Pairs with requirements.tm = 0 in
  // the probation config, which drops TM from the required/decision-readiness components.
  const withSla = allWithSla.filter(
    (t) => !isBeforeProbationEmailFreshStart(t.createdAt) && t.evaluatorRole !== "tm",
  );

  const [hrApproverHrIds, ceoHrIds, systemAdminHrId, caseInfo, cap] = await Promise.all([
    resolveHrApproverHrIds(),
    resolveCeoHrIds(),
    resolveSystemAdminHrId(),
    resolveCaseInfo(withSla),
    createProbationDailyCap(new Date(nowIso)),
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
    withSla.map((task) => {
      const info = task.caseId ? caseInfo.get(task.caseId) : undefined;
      return emitForTask(task, info?.name || task.employeeHrId, {
        hrApproverHrIds,
        ceoHrIds,
        systemAdminHrId,
        directManagerHrId: info?.managerHrId ?? null,
        cap,
      });
    }),
  );
  const notificationsEmitted = emittedPerTask.reduce((sum, n) => sum + n, 0);

  return { scanned: withSla.length, due, escalated, overdue, notificationsEmitted };
}
