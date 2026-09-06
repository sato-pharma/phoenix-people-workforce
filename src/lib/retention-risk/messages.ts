/**
 * Retention risk — every word the feature says, and nothing that reads or writes.
 *
 * Split out of ./notify.ts so the wording, the channel list and the per-role addresses can be
 * tested directly. notify.ts reaches the CRM mirror and `next/cache` through the service, which a
 * plain node test cannot load; this file imports nothing but a type, so the assertions that matter
 * most — that the message never accuses anybody, and that push is never in the channel list — run
 * for real instead of by reading the source.
 *
 * TONE IS A DESIGN CONSTRAINT HERE, not a nicety. Every message states the measured fact and
 * stops: "no CRM entry for six working days, last entry 31 August". It never says the person is
 * about to resign, because the detector cannot know that — the backtest puts the hit rate at
 * roughly one in five, so four of every five people named are staying. These messages carry a
 * named employee to their own manager and to HR; written as an accusation they would do real harm
 * to someone who was simply ill.
 */

import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import type { SystemNotificationChannel } from "@/lib/notifications/system";
import type { RetentionRiskSignal, RetentionRiskTrigger } from "@/lib/retention-risk/types";

export const RETENTION_RISK_AUDIENCE = "retention_risk_alert" as const;
export const RETENTION_RISK_MODULE = "retention_risk" as const;
export const RETENTION_RISK_EVENT_TYPE = "retention_risk_flagged" as const;
export const RETENTION_RISK_PRE_PAYROLL_EVENT_TYPE = "retention_risk_pre_payroll" as const;

/**
 * In-app, email and Telegram — the three the owner named on 2026-09-06, and only those.
 *
 * Push is deliberately absent. He did not ask for it, and it is the one channel that puts a named
 * employee and the words "no CRM activity" on an unlocked-phone preview, where anyone holding the
 * handset can read it. The other three all require the recipient to open something.
 */
export const RETENTION_RISK_CHANNELS: readonly SystemNotificationChannel[] = ["in_app", "email", "telegram"];

/**
 * A date-only value (YYYY-MM-DD) is a CALENDAR day, not an instant, and it parses as UTC midnight.
 * Formatting it in Africa/Cairo would render 2026-09-06 as 6 September at 03:00 — same day here,
 * but the inverse case shifts the day backwards and prints the wrong date. UTC is what keeps a
 * date-only value on its own day; it is not a timezone choice, it is the absence of one.
 */
export function formatRetentionRiskDate(dateIso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC", year: "numeric" })
    .format(new Date(`${dateIso}T00:00:00Z`));
}

function personLabel(signal: RetentionRiskSignal): string {
  const code = canonicalHrIdForDisplay(signal.hrId) ?? signal.hrId;
  return `${signal.displayName} (${code})`;
}

function placeLabel(signal: RetentionRiskSignal): string {
  const parts = [signal.jobTitle, signal.areaName, signal.lineName].filter(Boolean);
  return parts.join(", ");
}

export function retentionRiskTitle(signal: RetentionRiskSignal): string {
  const dayWord = signal.workingDays === 1 ? "working day" : "working days";
  return signal.trigger === "crm_silence"
    ? `No CRM activity for ${signal.workingDays} ${dayWord} — ${signal.displayName}`
    : `${signal.workingDays} consecutive leave ${dayWord} — ${signal.displayName}`;
}

export function retentionRiskMessage(signal: RetentionRiskSignal): string {
  const where = placeLabel(signal);
  const who = where ? `${personLabel(signal)}, ${where},` : `${personLabel(signal)}`;
  const span = `${formatRetentionRiskDate(signal.startDate)} to ${formatRetentionRiskDate(signal.endDate)}`;
  const lines: string[] = [];

  if (signal.trigger === "crm_silence") {
    lines.push(
      `${who} has recorded no CRM entry of any kind on ${signal.workingDays} consecutive working days, ${span}.`,
    );
    lines.push(
      signal.lastCrmActivityDate
        ? `Last recorded entry: ${formatRetentionRiskDate(signal.lastCrmActivityDate)}.`
        : "No CRM entry was recorded at any point in the period reviewed.",
    );
  } else {
    lines.push(`${who} is on recorded leave for ${signal.workingDays} consecutive working days, ${span}.`);
  }

  if (signal.ongoing) lines.push("This has not ended yet.");
  if (signal.managerName) {
    lines.push(`Reporting manager: ${signal.managerName}.`);
  }
  lines.push(
    "This is an early warning, not a conclusion. Please check whether the person is on approved leave, unwell, or unable to record their work before drawing any inference from it.",
  );
  return lines.join(" ");
}

