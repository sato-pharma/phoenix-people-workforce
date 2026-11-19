import { NextResponse } from "next/server";

import {
  approvalsActor,
  approvalsApiError,
  approvalsWhatsAppForbidden,
  readJsonBody,
  text,
} from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { listMembersFromBody } from "@/app/api/admin/approvals-whatsapp/_lib/list-members";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveAccessContext } from "@/lib/auth/server";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { deleteApprovalsList, loadApprovalsListMembers, saveApprovalsList } from "@/lib/approvals-whatsapp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One list's members. Super Admin only. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    return NextResponse.json({ members: await loadApprovalsListMembers(id) });
  } catch (error) {
    return approvalsApiError(error, "Failed to load the list.");
  }
}

/** Replaces a list's name and members. Super Admin only. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    const body = await readJsonBody(request);
    const members = await listMembersFromBody(body);
    await saveApprovalsList({
      actorHrId: hrIdForStorage(access.hrId) ?? access.loginId ?? null,
      description: text(body.description),
      id,
      members: members.recipients,
      name: text(body.name) ?? "",
    });
    await writeRequiredAuditLog({
      actorLoginId: approvalsActor(access),
      entityId: id,
      entityType: "approvals_whatsapp_list",
      newValues: { memberCount: members.recipients.length, name: text(body.name) },
      summary: `Changed the WhatsApp broadcast list ${text(body.name)} (${members.recipients.length} people).`,
    });
    return NextResponse.json({ id, skipped: members.skipped, success: true });
  } catch (error) {
    return approvalsApiError(error, "Failed to save the list.");
  }
}

/** Deletes a list. A bulk send made from it keeps its own recipients and report. Super Admin only. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    await deleteApprovalsList(id);
    await writeRequiredAuditLog({
      actorLoginId: approvalsActor(access),
      entityId: id,
      entityType: "approvals_whatsapp_list",
      newValues: { deleted: true },
      summary: "Deleted a WhatsApp broadcast list on the approvals line.",
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return approvalsApiError(error, "Failed to delete the list.");
  }
}
