import { writeAuditLog } from "@/lib/admin/audit";
import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import type { UnmappedAgentAlert, UnmappedAgentAlertKind } from "@/lib/crm/unmapped-alert";
import type { UnrecognizedVisitTypeAlert } from "@/lib/crm/unrecognized-visit-type-alert";

// Notifies Super Admins over Telegram/in-app every time a CRM (iReports360) pull finishes —
// success or failure — so someone always knows the visits mirror is fresh without having to
// check ireports360_visits_sync_runs manually. Mirrors the retired (2026-10-23) weekly health digest's recipient
// + delivery pattern: module: "telegram" deliberately bypasses the editable-template path
// (see telegram-templates.ts) because this is a code-composed ops digest, not a per-employee
// workflow notification.

export type IReports360SyncJobName =
  | "ireports360-visits-sync"
  | "ireports360-visits-reconcile"
  | "ireports360-visits-live-sync"
  | "ireports360-live-poll";

const JOB_LABELS: Record<IReports360SyncJobName, string> = {
  "ireports360-visits-reconcile": "Weekly Wide Reconciliation",
  "ireports360-visits-sync": "Daily Visits Sync",
  "ireports360-visits-live-sync": "Live Morning Sync (8:30 AM-12:01 PM)",
  // The in-process continuous poller (src/lib/crm/live-poller.ts). Only ever notifies on a
  // SUSTAINED failure streak — success at its cadence would be pure noise.
  "ireports360-live-poll": "Continuous Live Poll",
};

export type IReports360SyncNotifyInput =
  | {
      status: "success";
      jobName: IReports360SyncJobName;
      dateFrom: string;
      dateTo: string;
      runId: string;
      result: {
        /** Visits the post-exit attribution guard refused: the CRM slot resolves to someone who had
         * already left on the visit date. Optional so an older caller still type-checks. */
        blockedPostExitAttributions?: number;
        /** Visits the PRE-HIRE guard refused: the CRM slot resolves to someone who had not yet
         * joined on the visit date — the other side of the same account handover. Optional so an
         * older caller still type-checks. */
        blockedPreHireAttributions?: number;
        /** Optional so an older caller still type-checks; see buildIReports360SyncMessage. */
        checkinsFailed?: boolean;
        checkinsFetched: number;
        checkinsUpserted: number;
        rowsDeleted: number;
        rowsFetched: number;
        rowsSkippedInvalidDate: number;
        /** >0 means the reconciliation refused to delete because the fetch looked truncated. */
        rowsSkippedReconcile?: number;
        rowsUpserted: number;
      };
    }
  | {
      status: "failed";
      jobName: IReports360SyncJobName;
      dateFrom: string;
      dateTo: string;
      errorMessage: string;
    };

type SyncNotifyRecipient = { hrId: string; userId: string | null };

// Delegates to the shared person-level resolver: two of the Super Admin accounts are one human, and
// enumerating auth accounts sent him every sync digest twice. Do not re-query app_auth_users here.
async function resolveSyncNotifyRecipients(): Promise<{ recipients: SyncNotifyRecipient[]; warnings: string[] }> {
  return resolveNotificationPersonRecipients("ireports360_sync_notify", "Sync-notify recipients");
}

