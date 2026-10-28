import { NextResponse } from "next/server";

import { inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import { assertSameOriginMutation, readJsonObject, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { assertInboxConversationVisibleTo, markInboxConversationRead, markInboxConversationUnread } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Marks a chat read (the default) or, with `{ unread: true }`, unread — the inbox's Mark as read and
 * Mark as unread. Deliberately sends NO read receipt to WhatsApp: opening or marking a chat in
 * Phoenix must not show blue ticks to the person on the other end.
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
    const body = await readJsonObject(request);
    if (body.unread === true) {
      const result = await markInboxConversationUnread(id);
      return NextResponse.json({ success: true, ...result });
    }
    const result = await markInboxConversationRead(id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return inboxApiError(error, "Failed to change whether the chat is read.");
  }
}
