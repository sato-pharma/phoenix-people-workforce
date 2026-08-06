import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { getCompanyMonthSummaryByCategory } from "@/lib/deductions/service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    // Company-wide totals across every employee — admin audience only. See the export route.
    assertDeductionsReadActor(access);

    const url = new URL(request.url);
    const monthKey = url.searchParams.get("monthKey");
    if (!monthKey) {
      throw new Error("Validation: monthKey query parameter is required (YYYY-MM).");
    }

    const summary = await getCompanyMonthSummaryByCategory({ monthKey });
    return NextResponse.json({ success: true, summary });
  } catch (error) {
    return jsonError(error, "Failed to load the company deduction summary.");
  }
}
