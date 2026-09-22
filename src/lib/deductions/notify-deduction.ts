// Unified Deductions module: the per-line PUSH notification.
//
// Owner rule (2026-09-22): a deduction is functioning but NEVER automatic. When the Super Admin
// PUSHES one employee's one deduction, that employee is told — in-app + Telegram, never email —
// and the notice CCs their manager chain:
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
// NO AMOUNT, NO CATEGORY reaches any channel (owner rule): the notice says a deduction was recorded
// for a month and points the employee at their own Deductions page. The figure lives behind the
// self-only portal, never on a lock screen. Managers get a bare heads-up with the employee's NAME
// (never the HR code) and no destination — the portal is self-only, so there is nothing for them to
// open.
//
// Everything is INJECTABLE so the tests never touch production: the real senders would notify real
// employees and burn the per-line idempotency key. `send`/`sendToRecipients` default to the live
// orchestrator; the loaders default to the live org tree and employees table.

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

import type { DeductionsCategory } from "./types.ts";

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

/** The minimal pushed-line shape the notice needs — never the amount. */
export type DeductionPushNoticeLine = {
  id: string;
  employeeHrId: string;
  employeeName: string | null;
  monthKey: string;
  category: DeductionsCategory;
};

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
}): Promise<DeductionPushNotificationResult> {
  const send = input.send ?? createSystemNotification;
  const sendToRecipients = input.sendToRecipients ?? createSystemNotificationForRecipients;
  const loadOrg = input.loadOrg ?? loadPhoenixCrmOrg;
  const loadDirectManagerHrId = input.loadDirectManagerHrId ?? loadDirectManagerHrIdDefault;

  const { line } = input;
  const monthLabel = formatDeductionMonthLabel(line.monthKey);
  const employeeName = line.employeeName?.trim() || line.employeeHrId;

  // The employee. recipient === subject, so the sensitive-module gate lets it through directly.
  // No amount, no category — the figure is on their own Deductions page.
  let employeeResult: SystemNotificationResult | null = null;
  try {
    employeeResult = await send({
      module: "deductions",
      eventType: "deduction_pushed",
      channels: ["in_app", "telegram"],
      recipientHrId: line.employeeHrId,
      subjectHrId: line.employeeHrId,
      actorId: input.actorHrId ?? null,
      actionUrl: DEDUCTIONS_PORTAL_HREF,
      title: "Payroll deduction recorded",
      message: `A payroll deduction has been recorded on your account for ${monthLabel}. Open your Deductions page to view the details.`,
      metadata: {
        idempotencyKey: `deduction-pushed:${line.id}`,
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
            idempotencyKey: `deduction-pushed-cc:${line.id}`,
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
