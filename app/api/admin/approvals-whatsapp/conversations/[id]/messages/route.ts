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
import { sendApprovalsMedia, sendApprovalsTemplate, sendApprovalsText } from "@/lib/approvals-whatsapp/send";
import { INBOX_UPLOAD_MAX_BYTES } from "@/lib/whatsapp-inbox/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Sends one message in a chat on the approvals line. Super Admin only.
 *
 *   JSON { kind: "text", text }                               — inside the 24-hour window only
 *   JSON { kind: "template", templateName, language, values } — any time; counts towards the daily limit
 *   multipart { file, caption? }                              — a photo or file, inside the window only
 *
 * Nothing retries: a duplicate of a message is worse than a failure the owner can see.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > INBOX_UPLOAD_MAX_BYTES + 64_000) {
        return approvalsProblem("Files over 25 MB cannot be sent from this screen.", 413);
      }
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return approvalsProblem("Choose a file to send.", 400);
      if (file.size > INBOX_UPLOAD_MAX_BYTES) return approvalsProblem("Files over 25 MB cannot be sent from this screen.", 413);
      const bytes = Buffer.from(await file.arrayBuffer());
      const sent = await sendApprovalsMedia({
        access,
        bytes,
        caption: text(form.get("caption")),
        conversationId: id,
        fileName: file.name || "attachment",
        mimeType: file.type || "application/octet-stream",
      });
      await writeAuditLog({
        actorLoginId: approvalsActor(access),
        entityId: id,
        entityType: "approvals_whatsapp_message",
        newValues: { byteSize: bytes.length, fileName: file.name, kind: "media", mimeType: file.type, wamid: sent.wamid },
        summary: "Sent a file on WhatsApp from the approvals line.",
      });
      return NextResponse.json({ success: true, wamid: sent.wamid }, { status: 201 });
    }

    const body = await readJsonBody(request);
    const kind = text(body.kind);
    if (kind === "text") {
      const message = typeof body.text === "string" ? body.text : "";
      const sent = await sendApprovalsText({ access, conversationId: id, replyToWamid: text(body.replyToWamid), text: message });
      await writeAuditLog({
        actorLoginId: approvalsActor(access),
        entityId: id,
        entityType: "approvals_whatsapp_message",
        newValues: { kind: "text", length: message.trim().length, wamid: sent.wamid },
        summary: "Sent a WhatsApp reply from the approvals line.",
      });
      return NextResponse.json({ success: true, wamid: sent.wamid }, { status: 201 });
    }
    if (kind === "template") {
      const templateName = text(body.templateName);
      const language = text(body.language);
      if (!templateName || !language) return approvalsProblem("Pick an approved wording to send.", 400);
      const sent = await sendApprovalsTemplate({ access, conversationId: id, language, templateName, values: valuesObject(body.values) });
      await writeAuditLog({
        actorLoginId: approvalsActor(access),
        entityId: id,
        entityType: "approvals_whatsapp_message",
        newValues: { kind: "template", language, templateName, wamid: sent.wamid },
        summary: `Sent the approved wording ${templateName} from the approvals line.`,
      });
      return NextResponse.json({ success: true, wamid: sent.wamid }, { status: 201 });
    }
    return approvalsProblem("Unknown kind of message.", 400);
  } catch (error) {
    return approvalsApiError(error, "Failed to send the WhatsApp message.");
  }
}
