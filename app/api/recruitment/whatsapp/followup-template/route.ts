import { NextResponse } from "next/server";

import { followupTemplateStatus } from "@/lib/recruitment/inbound/whatsapp-followup-template";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the "Ask again" WhatsApp template stands with Meta — `{ status, label }`, status one of
 * approved · pending · rejected · missing. The button says "Waiting for Meta approval" and sends
 * nothing until it reads `approved`. Read from Meta at most every ten minutes.
 */
export async function GET(request: Request) {
  try {
    await requireRecruitmentAccess(request, "candidates", "read");
    return NextResponse.json(await followupTemplateStatus());
  } catch (error) {
    return recruitmentApiError(error, "Could not read the WhatsApp template's status.");
  }
}