/**
 * Where each recipient can actually OPEN the person's record.
 *
 * Employee 360 exists at three addresses, one per shell, and the admin-group layout sends a
 * portal-mode viewer to the portal HOME before the page runs — `portal-twins.ts` carries no rule
 * for this route, so a District Manager given the bare `/employee-360/...` link would lose their
 * place entirely. `notificationHrefForViewerRole` reads this map first, so each recipient gets the
 * address their own shell serves.
 */
export function roleHrefsForSubject(hrId: string): Record<string, string> {
  const code = canonicalHrIdForDisplay(hrId) ?? hrId;
  const portal = `/employee-portals/employee-360/${encodeURIComponent(code)}`;
  const hr = `/hr/employee-360/${encodeURIComponent(code)}`;
  return {
    "District Manager": portal,
    "Group Product Manager": portal,
    "HR Advisory": hr,
    "HR Operations": hr,
    Manager: portal,
    "Marketing Manager": portal,
    "Medical Rep": portal,
    "National Sales Manager": portal,
    "Product Manager": portal,
    "Regional Manager": portal,
    "Training Manager": portal,
  };
}

export function subjectHref(hrId: string): string {
  return `/employee-360/${encodeURIComponent(canonicalHrIdForDisplay(hrId) ?? hrId)}`;
}

function triggerHeading(trigger: RetentionRiskTrigger, count: number): string {
  return trigger === "crm_silence"
    ? `${count} with no CRM activity`
    : `${count} on five or more consecutive leave days`;
}

/**
 * The pre-payroll warning: one message listing everyone currently flagged.
 *
 * Deliberately a DIGEST rather than one message per person. It is read at a single moment — before
 * money moves — and its job is to let HR decide whether to look at anybody before the run, so a
 * list beats an inbox full of separate notices.
 */
export function retentionRiskPrePayrollMessage(
  signals: readonly RetentionRiskSignal[],
  reason: "part1_confirmed" | "scheduled",
): string {
  const opening =
    reason === "part1_confirmed"
      ? "Payroll Part 1 has just been confirmed."
      : "Payroll for this month is close.";
  if (signals.length === 0) {
    return `${opening} No employee is currently flagged for retention risk — nobody has five or more consecutive working days of leave or of missing CRM activity.`;
  }

  const byTrigger = new Map<RetentionRiskTrigger, RetentionRiskSignal[]>();
  for (const signal of signals) {
    const bucket = byTrigger.get(signal.trigger) ?? [];
    bucket.push(signal);
    byTrigger.set(signal.trigger, bucket);
  }

  const lines: string[] = [
    `${opening} ${signals.length === 1 ? "One employee is" : `${signals.length} employees are`} currently flagged for retention risk. Please review them before payment.`,
    "",
  ];
  for (const trigger of ["crm_silence", "extended_leave"] as const) {
    const bucket = byTrigger.get(trigger);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`${triggerHeading(trigger, bucket.length)}:`);
    for (const signal of bucket) {
      const where = placeLabel(signal);
      const tail = signal.ongoing ? ", still ongoing" : "";
      lines.push(
        `- ${personLabel(signal)}${where ? ` — ${where}` : ""}: ${signal.workingDays} working days, ${formatRetentionRiskDate(signal.startDate)} to ${formatRetentionRiskDate(signal.endDate)}${tail}.`,
      );
    }
    lines.push("");
  }
  lines.push(
    "Each line is a measurement, not a verdict. Confirm the person's situation before treating any of it as a resignation risk.",
  );
  return lines.join("\n");
}

/**
 * The payroll month the scheduled notice is warning about, as "September 2026".
 *
 * The month currently running, not the next one: the cron fires on the 25th and Part 1 for THAT
 * month pays at the start of the following one, so the 25th of September warns about September's
 * payroll. Built in Africa/Cairo, because the month boundary is a Cairo one.
 */
export function prePayrollPeriodLabel(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "Africa/Cairo", year: "numeric" }).format(now);
}

