import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError, logWarning } from "@/lib/observability/log";
import { settleFinishedInterviewOutcomes } from "@/lib/recruitment/interview-outcome-settle";
import { runInterviewReminders } from "@/lib/recruitment/interview-reminders";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The settle starts no new write this long after it begins, so it never holds the reminders up for long.
 * It is AWAITED, never raced: a settle left running behind the reminders would report nothing settled,
 * let them nag about an interview it was about to answer, and overlap the next run.
 */
const SETTLE_BUDGET_MS = 15_000;

async function settleWithinBudget() {
  const run = await settleFinishedInterviewOutcomes(new Date(), { deadlineMs: Date.now() + SETTLE_BUDGET_MS }).catch((error) => {
    logError("Interview outcome settling failed", { error, labels: { event: "settle_failed", job: "interview-reminders" } });
    return null;
  });
  if (run?.stoppedEarly) {
    logWarning("Interview outcome settling reached its time budget; the rest is settled on the next run", {
      labels: { event: "settle_over_budget", job: "interview-reminders" },
    });
  }
  return run;
}

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
      // or a slow run here must not stop the reminders themselves.
      const settledNow = await settleWithinBudget();
      return {
        ...(await runInterviewReminders()),
        // Null when the settle failed: "nothing settled" and "could not settle" are not the same answer.
        outcomesSettled: settledNow ? settledNow.settled.length : null,
        outcomesSettleStoppedEarly: settledNow?.stoppedEarly ?? false,
      };
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
