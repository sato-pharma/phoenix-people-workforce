import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { listPendingApprovals } from "@/lib/pending-approvals/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthorized", message: "Authentication is required." }, { status: 401 });
    }

    const items = await listPendingApprovals(access);
    return NextResponse.json({ data: items, success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load pending approvals.";
    return NextResponse.json({ error: "pending_approvals_load_failed", message }, { status: 500 });
  }
}
