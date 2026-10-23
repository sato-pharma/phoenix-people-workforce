import { writeAuditLog } from "@/lib/admin/audit";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { logError } from "@/lib/observability/log";
import {
  resolveNotificationPersonRecipients,
  resolveNotificationRoleEnabled,
} from "@/lib/notifications/role-recipients";
import { createSystemNotification, type SystemNotificationResult } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { loadAlertCandidates, markIssuesAlerted, type AlertCandidate } from "@/lib/system-audit/repository";

/**
 * THE ONE DAILY MESSAGE — everything the System Audit found overnight that a human has not been told
 * about yet, in one notice, once a Cairo day.
 *
 * It replaces the per-source alarms that used to arrive separately (the reconciliation breach alert
 * was the first one retired, 2026-10-23). What goes in is decided by the ledger, not here:
 * `system_audit_alert_candidates` returns only the issues that are NEW, have become SHARED by a
 * second person, or were REOPENED since the last message, and `system_audit_mark_alerted` records
 * what was said so tomorrow carries only what changed. Nothing new → NOTHING is sent: a daily "all
 * clear" is the message that trains everyone to stop reading the real one.
 *
 * Audience: the admin-editable `weekly_system_health_digest` key — the existing technical-health
 * audience, retargeted or silenced from /admin/notification-recipients with no migration.
 *
 * Channels: in-app and Telegram ONLY. No email — the owner's standing rule is that no feature adds an
 * outbound email, and this message can be about the email pipeline itself. No push either: it is a
 * once-a-day summary, not an alarm that should buzz a phone at five in the morning.
 */

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "system_audit_daily";
const ACTOR = "system-audit-sweep";
export const SYSTEM_AUDIT_PAGE_URL = "/admin/system-audit";
/** Issues listed by name; the rest are counted and left to the page. */
export const SYSTEM_AUDIT_MESSAGE_LINES = 10;

type Recipient = { hrId: string; userId: string | null };

export type SystemAuditDailyMessageResult = {
  sent: boolean;
  candidates: number;
  delivered: number;
  marked: number;
  reason?: string;
};

export type SystemAuditDailyMessageDeps = {
  loadCandidates: () => Promise<AlertCandidate[]>;
  markAlerted: (issueIds: string[]) => Promise<number>;
  audienceEnabled: () => Promise<boolean>;
  recipients: () => Promise<{ recipients: Recipient[]; warnings: string[] }>;
  /** true = today's message already reached this person; null = could not tell (then send as before). */
  alreadyToldToday: (day: string, hrId: string) => Promise<boolean | null>;
  notify: (input: Parameters<typeof createSystemNotification>[0]) => Promise<SystemNotificationResult>;
  audit: (input: Parameters<typeof writeAuditLog>[0]) => Promise<unknown>;
  now: () => Date;
};

const defaultDeps: SystemAuditDailyMessageDeps = {
  loadCandidates: () => loadAlertCandidates(),
  markAlerted: (issueIds) => markIssuesAlerted(issueIds),
  audienceEnabled: () => resolveNotificationRoleEnabled(AUDIENCE_KEY),
  recipients: () => resolveNotificationPersonRecipients(AUDIENCE_KEY, "System audit daily message recipients"),
  alreadyToldToday: async (day, hrId) => {
    // The notice's event_key IS its idempotency key (unique), and its deliveries hang off it.
    const supabase = getSupabaseAdmin();
    const { data: event, error } = await supabase
      .from("notification_events")
      .select("id")
      .eq("event_key", systemAuditDailyKey(day, hrId))
      .maybeSingle();
    if (error) return null;
    if (!event) return false;
    const { data: deliveries, error: deliveryError } = await supabase
      .from("notification_deliveries")
      .select("status")
      .eq("notification_event_id", (event as { id: string }).id)
      .in("status", ["sent", "pending", "retrying"])
      .limit(1);
    if (deliveryError) return null;
    return (deliveries ?? []).length > 0;
  },
  notify: (input) => createSystemNotification(input),
  audit: (input) => writeAuditLog(input),
  now: () => new Date(),
};

/** One notice per person per Cairo day — the idempotency key, and so the notice's event_key. */
export function systemAuditDailyKey(day: string, hrId: string): string {
  return `system-audit-daily:${day}:${hrId}`;
}

/** The Cairo calendar day — the unit "once a day" is counted in, so it is the owner's day. */
export function cairoDayKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(now);
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** A row with no person is a system row — "0 people" would read like nobody was affected. */
function peopleWords(people: number): string {
  return people > 0 ? plural(people, "person", "people") : "system, no employee";
}

/**
 * Pure: the title and body. Counts by reason first, then up to ten issues by name, then how many
 * more wait on the page — never a silent cut.
 */
export function buildSystemAuditDailyMessage(candidates: readonly AlertCandidate[]): { title: string; message: string } {
  const count = (reason: AlertCandidate["reason"]) => candidates.filter((candidate) => candidate.reason === reason).length;
  const lines: string[] = [];
  lines.push(`${count("new")} new · ${count("newly_shared")} newly shared · ${count("reopened")} reopened`);
  lines.push("");
  for (const candidate of candidates.slice(0, SYSTEM_AUDIT_MESSAGE_LINES)) {
    lines.push(
      `• ${candidate.title} — ${peopleWords(candidate.people)}, ${plural(candidate.operations, "time", "times")}, last ${cairoDateTime(candidate.lastOccurredAt)}`,
    );
  }
  const rest = candidates.length - SYSTEM_AUDIT_MESSAGE_LINES;
  if (rest > 0) {
    lines.push("");
    lines.push(`and ${rest.toLocaleString("en-US")} more on the page`);
  }
  return {
    title: `System Audit — ${plural(candidates.length, "issue needs", "issues need")} a look`,
    message: lines.join("\n"),
  };
}

