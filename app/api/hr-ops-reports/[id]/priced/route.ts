import { NextResponse, type NextRequest } from "next/server";

import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { hrOpsErrorResponse, reportIdOrNull } from "@/lib/hr-ops-reports/http";
import { priceReportLines } from "@/lib/hr-ops-reports/pricing";
import { getReport, getReportLines } from "@/lib/hr-ops-reports/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The person-day columns and the flags ride along: a day decided in another report is carried (priced
// where it was decided), and an office day the weekly review never lists is "Not carried" (no amount).
const PRICED_COLUMNS =
  "id,report_id,section,hr_key,hr_id,work_date,flags,decision,decided_days,review_action,recommended_days,suggested_days,carried_from_line_id";

// What each row's days would cost — THE HR MANAGER'S VIEW ONLY. `approve` is the Super Admin's
// alone, and a salary-blind seat is refused on top of it, so the amount cannot reach the reviewer
// even if a grant were widened by mistake.
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_ops_reports", "approve");
    if (isSalaryBlindRole(access.role)) {
      return NextResponse.json({ message: "Forbidden: this seat never sees an amount." }, { status: 403 });
    }

    const id = reportIdOrNull((await context.params).id);
    if (!id) return NextResponse.json({ message: "That report does not exist." }, { status: 404 });
    const report = await getReport(id);
    if (!report) return NextResponse.json({ message: "That report does not exist." }, { status: 404 });
    // A total that could not be worked out is null with its reason — never "EGP 0.00" (pricing.ts).
    return NextResponse.json(await priceReportLines(await getReportLines(id, PRICED_COLUMNS, true)));
  } catch (error) {
    return hrOpsErrorResponse(error, "Failed to price the report.");
  }
}
