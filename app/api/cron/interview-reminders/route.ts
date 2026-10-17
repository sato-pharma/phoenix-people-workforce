import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { settleFinishedInterviewOutcomes } from "@/lib/recruitment/interview-outcome-settle";
import { runInterviewReminders } from "@/lib/recruitment/interview-reminders";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Remind each person chosen to conduct an interview (owner, 2026-09-20): the evening before from
 * 5:00 PM Cairo with the day's list, and one hour before each interview — in-app, email and Telegram.
 *
 * Every ten minutes. Safe to run as often as you like or twice at once: each message carries an
 * idempotency key and the notification service delivers a key once, so a repeat tells nobody twice.
 * The evening list is a fresh key only when what is on it changed; a moved interview is a fresh key
 * for its new time.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/interview-reminders");
  if (denied) return denied;
  try {
    const result = await withDeadMansSwitch("phoenix-interview-reminders", async () => {
      // Settle first, so an interview the record already answers is never nagged about this run. A failure
      // here must not stop the reminders themselves.
      const settledNow = await settleFinishedInterviewOutcomes().catch((error) => {
        logError("Interview outcome settling failed", { error, labels: { event: "settle_failed", job: "interview-reminders" } });
        return null;
      });
      return { ...(await runInterviewReminders()), outcomesSettled: settledNow?.settled.length ?? 0 };
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Interview reminders failed", { error, labels: { event: "cron_failed", job: "interview-reminders" } });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Interview reminders failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
