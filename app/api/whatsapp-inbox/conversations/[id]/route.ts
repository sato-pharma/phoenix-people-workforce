import { NextResponse } from "next/server";

import { inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import { requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { assertInboxConversationVisibleTo, loadInboxThread } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One chat's messages, oldest first, and whether Phoenix can write in it right now. Super Admin only. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): a chat with an HR applicant answers as if absent.
    await assertInboxConversationVisibleTo(access, id);
    return NextResponse.json(await loadInboxThread(id));
  } catch (error) {
    return inboxApiError(error, "Failed to load the WhatsApp chat.");
  }
}
