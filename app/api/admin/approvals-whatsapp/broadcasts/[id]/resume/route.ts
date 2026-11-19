import { NextResponse } from "next/server";

import { approvalsActor, approvalsApiError, approvalsWhatsAppForbidden } from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { resumeApprovalsBroadcast } from "@/lib/approvals-whatsapp/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends an interrupted bulk send to the recipients not yet tried. Nobody is sent twice. Super Admin only. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    const resumed = await resumeApprovalsBroadcast({ access, broadcastId: id });
    await writeRequiredAuditLog({
      actorLoginId: approvalsActor(access),
      entityId: id,
      entityType: "approvals_whatsapp_broadcast",
      newValues: { pending: resumed.pending, resumed: true },
      summary: `Resumed a WhatsApp bulk send for the ${resumed.pending} people not yet tried.`,
    });
    return NextResponse.json({ success: true, ...resumed });
  } catch (error) {
    return approvalsApiError(error, "Failed to resume the bulk send.");
  }
}
