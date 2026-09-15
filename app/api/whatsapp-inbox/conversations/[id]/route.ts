import { NextResponse } from "next/server";

import { inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import { requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { loadInboxThread } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One chat's messages, oldest first, and whether Phoenix can write in it right now. Super Admin only. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    return NextResponse.json(await loadInboxThread(id));
  } catch (error) {
    return inboxApiError(error, "Failed to load the WhatsApp chat.");
  }
}