/** A delivery that reached, or is on its way to, the person. Skipped and failed did not. */
function wasTold(result: SystemNotificationResult | null): boolean {
  return Boolean(result?.deliveries.some((delivery) => ["sent", "pending", "retrying"].includes(delivery.status)));
}

/**
 * Send the day's message, or nothing. Best-effort — NEVER throws: it runs after the sweep, and a
 * failed message must not turn a finished sweep into a failed cron run.
 *
 * The issues are marked as told ONLY when somebody was actually told. A second run the same Cairo
 * day is stopped by the idempotency key, every one of its deliveries comes back skipped, and its
 * issues stay unmarked — so they ride tomorrow's message instead of vanishing between the two.
 */
export async function sendSystemAuditDailyMessage(
  overrides: Partial<SystemAuditDailyMessageDeps> = {},
): Promise<SystemAuditDailyMessageResult> {
  const deps = { ...defaultDeps, ...overrides };
  let candidates: AlertCandidate[] = [];
  try {
    candidates = await deps.loadCandidates();
    if (candidates.length === 0) return { sent: false, candidates: 0, delivered: 0, marked: 0, reason: "nothing new" };

    if (!(await deps.audienceEnabled())) {
      return { sent: false, candidates: candidates.length, delivered: 0, marked: 0, reason: "audience disabled by admin" };
    }

    const { recipients, warnings } = await deps.recipients();
    const issueIds = candidates.map((candidate) => candidate.issueId);
    if (recipients.length === 0) {
      // Fail LOUDLY into the audit trail: findings nobody was told about are the exact failure this
      // whole audit exists to end. The issues stay unmarked, so the next message still carries them.
      await deps.audit({
        actorLoginId: ACTOR,
        entityId: "system_audit.daily_message",
        entityType: "notification",
        newValues: { candidates: candidates.length, failClosed: true, issueIds: issueIds.slice(0, 50), warnings },
        summary: "System Audit daily message skipped — no active recipient resolved for the configured audience.",
      });
      return { sent: false, candidates: candidates.length, delivered: 0, marked: 0, reason: "no recipients" };
    }

    const day = cairoDayKey(deps.now());
    // A person already told today is NOT asked again. The idempotency key would refuse the second
    // delivery anyway, but the refused call still rewrites the stored notice — its title, body and
    // sent time, which the in-app bell shows — with text that was never delivered. On 23 Oct 2026 the
    // 10:56 message listing 365 issues was overwritten by an 11:53 re-run reading "3 issues". A read
    // that fails (null) sends as before: the key still stops a double send.
    const toldToday = await Promise.all(
      recipients.map((recipient) => deps.alreadyToldToday(day, recipient.hrId).catch(() => null)),
    );
    const pending = recipients.filter((_, index) => toldToday[index] !== true);
    if (pending.length === 0) {
      await deps.audit({
        actorLoginId: ACTOR,
        entityId: "system_audit.daily_message",
        entityType: "notification",
        newValues: { candidates: candidates.length, day, delivered: 0, marked: 0, alreadyToldToday: recipients.length },
        summary: "System Audit daily message already sent today; its issues stay for the next message.",
      });
      return { sent: false, candidates: candidates.length, delivered: 0, marked: 0, reason: "already sent today" };
    }

    const { title, message } = buildSystemAuditDailyMessage(candidates);
    let delivered = 0;
    let told = false;
    await Promise.all(
      pending.map(async (recipient) => {
        const result = await deps.notify({
          actionUrl: SYSTEM_AUDIT_PAGE_URL,
          actorId: ACTOR,
          // In-app and Telegram only — never email, never push (see the file header).
          channels: ["in_app", "telegram"],
          eventType: EVENT_TYPE,
          message,
          metadata: {
            candidates: candidates.length,
            day,
            // One per recipient per Cairo day: a second send that day is impossible by construction.
            idempotencyKey: systemAuditDailyKey(day, recipient.hrId),
            issueIds: issueIds.slice(0, 50),
          },
          // module: "system" is the module enabled for Telegram in
          // notification_module_channel_policies — an unknown module string fails closed in
          // resolveTelegramGovernance, which would silently drop the message.
          module: "system",
          priority: "normal",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open System Audit", ctaUrl: SYSTEM_AUDIT_PAGE_URL },
          title,
        });
        if (wasTold(result)) {
          told = true;
          delivered += 1;
        }
      }),
    );

    const marked = told ? await deps.markAlerted(issueIds) : 0;
    await deps.audit({
      actorLoginId: ACTOR,
      entityId: "system_audit.daily_message",
      entityType: "notification",
      newValues: { candidates: candidates.length, day, delivered, marked, warnings },
      summary: told
        ? `System Audit daily message delivered to ${delivered} recipient(s), ${marked} issue(s) marked as told.`
        : "System Audit daily message reached nobody (already sent today, or every channel skipped); its issues stay for the next message.",
    });
    return {
      sent: told,
      candidates: candidates.length,
      delivered,
      marked,
      ...(told ? {} : { reason: "no delivery reached anyone" }),
    };
  } catch (error) {
    logError("System Audit daily message failed", {
      error,
      labels: { event: "system_audit_daily_message_failed" },
    });
    return {
      sent: false,
      candidates: candidates.length,
      delivered: 0,
      marked: 0,
      reason: error instanceof Error ? error.message : "unknown error",
    };
  }
}
