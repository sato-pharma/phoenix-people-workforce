import { NextResponse } from "next/server";

import {
  approvalsActor,
  approvalsApiError,
  approvalsProblem,
  approvalsWhatsAppForbidden,
  readJsonBody,
  text,
  valuesObject,
} from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { writeAuditLog } from "@/lib/admin/audit";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { startApprovalsConversation } from "@/lib/approvals-whatsapp/send";
import { APPROVALS_LINE_DISPLAY_NUMBER, listApprovalsConversations } from "@/lib/approvals-whatsapp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The approvals line's chats, newest first. Super Admin only. `?q=` searches name or number; `?state=unread`. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const url = new URL(request.url);
    const result = await listApprovalsConversations({
      search: url.searchParams.get("q"),
      state: url.searchParams.get("state") === "unread" ? "unread" : "all",
    });
    return NextResponse.json({ ...result, lineDisplayNumber: APPROVALS_LINE_DISPLAY_NUMBER });
  } catch (error) {
    return approvalsApiError(error, "Failed to load the WhatsApp chats.");
  }
}

/** Starts a chat with a number, with an approved wording — the only first message WhatsApp allows. Super Admin only. */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const body = await readJsonBody(request);
    const phone = text(body.phone);
    const templateName = text(body.templateName);
    const language = text(body.language);
    if (!phone) return approvalsProblem("Type the number to write to.", 400);
    if (!templateName || !language) return approvalsProblem("Pick an approved wording to send.", 400);
    const started = await startApprovalsConversation({ access, language, phone, templateName, values: valuesObject(body.values) });
    await writeAuditLog({
      actorLoginId: approvalsActor(access),
      entityId: started.conversationId,
      entityType: "approvals_whatsapp_message",
      newValues: { kind: "template", language, templateName, wamid: started.wamid },
      summary: `Started a WhatsApp chat on the approvals line with the wording ${templateName}.`,
    });
    return NextResponse.json({ success: true, ...started }, { status: 201 });
  } catch (error) {
    return approvalsApiError(error, "Failed to start the WhatsApp chat.");
  }
}
