import { NextResponse } from "next/server";

import { inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import { recruitmentProblem, requireRecruitmentAccess, str } from "@/app/api/recruitment/_lib/http";
import { listApprovedTemplates } from "@/lib/whatsapp-inbox/graph";
import { findWhatsAppInboxLine } from "@/lib/whatsapp-inbox/lines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The APPROVED templates one number can send, read live from that number's own WhatsApp business
 * account — a template approved on the other number cannot be sent from this one. Super Admin only.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;

    const line = findWhatsAppInboxLine(str(new URL(request.url).searchParams.get("line")));
    if (!line) return recruitmentProblem("Pick which WhatsApp number to send from.", 400);
    const templates = await listApprovedTemplates(line.businessAccountId);
    return NextResponse.json({
      emptyReason: templates.length === 0 ? `The ${line.label} has no approved templates yet. Create one in that number's WhatsApp Manager, and it appears here once Meta approves it.` : null,
      lineLabel: line.label,
      templates,
    });
  } catch (error) {
    return inboxApiError(error, "Failed to load the WhatsApp templates.");
  }
}
