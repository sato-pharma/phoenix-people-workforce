import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { runWhatsAppReask } from "@/lib/recruitment/inbound/whatsapp-reask-quiet";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Re-ask an applicant who went quiet mid-way through the WhatsApp questions, once, while WhatsApp's
 * 24-hour window is still open (owner, 2026-10-20).
 *
 * Every 30 minutes. Does nothing until the switch on the Screening Questions screen is on — it starts
 * OFF — and the bot itself is on. Each due conversation is asked the question it is parked on, at
 * most 20 a run, and marked so it is never asked again. The rules are in
 * src/lib/recruitment/inbound/whatsapp-reask-quiet.ts.
 *
 * `?dryRun=1` reports who is due and sends nothing.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/recruitment-whatsapp-reask");
  if (denied) return denied;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const result = dryRun
      ? await runWhatsAppReask({ dryRun: true })
      : await withDeadMansSwitch("phoenix-recruitment-whatsapp-reask", () => runWhatsAppReask());
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logError("WhatsApp re-ask failed", {
      error,
      labels: { event: "cron_failed", job: "recruitment-whatsapp-reask" },
    });
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "WhatsApp re-ask failed.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
