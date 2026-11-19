import { NextResponse } from "next/server";

import { approvalsApiError, approvalsWhatsAppForbidden, readJsonBody } from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { setApprovalsConversationRead } from "@/lib/approvals-whatsapp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Marks a chat read (`{ unread: false }`) or unread again (`{ unread: true }`) in Phoenix only. Super Admin only. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    const body = await readJsonBody(request);
    return NextResponse.json({ success: true, ...(await setApprovalsConversationRead(id, body.unread === true)) });
  } catch (error) {
    return approvalsApiError(error, "Failed to update the chat.");
  }
}
