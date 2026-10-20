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
import { INBOX_UPLOAD_MAX_BYTES } from "@/lib/whatsapp-inbox/graph";
import { sendInboxMedia, sendInboxTemplate, sendInboxText } from "@/lib/whatsapp-inbox/send";
import { assertInboxConversationVisibleTo } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Sends one message in a chat, from the number that chat is on. Super Admin only.
 *
 *   JSON { kind: "text", text }                               — inside the 24-hour window only
 *   JSON { kind: "template", templateName, language, values } — any time; billed by Meta
 *   multipart { file, caption? }                              — a photo or file, inside the window only
 *
 * Nothing retries: a duplicate of a person's message is worse than a failure they can see.
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

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > INBOX_UPLOAD_MAX_BYTES + 64_000) {
        return recruitmentProblem("Files over 25 MB cannot be sent from the inbox.", 413);
      }
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return recruitmentProblem("Choose a file to send.", 400);
      if (file.size > INBOX_UPLOAD_MAX_BYTES) return recruitmentProblem("Files over 25 MB cannot be sent from the inbox.", 413);
      const bytes = Buffer.from(await file.arrayBuffer());
      const sent = await sendInboxMedia({
        access,
        bytes,
        caption: str(form.get("caption")),
        conversationId: id,
        fileName: file.name || "attachment",
        mimeType: file.type || "application/octet-stream",
      });
      await writeRequiredAuditLog({
        actorLoginId: inboxActor(access),
        entityId: id,
        entityType: "whatsapp_inbox_message",
        newValues: { byteSize: bytes.length, fileName: file.name, kind: "media", mimeType: file.type, wamid: sent.wamid },
        summary: "Sent a file on WhatsApp from the WhatsApp Inbox.",
      });
      return NextResponse.json({ success: true, wamid: sent.wamid }, { status: 201 });
    }

    const body = await readJsonObject(request);
    const kind = str(body.kind);

    if (kind === "text") {
      const text = typeof body.text === "string" ? body.text : "";
      const sent = await sendInboxText({ access, conversationId: id, replyToWamid: str(body.replyToWamid), text });
      await writeRequiredAuditLog({
        actorLoginId: inboxActor(access),
        entityId: id,
        entityType: "whatsapp_inbox_message",
        newValues: { kind: "text", length: text.trim().length, wamid: sent.wamid },
        summary: "Sent a WhatsApp reply from the WhatsApp Inbox.",
      });
      return NextResponse.json({ success: true, wamid: sent.wamid }, { status: 201 });
    }

    if (kind === "template") {
      const templateName = str(body.templateName) ?? "";
      const language = str(body.language) ?? "";
      if (!templateName || !language) return recruitmentProblem("Pick a template to send.", 400);
      const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? (body.values as Record<string, unknown>) : null;
      const sent = await sendInboxTemplate({ access, conversationId: id, language, templateName, values });
      await writeRequiredAuditLog({
        actorLoginId: inboxActor(access),
        entityId: id,
        entityType: "whatsapp_inbox_message",
        newValues: { kind: "template", language, templateName, wamid: sent.wamid },
        summary: `Sent an approved WhatsApp template (${templateName}) from the WhatsApp Inbox.`,
      });
      return NextResponse.json({ success: true, wamid: sent.wamid }, { status: 201 });
    }

    return recruitmentProblem("Unknown kind of message.", 400);
  } catch (error) {
    return inboxApiError(error, "Failed to send the WhatsApp message.");
  }
}
