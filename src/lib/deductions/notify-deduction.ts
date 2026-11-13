// Unified Deductions module: the per-line PUSH notification.
//
// Owner rule (2026-09-22): a deduction is functioning but NEVER automatic. When the Super Admin
// PUSHES one employee's one deduction, that employee is told, and the notice CCs their manager
// chain:
//
//   - a Medical Rep  → District Manager + (Regional Manager, if any) + National Sales Manager
//   - a District Manager → (Regional Manager, if any) + National Sales Manager
//   - anyone with no sales seat → their direct manager (employees.manager_hr_id)
//
// The rep and DM cases both fall out of ONE rule: the occupied manager chain above every sales
// seat the employee holds (managerChain never reaches the CEO and skips the seat's own occupant).
// The owner's "also CC the Regional Manager for a rep" (2026-09-22) is exactly what the full chain
// gives — nearest manager first, up to the National Sales Manager, no CEO.
//
// WHICH CHANNEL CARRIES WHAT — the owner's 2026-10-12 decision, which REPLACES the 2026-09-22
// "a deduction notice never goes by email":
//
//   - EMAIL, to the employee only: the full detail. The amount in EGP, the reason in words, the
//     number of days and the exact days charged. He was asked whether to keep the silent-figure
//     rule after the Nahed Tarek release and chose "add email, with the amount and the reason" —
//     a deduction is people's money and the paper trail is the point.
//   - IN-APP and TELEGRAM, unchanged: NO amount, NO category. A bell badge and a phone lock
//     screen are read by whoever is holding the phone, so they still say only that a deduction
//     was recorded for a month, and point at the self-only Deductions page.
//   - The MANAGER CC stays in-app + Telegram with no amount, no category and no destination —
//     a manager cannot open a self-only portal, and his decision was about the employee's own
//     email, not about widening who sees the figure.
//
// Managers are named by NAME, never by HR code, on every channel.
//
// Everything is INJECTABLE so the tests never touch production: the real senders would notify real
// employees and burn the per-line idempotency key. `send`/`sendToRecipients` default to the live
// orchestrator; the loaders default to the live org tree and employees table.

import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { formatCurrencyValue, formatPhoenixLongDate } from "@/lib/i18n/format";
import type { SystemNotificationResult } from "@/lib/notifications/system";
import {
  createSystemNotification,
  createSystemNotificationForRecipients,
  logNotificationSendFailure,
} from "@/lib/notifications/system";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import {
  heldManagerSeats,
  managerChain,
  ownTerritories,
  personKey,
  type OrgIndex,
} from "@/lib/phoenix-crm/scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { deductionCategoryName, type DeductionsCategory } from "./types.ts";

/** The employee portal page a pushed deduction links to. Self-only for every role. */
const DEDUCTIONS_PORTAL_HREF = "/employee-portals/deductions";

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09" → "September 2026". English always (owner rule); no time zone, this is a month label. */
export function formatDeductionMonthLabel(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey ?? "").trim());
  if (!match) return String(monthKey ?? "");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return `${match[1]}-${match[2]}`;
  return `${MONTHS_EN[month - 1]} ${year}`;
}

/**
 * The manager HR ids to CC when a deduction is pushed for `employeeHrId`.
 *
 * Pure: given the org index (and a direct-manager fallback for a person with no sales seat), it
 * returns the CC list with the employee themselves removed and each manager listed once, nearest
 * first. A sales seat (a REP territory, or a DM/acting-DM/RSM/NSM manager seat) resolves through
 * `managerChain`; anyone else falls back to their flat `employees.manager_hr_id`.
 */
export function resolveDeductionNotificationCc(input: {
  employeeHrId: string;
  orgIndex: OrgIndex;
  directManagerHrId?: string | null;
}): string[] {
  const self = personKey(input.employeeHrId);
  const salesSeats = [
    ...ownTerritories(input.orgIndex, input.employeeHrId),
    ...heldManagerSeats(input.orgIndex, input.employeeHrId),
  ];

  const cc: string[] = [];
  const seen = new Set<string>();
  const add = (hrId: string | null | undefined) => {
    const key = personKey(hrId);
    if (!key || key === self || seen.has(key)) return;
    seen.add(key);
    cc.push(key);
  };

  if (salesSeats.length > 0) {
    for (const seat of salesSeats) {
      for (const member of managerChain(input.orgIndex, seat.seatId)) add(member.hrId);
    }
  } else {
    add(input.directManagerHrId);
  }

  return cc;
}

async function loadDirectManagerHrIdDefault(employeeHrId: string): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("manager_hr_id")
      .eq("hr_id", employeeHrId)
      .maybeSingle();
    if (error) throw error;
    return (data as { manager_hr_id?: string | null } | null)?.manager_hr_id ?? null;
  } catch (error) {
    logNotificationSendFailure("deductions.loadDirectManager", error);
    return null;
  }
}