export function buildIReports360SyncMessage(input: IReports360SyncNotifyInput): string {
  const label = JOB_LABELS[input.jobName];
  const lines: string[] = [];
  if (input.status === "success") {
    // A run can succeed and still be carrying a warning the write path really wants a human to
    // see. Both of these used to be invisible unless somebody opened /admin/crm, so the headline
    // reflects them rather than always reading as an unqualified ✅.
    const truncatedFetch = (input.result.rowsSkippedReconcile ?? 0) > 0;
    const checkinsBroken = input.result.checkinsFailed === true;
    const quietFetch = input.result.rowsFetched === 0;
    const postExitBlocked = input.result.blockedPostExitAttributions ?? 0;
    const preHireBlocked = input.result.blockedPreHireAttributions ?? 0;
    const degraded = truncatedFetch || checkinsBroken || quietFetch || postExitBlocked > 0 || preHireBlocked > 0;
    lines.push(`${degraded ? "⚠️" : "✅"} iReports360 CRM Sync — ${label}${degraded ? " (with warnings)" : ""}`);
    lines.push(`Window: ${input.dateFrom} → ${input.dateTo}`);
    lines.push("");
    if (truncatedFetch) {
      lines.push(
        `⚠️ Reconciliation SKIPPED — ${input.result.rowsSkippedReconcile} rows looked deleted (>50% of the window).`,
      );
      lines.push("   The CRM response was probably truncated. Nothing was deleted; re-run before trusting this window.");
    }
    if (checkinsBroken) {
      lines.push("⚠️ Check-ins did not sync (fetch or reconciliation failed). Visit times fall back to logged/save time.");
    }
    if (quietFetch) {
      lines.push("⚠️ ZERO visits returned for this window — verify the CRM integration is still healthy.");
    }
    if (postExitBlocked > 0) {
      lines.push(
        `⚠️ ${postExitBlocked} visit(s) NOT attributed — the CRM account resolves to someone who had already left.`,
      );
      lines.push(
        "   That usually means the account was handed to a replacement. Map it on /admin/crm → Unmapped Agents,",
      );
      lines.push("   or the new rep's work stays invisible and can trigger a wrongful absence deduction.");
    }
    if (preHireBlocked > 0) {
      lines.push(
        `⚠️ ${preHireBlocked} visit(s) NOT attributed — dated BEFORE the resolved employee had joined.`,
      );
      lines.push(
        "   The other side of the same account handover: this is the previous holder's history, which the",
      );
      lines.push(
        "   CRM has relabelled with the new joiner's name. Map it on /admin/crm → Unmapped Agents so the work",
      );
      lines.push("   reaches whoever actually did it. Nobody is credited for days before they started.");
    }
    if (degraded) lines.push("");
    lines.push(`Visits fetched: ${input.result.rowsFetched}`);
    lines.push(`Visits upserted: ${input.result.rowsUpserted}`);
    if (input.result.rowsDeleted > 0) lines.push(`Visits removed (voided in CRM): ${input.result.rowsDeleted}`);
    if (input.result.rowsSkippedInvalidDate > 0) {
      lines.push(`Visits skipped (invalid date): ${input.result.rowsSkippedInvalidDate}`);
    }
    lines.push(`Check-ins fetched: ${input.result.checkinsFetched}`);
    lines.push(`Check-ins upserted: ${input.result.checkinsUpserted}`);
    lines.push("");
    lines.push("Details → /admin/crm");
  } else {
    lines.push(`❌ iReports360 CRM Sync FAILED — ${label}`);
    lines.push(`Window: ${input.dateFrom} → ${input.dateTo}`);
    lines.push("");
    lines.push(`Error: ${input.errorMessage}`.slice(0, 500));
    lines.push("");
    lines.push("Details → /admin/crm");
  }
  return lines.join("\n");
}

export type IReports360SyncNotifyResult = { delivered: number; reason?: string; skipped: boolean };

// ── Unmapped-agent activity alerts ───────────────────────────────────────────────────────────────

/** ISO week key ("2026-W32", UTC) — the idempotency window for unmapped-agent alerts: one alert
 * per agent per kind per week, durable across restarts because createSystemNotification dedupes
 * on the stored event key. First discovery alerts immediately; while the agent stays unmapped the
 * weekly key keeps a reminder flowing instead of one alert scrolling away forever. */
