import { NextResponse } from "next/server";

import { runApprovalWhatsAppReminders } from "@/lib/approvals/urgent-whatsapp";
import { APPROVAL_REMINDER_JOB_SLUG } from "@/lib/approvals/urgent-whatsapp-rules";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The WhatsApp reminder to each approver holding something more than three days (owner, 3 Nov 2026).
 *
 * Five ticks at 10:xx Cairo, every day, so the heartbeat stays a straight daily one. The run sends nothing on a Friday
 * or Saturday, and nothing until the switch, the third number and Meta's approval are all in place. At most eight sends
 * a tick and one message per person per Cairo day. The rules are in src/lib/approvals/urgent-whatsapp-rules.ts.
 *
 * `?dryRun=1` reports the counts and sends nothing.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/approval-whatsapp-reminders");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const result = dryRun
      ? await runApprovalWhatsAppReminders({ dryRun: true })
      : await withDeadMansSwitch(APPROVAL_REMINDER_JOB_SLUG, () => runApprovalWhatsAppReminders());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Approval reminders failed", {
      error,
      labels: { event: "cron_failed", job: "approval-whatsapp-reminders" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Approval reminders failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
