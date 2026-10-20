import { NextResponse } from "next/server";

import { inboxActor, inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { findWhatsAppInboxLine, whatsAppInboxLines } from "@/lib/whatsapp-inbox/lines";
import { startInboxConversation } from "@/lib/whatsapp-inbox/send";
import { listInboxConversations } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The chat list for both company numbers, or one. Super Admin only. */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;

    const url = new URL(request.url);
    const line = str(url.searchParams.get("line"));
    if (line && !findWhatsAppInboxLine(line)) return recruitmentProblem("Unknown WhatsApp number.", 400);
    const limit = Number(url.searchParams.get("limit"));
    const result = await listInboxConversations({
      // The Talent Acquisition fence (owner, 2026-10-20) is applied inside, by who is reading.
      access,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      phoneNumberId: line,
      area: url.searchParams.get("area"),
      position: url.searchParams.get("position"),
      region: url.searchParams.get("region"),
      search: url.searchParams.get("q"),
      unreadOnly: url.searchParams.get("unread") === "1",
    });
    return NextResponse.json({
      ...result,
      lines: whatsAppInboxLines().map((entry) => ({
        displayNumber: entry.displayNumber,
        label: entry.label,
        phoneNumberId: entry.phoneNumberId,
      })),
    });
  } catch (error) {
    return inboxApiError(error, "Failed to load the WhatsApp chats.");
  }
}

/**
 * Starts a chat with someone new. WhatsApp allows a business to write first only with an approved
 * template, so this sends one — billed by Meta — and the chat then appears in the list.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;

    const body = await readJsonObject(request);
    const phoneNumberId = str(body.line) ?? "";
    const phone = str(body.phone) ?? "";
    const templateName = str(body.templateName) ?? "";
    const language = str(body.language) ?? "";
    if (!templateName || !language) return recruitmentProblem("Pick a template to send.", 400);
    const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? (body.values as Record<string, unknown>) : null;

    const sent = await startInboxConversation({ access, language, phone, phoneNumberId, templateName, values });

    await writeRequiredAuditLog({
      actorLoginId: inboxActor(access),
      entityId: sent.conversationId,
      entityType: "whatsapp_inbox_message",
      newValues: {
        kind: "template",
        language,
        line: findWhatsAppInboxLine(phoneNumberId)?.label ?? phoneNumberId,
        newConversation: true,
        templateName,
        wamid: sent.wamid,
      },
      summary: `Started a WhatsApp chat with an approved template (${templateName}) from the WhatsApp Inbox.`,
    });

    return NextResponse.json({ conversationId: sent.conversationId, success: true, wamid: sent.wamid }, { status: 201 });
  } catch (error) {
    return inboxApiError(error, "Failed to start the WhatsApp chat.");
  }
}
