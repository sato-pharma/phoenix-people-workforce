import { NextResponse } from "next/server";

import {
  approvalsActor,
  approvalsApiError,
  approvalsWhatsAppForbidden,
  readJsonBody,
  text,
} from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveAccessContext } from "@/lib/auth/server";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { listApprovalsLists, saveApprovalsList } from "@/lib/approvals-whatsapp/store";
import { listMembersFromBody } from "@/app/api/admin/approvals-whatsapp/_lib/list-members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every saved broadcast list with its size. Super Admin only. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    return NextResponse.json({ lists: await listApprovalsLists() });
  } catch (error) {
    return approvalsApiError(error, "Failed to load the lists.");
  }
}

/** Saves a new named list: `{ name, description?, employeeHrIds?, pasted? }`. Super Admin only. */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const body = await readJsonBody(request);
    const members = await listMembersFromBody(body);
    const saved = await saveApprovalsList({
      actorHrId: hrIdForStorage(access.hrId) ?? access.loginId ?? null,
      description: text(body.description),
      members: members.recipients,
      name: text(body.name) ?? "",
    });
    await writeRequiredAuditLog({
      actorLoginId: approvalsActor(access),
      entityId: saved.id,
      entityType: "approvals_whatsapp_list",
      newValues: { memberCount: members.recipients.length, name: text(body.name) },
      summary: `Saved the WhatsApp broadcast list ${text(body.name)} (${members.recipients.length} people).`,
    });
    return NextResponse.json({ success: true, ...saved, skipped: members.skipped }, { status: 201 });
  } catch (error) {
    return approvalsApiError(error, "Failed to save the list.");
  }
}
