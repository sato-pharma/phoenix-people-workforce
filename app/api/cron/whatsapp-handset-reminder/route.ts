import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runWhatsAppHandsetReminder } from "@/lib/recruitment/inbound/whatsapp-handset-reminder";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 10:37 Cairo, every day including Friday (owner, 2026-11-03): remind the Super Admin before the HR
 * handset's 14-day limit. Under seven days since the last send it says nothing and still reports. The
 * stages are in src/lib/recruitment/inbound/whatsapp-handset-clock.ts.
 *
 * `?dryRun=1` reports today's stage and sends nothing.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/whatsapp-handset-reminder");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const result = dryRun
      ? await runWhatsAppHandsetReminder({ dryRun: true })
      : await withDeadMansSwitch("phoenix-whatsapp-handset-reminder", () => runWhatsAppHandsetReminder());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("WhatsApp handset reminder failed", {
      error,
      labels: { event: "cron_failed", job: "whatsapp-handset-reminder" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "WhatsApp handset reminder failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
