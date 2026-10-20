import { NextResponse, type NextRequest } from "next/server";

import { cairoTodayIso } from "@/lib/attendance/working-days";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { buildHrOpsReport } from "@/lib/hr-ops-reports/build";
import { hrOpsErrorResponse } from "@/lib/hr-ops-reports/http";
import { notifyReportReady } from "@/lib/hr-ops-reports/notify";
import { isIsoDay, periodFor } from "@/lib/hr-ops-reports/periods";
import { findReportByPeriod } from "@/lib/hr-ops-reports/store";
import { HR_OPS_REPORT_KINDS, type HrOpsReportKind } from "@/lib/hr-ops-reports/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The HR Manager's Build / Rebuild: a daily report for any finished working day, or the weekly
// report for the week holding a date. A report still with her is refreshed (her answers are kept);
// a submitted or decided one is left exactly as it was. Writes report rows — never a deduction.
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_ops_reports", "approve");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "hr-ops-reports:rebuild",
      windowMs: 60_000,
    });

    const body = ((await request.json().catch(() => null)) ?? {}) as { kind?: unknown; date?: unknown };
    const kind = String(body.kind ?? "") as HrOpsReportKind;
    if (!(HR_OPS_REPORT_KINDS as readonly string[]).includes(kind)) {
      return NextResponse.json({ message: "Choose a daily or a weekly report." }, { status: 400 });
    }
    if (!isIsoDay(body.date)) return NextResponse.json({ message: "Choose a date." }, { status: 400 });
    const period = periodFor(kind, body.date);
    if (!period) {
      return NextResponse.json({ message: "There is no report for that day — Friday is the weekend." }, { status: 400 });
    }

    const built = await buildHrOpsReport({ period, today: cairoTodayIso() });
    if (built.created) {
      const report = await findReportByPeriod(built.periodKey);
      if (report) await notifyReportReady(report, built.flaggedCount);
    }
    return NextResponse.json({ ok: true, result: built });
  } catch (error) {
    return hrOpsErrorResponse(error, "Failed to build the report.");
  }
}
