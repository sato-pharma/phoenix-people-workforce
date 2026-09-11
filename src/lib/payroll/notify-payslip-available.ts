import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * TELLING AN EMPLOYEE THEIR PAYSLIP IS READY — the one notification that reaches the whole company.
 *
 * A payslip becomes visible the moment its batch is approved (`publishedPayslipStatuses` includes
 * `approved` and `locked`). This notification is what tells the employee that happened.
 *
 * WHY IT LIVES HERE. It used to be a private helper inside `app/api/payroll/[id]/workflow/route.ts`,
 * reachable only from the OLD payroll module's Approve button. Automated Payroll — the live payroll
 * path since July 2026 — approves its batch with a direct database write, so the notification never
 * fired for it. Measured on production: the event type carries 123 records, all dated 13 July 2026,
 * the last time the old module approved a batch, and none since. The two automated publishes on
 * 10 August and 8 September covered 105 and 100 people and produced two notifications between them,
 * both to finance. **205 employees were never told their payslip was ready.**
 *
 * Business logic in a route file is why: there was no way for a second caller to reach it, so the
 * second caller silently did without. One copy, in the domain, called by both.
 *
 * THE OWNER RULE THIS MUST NOT BREAK. A payslip is NEVER emailed. Delivery is in-app and a generic
 * Telegram nudge only, and there is deliberately no `email` block on the payload so it cannot
 * carry payslip content even by accident. `payslip-channel-guard` strips the email channel as a
 * hard backstop regardless of what any caller asks for. Push is separately allowed by the owner's
 * 2026-07-25 override and comes from the policy row, not from here.
 *
 * BEST EFFORT, BUT NEVER SILENT. It cannot throw: by the time it runs, money has been committed and
 * payslips exist, and a notification outage must not present a completed payroll as failed. But
 * "best effort" is how the original became invisible, so it RETURNS what happened and the caller
 * records that in its audit row. A month that notified nobody should be readable as such afterwards.
 */

/**
 * The text of a failure, whatever shape it arrived in.
 *
 * Supabase returns a PostgrestError — a plain object with `message`, NOT an `Error` instance — so
 * the obvious `error instanceof Error ? error.message : String(error)` renders the one useful fact
 * as "[object Object]". The whole point of reporting this is that a person can read it.
 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export type PayslipNoticeResult = {
  /** Employees the notification was created for. */
  notified: number;
  /** Employees it was attempted for and failed. */
  failed: number;
  /** Set when the roster could not be read at all — `notified` is then meaningless, not zero. */
  error: string | null;
};

/** The one call this module makes. Injectable so a test can assert the payload without sending. */
export type PayslipNoticeSender = (
  input: Parameters<typeof createSystemNotification>[0],
) => Promise<unknown>;

export async function notifyPayslipAvailable(input: {
  batchId: string;
  client?: ReturnType<typeof getSupabaseAdmin>;
  /**
   * Defaults to the real notifier. A test MUST pass its own: the suite runs with production
   * credentials, so reaching the real one would notify real employees and burn the idempotency
   * key for a month that has not been published.
   */
  send?: PayslipNoticeSender;
}): Promise<PayslipNoticeResult> {
  const supabase = input.client ?? getSupabaseAdmin();
  const send: PayslipNoticeSender = input.send ?? createSystemNotification;

  let hrIds: string[] = [];
  try {
    const { data, error } = await supabase.from("salary_records").select("hr_id").eq("batch_id", input.batchId);
    if (error) throw error;
    hrIds = Array.from(
      new Set(
        (data ?? [])
          .map((row) => String((row as { hr_id: string | null }).hr_id ?? "").trim())
          .filter(Boolean),
      ),
    );
  } catch (error) {
    logError("Payroll: could not read the batch roster to announce payslips", {
      labels: { event: "payslip_available_roster_read_failed", batchId: input.batchId },
      error,
    });
    return { notified: 0, failed: 0, error: errorText(error) };
  }

  const outcomes = await Promise.all(
    hrIds.map(async (hrId) => {
      try {
        await send({
          actionUrl: "/payslips",
          // Payslips are NEVER emailed (owner rule) — in-app + generic Telegram only. No email:{}
          // block, so the payload cannot carry payslip email content, and the notification-layer
          // guard strips the email channel as a hard backstop regardless.
          channels: ["in_app", "telegram"],
          eventType: "payslip_available",
          message: "Your payslip is now available to view.",
          metadata: {
            batchId: input.batchId,
            // Per batch AND per person, so re-publishing a month cannot tell anybody twice.
            idempotencyKey: `payroll-payslip-available:${input.batchId}:${hrId}`,
            sensitivity: "payroll",
          },
          module: "payroll",
          priority: "high",
          recipientHrId: hrId,
          recordId: input.batchId,
          subjectHrId: hrId,
          title: "Payslip Available",
        });
        return true;
      } catch (error) {
        logError("Payroll: could not tell one employee their payslip is ready", {
          labels: { event: "payslip_available_send_failed", batchId: input.batchId, hrId },
          error,
        });
        return false;
      }
    }),
  );

  return {
    notified: outcomes.filter(Boolean).length,
    failed: outcomes.filter((sent) => !sent).length,
    error: null,
  };
}
