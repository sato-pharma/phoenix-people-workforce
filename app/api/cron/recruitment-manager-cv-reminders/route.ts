import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runManagerCvReminders } from "@/lib/recruitment/manager-cv-reminders";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The folder that keeps reminding until its CV is opened (owner, 2026-10-16: "the folder pumps
 * notifications and never stop until the cv is seen").
 *
 * Hourly. Between 08:00 and 21:59 Cairo, tells each manager who holds folders which CVs sent to the
 * manager are not yet opened — one message per manager, in-app, Telegram and push, never email. A CV
 * leaves the message when the manager opens it, when Talent Acquisition takes it back, or at its 45
 * days. A manager with nothing unopened is told nothing, so most fires send nothing at all.
 *
 * `?dryRun=1` reports who would be reminded and sends nothing.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/recruitment-manager-cv-reminders");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const result = dryRun
      ? await runManagerCvReminders({ dryRun: true })
      : await withDeadMansSwitch("phoenix-recruitment-manager-cv-reminders", () => runManagerCvReminders());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("Manager CV folder reminders failed", {
      error,
      labels: { event: "cron_failed", job: "recruitment-manager-cv-reminders" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Manager CV folder reminders failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
