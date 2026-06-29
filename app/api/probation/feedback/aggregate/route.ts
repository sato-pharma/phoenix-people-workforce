import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getAggregateFeedbackReport } from "@/lib/probation/feedback-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertPermission(access, "probation", "read");

    const rows = await getAggregateFeedbackReport(access);
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (isForbiddenError(err)) return NextResponse.json({ error: String(err) }, { status: 403 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
