import { NextResponse } from "next/server";

import { approvalsApiError, approvalsWhatsAppForbidden } from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { loadApprovalsThread } from "@/lib/approvals-whatsapp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One chat's whole thread with every tick. Opening it sends NO read receipt. Super Admin only. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    return NextResponse.json(await loadApprovalsThread(id));
  } catch (error) {
    return approvalsApiError(error, "Failed to load the chat.");
  }
}