/**
 * The pushed line, as little of it as the notice needs.
 *
 * `amount`, `daysCount` and `dates` carry the detail the EMAIL names (owner, 2026-10-12). They are
 * optional on purpose: a caller that genuinely cannot resolve the figure passes nothing and the
 * email then omits that row rather than mailing a confident `0.00` — a deduction email stating the
 * wrong amount is worse than one that leaves it to the portal.
 */
export type DeductionPushNoticeLine = {
  id: string;
  employeeHrId: string;
  employeeName: string | null;
  monthKey: string;
  category: DeductionsCategory;
  /** EGP charged. Null/undefined → the email names no figure. */
  amount?: number | null;
  /** Days charged (0.5 for a half day). Null/undefined → the email names no day count. */
  daysCount?: number | null;
  /** The exact days charged, so the email can list them instead of only counting them. */
  dates?: readonly string[];
  /** What makes this notice "already sent". Defaults to the line id; the DAILY page passes the id
   * plus the days, so releasing 11 November after the 9th tells the employee again. */
  noticeKey?: string;
};

/**
 * How many days the email should say — "1 day", "3 days", and "half a day" for the 0.5 a
 * `crm_half_day` line carries, because "0.5 days" in a letter about someone's pay reads like a
 * system string rather than a sentence.
 */
function formatDaysCharged(daysCount: number): string {
  const rounded = Math.round(daysCount * 100) / 100;
  if (rounded === 0.5) return "half a day";
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

/**
 * The detail rows the EMAIL carries. Every row is omitted rather than guessed: an absent amount, an
 * absent day count and an empty date list each simply do not appear.
 *
 * Capped at 10 named days with a remainder count — a month of unpunched days would otherwise fill
 * the mail with a date list nobody reads, and the portal holds the full list.
 */
export function buildDeductionEmailMetrics(
  line: DeductionPushNoticeLine,
  monthLabel: string,
): { label: string; value: string }[] {
  const metrics: { label: string; value: string }[] = [
    { label: "Employee", value: line.employeeName?.trim() || line.employeeHrId },
    { label: "Month", value: monthLabel },
    { label: "Reason", value: deductionCategoryName(line.category) },
  ];

  if (typeof line.daysCount === "number" && Number.isFinite(line.daysCount) && line.daysCount > 0) {
    metrics.push({ label: "Days deducted", value: formatDaysCharged(line.daysCount) });
  }
  if (typeof line.amount === "number" && Number.isFinite(line.amount)) {
    metrics.push({
      label: "Amount deducted",
      value: formatCurrencyValue(line.amount, null, { maximumFractionDigits: 2, minimumFractionDigits: 2 }),
    });
  }

  const days = (line.dates ?? []).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day))).slice().sort();
  if (days.length > 0) {
    const shown = days.slice(0, 10).map((day) => formatPhoenixLongDate(day));
    const more = days.length - shown.length;
    metrics.push({
      label: days.length === 1 ? "Day charged" : "Days charged",
      value: more > 0 ? `${shown.join("; ")}; and ${more} more` : shown.join("; "),
    });
  }

  return metrics;
}

/**
 * The one sentence the employee's EMAIL opens with — amount and reason in words (owner, 2026-10-12).
 * The in-app and Telegram copies deliberately say none of this.
 */
export function buildDeductionEmailSummary(line: DeductionPushNoticeLine, monthLabel: string): string {
  const reason = deductionCategoryName(line.category);
  const amount =
    typeof line.amount === "number" && Number.isFinite(line.amount)
      ? formatCurrencyValue(line.amount, null, { maximumFractionDigits: 2, minimumFractionDigits: 2 })
      : null;
  const days =
    typeof line.daysCount === "number" && Number.isFinite(line.daysCount) && line.daysCount > 0
      ? formatDaysCharged(line.daysCount)
      : null;

  const charged = [amount, days && `${days} deducted`].filter(Boolean).join(" · ");
  const opening = charged
    ? `A payroll deduction of ${charged} has been recorded on your account for ${monthLabel}.`
    : `A payroll deduction has been recorded on your account for ${monthLabel}.`;
  return `${opening} Reason: ${reason}. Open your Deductions page for the full record, and speak to your manager or HR if you believe this is wrong.`;
}

export type DeductionPushNotificationResult = {
  /** What to stamp on the line's notification_status. */
  status: "sent" | "failed" | "skipped";
  employeeNotified: boolean;
  ccHrIds: string[];
  error?: string;
};

type SendFn = typeof createSystemNotification;
type SendManyFn = typeof createSystemNotificationForRecipients;

/** "sent" if any channel delivered, "failed" if a channel errored and none delivered, else "skipped". */
function statusFromResult(result: SystemNotificationResult | null): "sent" | "failed" | "skipped" {
  const deliveries = result?.deliveries ?? [];
  if (deliveries.some((delivery) => delivery.status === "sent")) return "sent";
  if (deliveries.some((delivery) => delivery.status === "failed")) return "failed";
  return "skipped";
}

/**
 * Notify one pushed deduction. Best-effort by contract: the DB write already happened, so a
 * notification failure must never throw back into the push — it is recorded on the line instead.
 */