export function isoWeekKeyOf(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  target.setUTCDate(target.getUTCDate() - dayNumber + 3); // nearest Thursday defines the ISO year
  const isoYear = target.getUTCFullYear();
  // Jan 4 always falls inside ISO week 1; stepping back to its Monday anchors the week count.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekMonday = new Date(jan4);
  firstWeekMonday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((target.getTime() - firstWeekMonday.getTime()) / 604_800_000);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

const UNMAPPED_ALERT_TITLES: Record<UnmappedAgentAlertKind, string> = {
  mapped_label_drift: "CRM Account Changed Hands — Mapping No Longer Applies",
  new_unmapped: "New CRM Agent With No Phoenix Mapping — Work Is Invisible",
  orphaned_mapped_hr_id: "CRM Mapping Points To A Missing Employee Record",
  pending_reminder: "CRM Agent Still Unmapped — Weekly Reminder",
  reused_resigned_slot: "Resigned CRM Account Reused — A Rep's Work Is Hidden",
};

function buildUnmappedAgentMessage(alert: UnmappedAgentAlert): string {
  const who = alert.agentName?.trim() || "(no name on the CRM record)";
  // Own shape entirely: this account IS mapped, so "unmapped visits this window" (the shared tail
  // below) would misdescribe it — the fresh work exists, it is just filed under a stale hr id.
  if (alert.kind === "orphaned_mapped_hr_id") {
    return [
      `🔴 A mapped CRM account (${who}, CRM account #${alert.agentCrmId}) points at HR ID "${alert.staleHrId}",`,
      "which no longer matches any employee. This mapping was correct once, but that roster row was since",
      "renamed, replaced, or removed — every fresh visit on this account is still filed under the missing",
      "hr id, invisible to that person's own portal, their manager's team view, and payroll's activity check.",
      "",
      "Fix → /admin/crm → Unmapped Agents → re-map this account to the correct CURRENT HR ID.",
    ].join("\n");
  }
  const span = alert.firstDay === alert.lastDay ? `on ${alert.lastDay}` : `${alert.firstDay} → ${alert.lastDay}`;
  const lines: string[] = [];
  if (alert.kind === "new_unmapped") {
    lines.push(`🔴 ${who} is logging CRM visits but maps to NO Phoenix employee.`);
  } else if (alert.kind === "pending_reminder") {
    lines.push(`⏳ ${who} is still unmapped (decision pending) and keeps logging visits.`);
  } else if (alert.kind === "reused_resigned_slot") {
    lines.push(`🔴 A CRM account marked "resigned" is logging NEW visits under a different name: ${who}.`);
    lines.push("This is the reused-account pattern — a replacement is working invisibly under a leaver's login.");
  } else {
    lines.push(`⚠️ A mapped CRM account now logs visits under a DIFFERENT name: ${who}.`);
    lines.push("The stored mapping no longer applies to these rows — the account likely changed hands again.");
  }
  lines.push("");
  lines.push(`Unmapped visits this window: ${alert.visitCount} (${span}, CRM account #${alert.agentCrmId}).`);
  lines.push("Until it is mapped, this person's fieldwork is missing from every board, compliance report,");
  lines.push("and deduction check — an absence deduction can fire against real work.");
  lines.push("");
  lines.push("Fix → /admin/crm → Unmapped Agents");
  return lines.join("\n");
}

/** Alerts per run are capped — a first run after a long outage could surface dozens of historical
 * identities at once, and the point is a punch-list ping, not a flood. */
const UNMAPPED_ALERTS_PER_RUN_CAP = 10;

/**
 * Pushes one high-priority notification per unmapped-agent alert to the same recipients as the
 * sync digests, deduped per agent+kind+ISO-week via the notification event key. Best-effort —
 * never throws; the sync run this rides on has already succeeded.
 */
export async function notifyUnmappedCrmAgentActivity(input: {
  alerts: readonly UnmappedAgentAlert[];
  dateFrom: string;
  dateTo: string;
  runId: string;
}): Promise<IReports360SyncNotifyResult> {
  try {
    if (input.alerts.length === 0) return { delivered: 0, reason: "no alerts", skipped: true };
    const { recipients } = await resolveSyncNotifyRecipients();
    if (recipients.length === 0) return { delivered: 0, reason: "no recipients", skipped: true };

    const weekKey = isoWeekKeyOf(new Date());
    const capped = input.alerts.slice(0, UNMAPPED_ALERTS_PER_RUN_CAP);
    let delivered = 0;
    for (const alert of capped) {
      const message = buildUnmappedAgentMessage(alert);
      await Promise.all(
        recipients.map(async (recipient) => {
          await createSystemNotification({
            actionUrl: "/admin/crm",
            actorId: "ireports360-sync-cron",
            channels: ["in_app", "telegram", "push"],
            eventType: "ireports360_unmapped_agent",
            message,
            metadata: {
              agentCrmId: alert.agentCrmId,
              agentName: alert.agentName,
              dateFrom: input.dateFrom,
              dateTo: input.dateTo,
              idempotencyKey: `crm-unmapped-agent:${alert.kind}:${alert.agentCrmId}:${weekKey}:${recipient.hrId}`,
              kind: alert.kind,
              runId: input.runId,
              visitCount: alert.visitCount,
            },
            module: "system",
            priority: "high",
            recipientHrId: recipient.hrId,
            recipientUserId: recipient.userId,
            title: UNMAPPED_ALERT_TITLES[alert.kind],
          });
          delivered += 1;
        }),
      );
    }
    return { delivered, skipped: false };
  } catch (error) {
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}

/** Far lower than the unmapped-agent cap on purpose: iReports360 has produced 16 distinct visit
 * types in its entire history, so more than a handful of NEW ones in one run means something
 * structural changed at the vendor, and five examples make that point as well as fifty would. */
const UNRECOGNIZED_VISIT_TYPE_ALERTS_PER_RUN_CAP = 5;

/**
 * Deliberately leads with the numeric code. Standing rule is to show human-readable names and
 * never raw codes — but this alert fires precisely because the code HAS no name: Phoenix has never
 * classified it and the vendor's own description for an undocumented code is the literal string
 * "Unknown". The number is the only identifier that exists, so it is reported alongside whatever
 * the vendor did send and a real rep comment, which is how the previous seven were identified.
 */
function buildUnrecognizedVisitTypeMessage(alert: UnrecognizedVisitTypeAlert): string {
  const span = alert.firstDay === alert.lastDay ? `on ${alert.firstDay}` : `${alert.firstDay} → ${alert.lastDay}`;
  const reps = alert.agentCount === 1 ? "1 rep" : `${alert.agentCount} reps`;
  const lines: string[] = [
    `🔴 iReports360 sent visit type ${alert.visitType}, which Phoenix has never classified.`,
    "",
    `Seen: ${alert.visitCount} visit(s) by ${reps}, ${span}.`,
    `The vendor calls it: ${alert.sampleDescription ?? "(it sent no description at all)"}`,
  ];
  if (alert.sampleComment) lines.push(`A rep's own comment on one of these visits: ${alert.sampleComment}`);
  lines.push(
    "",
    "What this costs until it is classified: on a day whose ONLY CRM record is this code, the",
    "attendance engine sets no field-visit and no leave flag, so nothing cancels a deduction and the",
    "day is judged on punch timing alone. Someone can be deducted for a day they actually worked.",
    "",
    "Fix → classify this code in the one visit-type table every map reads:",
    "  src/lib/crm/visit-type-meaning.ts",
  );
  return lines.join("\n");
}

/**
 * Pushes one high-priority notification per unrecognized visit-type code, to the same recipients
 * as the sync digests, deduped per code + ISO week via the notification event key. Best-effort —
 * never throws; the sync run this rides on has already succeeded.
 */
export async function notifyUnrecognizedCrmVisitTypes(input: {
  alerts: readonly UnrecognizedVisitTypeAlert[];
  dateFrom: string;
  dateTo: string;
  runId: string;
}): Promise<IReports360SyncNotifyResult> {
  try {
    if (input.alerts.length === 0) return { delivered: 0, reason: "no alerts", skipped: true };
    const { recipients } = await resolveSyncNotifyRecipients();
    if (recipients.length === 0) return { delivered: 0, reason: "no recipients", skipped: true };

    const weekKey = isoWeekKeyOf(new Date());
    const capped = input.alerts.slice(0, UNRECOGNIZED_VISIT_TYPE_ALERTS_PER_RUN_CAP);
    let delivered = 0;
    for (const alert of capped) {
      const message = buildUnrecognizedVisitTypeMessage(alert);
      await Promise.all(
        recipients.map(async (recipient) => {
          await createSystemNotification({
            actionUrl: "/admin/crm",
            actorId: "ireports360-sync-cron",
            channels: ["in_app", "telegram", "push"],
            eventType: "ireports360_unrecognized_visit_type",
            message,
            metadata: {
              agentCount: alert.agentCount,
              dateFrom: input.dateFrom,
              dateTo: input.dateTo,
              firstDay: alert.firstDay,
              idempotencyKey: `crm-unrecognized-visit-type:${alert.visitType}:${weekKey}:${recipient.hrId}`,
              lastDay: alert.lastDay,
              runId: input.runId,
              sampleComment: alert.sampleComment,
              sampleDescription: alert.sampleDescription,
              visitCount: alert.visitCount,
              visitType: alert.visitType,
            },
            module: "system",
            priority: "high",
            recipientHrId: recipient.hrId,
            recipientUserId: recipient.userId,
            title: `Unclassified CRM Visit Type ${alert.visitType} — Attendance Cover Is Missing`,
          });
          delivered += 1;
        }),
      );
    }
    return { delivered, skipped: false };
  } catch (error) {
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}

/**
 * Best-effort — never throws. Called by both the daily sync and weekly wide-reconciliation
 * crons after every run (success or failure), so Super Admins always know the CRM mirror is
 * fresh without checking ireports360_visits_sync_runs manually.
 */
export async function notifyIReports360SyncResult(input: IReports360SyncNotifyInput): Promise<IReports360SyncNotifyResult> {
  try {
    const { recipients, warnings } = await resolveSyncNotifyRecipients();
    const message = buildIReports360SyncMessage(input);
    // A unique key per delivery: the success path's runId is already unique per sync run; the
    // failure path has no runId in scope at the route level, so a timestamp stands in. Without
    // a unique key, eventKeyFor() would hash eventType+module+recipient+title (which repeat
    // identically across every cron firing) and every run after the first would silently dedupe
    // away as "already sent" instead of delivering.
    const idempotencyBase =
      input.status === "success"
        ? `ireports360-sync:${input.jobName}:${input.runId}`
        : `ireports360-sync:${input.jobName}:failed:${input.dateFrom}:${input.dateTo}:${Date.now()}`;

    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: "ireports360-sync-cron",
        entityId: `telegram.ireports360_sync_${input.jobName}`,
        entityType: "notification",
        newValues: { failClosed: true, status: input.status, warnings },
        summary: "iReports360 sync notification skipped — no Super Admin recipient resolved.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true };
    }

    const priority = input.status === "failed" ? "high" : "normal";
    const title =
      input.status === "failed"
        ? `iReports360 CRM Sync Failed — ${JOB_LABELS[input.jobName]}`
        : `iReports360 CRM Sync Complete — ${JOB_LABELS[input.jobName]}`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/admin/crm",
          actorId: "ireports360-sync-cron",
          // A FAILURE takes every channel. A routine success does not reach Telegram (owner rule
          // 2026-10-15) — it stays on record in-app. The real enforcement is the post-filter in
          // basePolicyChannels, which the policy fallback cannot bypass; this line is here so the
          // rule is visible where the digest is composed. See ops-success-digest-channel-guard.ts.
          channels: input.status === "failed" ? ["in_app", "telegram", "push"] : ["in_app", "push"],
          eventType: `ireports360_sync_${input.status}`,
          message,
          metadata: {
            dateFrom: input.dateFrom,
            dateTo: input.dateTo,
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
            jobName: input.jobName,
            status: input.status,
            ...(input.status === "success" ? { result: input.result } : { errorMessage: input.errorMessage }),
          },
          // "system" is the module actually enabled in notification_module_channel_policies for
          // Telegram ("Optional Telegram channel for system tests and announcements") — NOT the
          // literal string "telegram", which has no governance policy row (code default or DB)
          // and therefore fails closed via resolveTelegramGovernance's unknown-module fail-safe.
          // Confirmed live 2026-07-12: runWeeklySystemHealthDigest / runTelegramDailyHrDigest both
          // pass module: "telegram" too and hit the same fail-closed gate — their Telegram channel
          // has likely never actually delivered, only in-app (pre-existing bug, out of scope here).
          module: "system",
          priority,
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          title,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: "ireports360-sync-cron",
      entityId: `telegram.ireports360_sync_${input.jobName}`,
      entityType: "notification",
      newValues: { delivered, status: input.status, warnings },
      summary: `iReports360 ${input.status === "success" ? "sync" : "sync failure"} notification processed.`,
    });

    return { delivered, skipped: false };
  } catch (error) {
    // Never let a notification-delivery bug turn an otherwise-successful (or already-failed)
    // CRM sync into a second, unrelated failure — the caller always wraps this in .catch() too,
    // but this inner guard keeps the function's own contract ("never throws") honest.
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
