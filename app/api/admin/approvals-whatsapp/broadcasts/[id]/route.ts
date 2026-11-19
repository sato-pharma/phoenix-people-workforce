import { NextResponse } from "next/server";

import { approvalsApiError, approvalsWhatsAppForbidden } from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { loadApprovalsBroadcastReport } from "@/lib/approvals-whatsapp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One bulk send's report: each recipient by name with sent, delivered, read, failed or replied and when. Super Admin only. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const { id } = await params;
    return NextResponse.json(await loadApprovalsBroadcastReport(id));
  } catch (error) {
    return approvalsApiError(error, "Failed to load the report.");
  }
}