export async function notifyDeductionPushed(input: {
  line: DeductionPushNoticeLine;
  actorHrId: string | null;
  send?: SendFn;
  sendToRecipients?: SendManyFn;
  loadOrg?: () => Promise<OrgIndex>;
  loadDirectManagerHrId?: (employeeHrId: string) => Promise<string | null>;
  loadShownName?: (employeeHrId: string) => Promise<string | null>;
}): Promise<DeductionPushNotificationResult> {
  const send = input.send ?? createSystemNotification;
  const sendToRecipients = input.sendToRecipients ?? createSystemNotificationForRecipients;
  const loadOrg = input.loadOrg ?? loadPhoenixCrmOrg;
  const loadDirectManagerHrId = input.loadDirectManagerHrId ?? loadDirectManagerHrIdDefault;

  // The line's stored name stays raw, because payroll reads it. The notice prints the name the
  // person goes by, and a failed read falls back to the stored one rather than losing the notice.
  const loadShownName =
    input.loadShownName ?? (async (hrId: string) => (await namesByHrId([hrId])).get(hrId));
  const shownName = await loadShownName(input.line.employeeHrId).catch(() => null);
  const line = shownName ? { ...input.line, employeeName: shownName } : input.line;
  const monthLabel = formatDeductionMonthLabel(line.monthKey);
  const employeeName = line.employeeName?.trim() || line.employeeHrId;

  // The employee. recipient === subject, so the sensitive-module gate lets it through directly.
  //
  // `title`/`message` are what IN-APP and TELEGRAM render — still no amount and no category, because
  // a bell badge and a lock screen are read by whoever holds the phone. The `email` block below
  // overrides subject/summary/metrics for the EMAIL alone (buildChannelEmailInput prefers
  // `input.email?.*` over the rendered channel content), which is where the owner's 2026-10-12
  // decision puts the figure, the reason and the days.
  let employeeResult: SystemNotificationResult | null = null;
  try {
    employeeResult = await send({
      module: "deductions",
      eventType: "deduction_pushed",
      channels: ["in_app", "email", "telegram"],
      recipientHrId: line.employeeHrId,
      subjectHrId: line.employeeHrId,
      actorId: input.actorHrId ?? null,
      actionUrl: DEDUCTIONS_PORTAL_HREF,
      title: "Payroll deduction recorded",
      message: `A payroll deduction has been recorded on your account for ${monthLabel}. Open your Deductions page to view the details.`,
      email: {
        ctaLabel: "Open my Deductions",
        metrics: buildDeductionEmailMetrics(line, monthLabel),
        subject: `Payroll deduction recorded — ${monthLabel}`,
        summary: buildDeductionEmailSummary(line, monthLabel),
        // Pinned: without it the module/type mapping frames the mail, and a template whose fixed
        // body talks about something else would bury the amount this email exists to state.
        templateKey: "general",
        title: "Payroll deduction recorded",
        tone: "warning",
      },
      metadata: {
        idempotencyKey: `deduction-pushed:${line.noticeKey ?? line.id}`,
        monthKey: line.monthKey,
        lineId: line.id,
      },
    });
  } catch (error) {
    logNotificationSendFailure("deductions.notifyEmployee", error);
  }

  // The manager chain. authorizedRecipient lets a non-subject recipient receive a deductions-module
  // notice (the module is sensitive; without it the orchestrator fails closed). No amount, no
  // destination — the manager cannot open a self-only portal, this is a heads-up.
  //
  // AND NO EMAIL, deliberately, after the 2026-10-12 change: there is no `email` block and no email
  // channel here, so a manager's inbox cannot carry a colleague's deduction even if a template were
  // added later. His decision widened what the EMPLOYEE's own email says, not who sees the figure.
  let ccHrIds: string[] = [];
  try {
    const orgIndex = await loadOrg();
    const directManagerHrId = await loadDirectManagerHrId(line.employeeHrId);
    ccHrIds = resolveDeductionNotificationCc({
      employeeHrId: line.employeeHrId,
      orgIndex,
      directManagerHrId,
    });
    if (ccHrIds.length > 0) {
      await sendToRecipients(
        {
          module: "deductions",
          eventType: "deduction_pushed_cc",
          channels: ["in_app", "telegram"],
          subjectHrId: line.employeeHrId,
          actorId: input.actorHrId ?? null,
          title: "Deduction recorded for a team member",
          message: `A payroll deduction has been recorded for ${employeeName} for ${monthLabel}.`,
          metadata: {
            authorizedRecipient: true,
            idempotencyKey: `deduction-pushed-cc:${line.noticeKey ?? line.id}`,
            monthKey: line.monthKey,
            lineId: line.id,
            subjectEmployeeName: employeeName,
          },
        },
        ccHrIds,
      );
    }
  } catch (error) {
    logNotificationSendFailure("deductions.notifyManagers", error);
  }

  const status = statusFromResult(employeeResult);
  return {
    status,
    employeeNotified: status === "sent",
    ccHrIds,
    error: employeeResult ? undefined : "employee notification did not run",
  };
}
