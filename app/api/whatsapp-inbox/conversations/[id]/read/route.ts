import { NextResponse } from "next/server";

import { inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import { assertSameOriginMutation, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { assertInboxConversationVisibleTo, markInboxConversationRead } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Clears a chat's unread mark in Phoenix. Deliberately sends NO read receipt to WhatsApp: opening a
 * chat in Phoenix must not show blue ticks to the person on the other end.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): a chat with an HR applicant answers as if absent.
    await assertInboxConversationVisibleTo(access, id);
    const result = await markInboxConversationRead(id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return inboxApiError(error, "Failed to mark the chat as read.");
  }
}
