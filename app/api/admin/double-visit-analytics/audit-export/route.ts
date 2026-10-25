import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { cairoTodayIso } from "@/lib/crm/dates";
import {
  buildCombinedAuditWorkbook,
  buildDoubleVisitAuditWorkbook,
  loadDoubleVisitAuditData,
  splitRangeByMonth,
  type AuditPeriodFilter,
  type AuditRoleFilter,
} from "@/lib/double-visit-analytics/audit-export";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS: AuditPeriodFilter[] = ["ALL", "AM", "PM", "Pharmacies"];
const ROLES: AuditRoleFilter[] = ["ALL", "DSM", "GPM", "MM", "NSM", "PM", "RM", "SFE", "TM"];

function dateOr(value: string | null, fallback: string): string {
  const text = (value ?? "").slice(0, 10);
  return DATE_RE.test(text) ? text : fallback;
}

/** First and last day of the current Cairo month — the board's default window when none is given. */
function currentMonthBounds(): { start: string; end: string } {
  const today = cairoTodayIso();
  const [year, month] = today.split("-").map((part) => Number(part));
  const start = `${today.slice(0, 7)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start, end: `${today.slice(0, 7)}-${String(lastDay).padStart(2, "0")}` };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "double_visit_analytics", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:double-visit-audit" });

    const url = new URL(request.url);
    const month = currentMonthBounds();
    const dateFrom = dateOr(url.searchParams.get("dateFrom"), month.start);
    const dateTo = dateOr(url.searchParams.get("dateTo"), month.end);
    const roleParam = url.searchParams.get("role");
    const periodParam = url.searchParams.get("period");
    const role: AuditRoleFilter = ROLES.includes(roleParam as AuditRoleFilter) ? (roleParam as AuditRoleFilter) : "ALL";
    const period: AuditPeriodFilter = PERIODS.includes(periodParam as AuditPeriodFilter)
      ? (periodParam as AuditPeriodFilter)
      : "ALL";

    // A coaching audit must SURFACE the resigned / reused-slot reps (flagged by the Status column),
    // not hide them as the live board does — that is the whole point of the sheet, and it is what
    // makes the export match the hand-built audit the owner approved.
    // split=month keeps each calendar month's own figures in one workbook (one tab per coach per
    // month); otherwise the whole range is a single audit.
    const splitByMonth = url.searchParams.get("split") === "month";
    let workbook;
    if (splitByMonth) {
      const sections = await Promise.all(
        splitRangeByMonth(dateFrom, dateTo).map(async (month) => ({
          label: month.label,
          data: await loadDoubleVisitAuditData({
            access,
            dateFrom: month.from,
            dateTo: month.to,
            role,
            period,
            includeResignedAgents: true,
          }),
        })),
      );
      workbook = await buildCombinedAuditWorkbook(sections);
    } else {
      const data = await loadDoubleVisitAuditData({ access, dateFrom, dateTo, role, period, includeResignedAgents: true });
      workbook = await buildDoubleVisitAuditWorkbook(data);
    }
    const buffer = await workbook.xlsx.writeBuffer();
    const body = buffer instanceof ArrayBuffer ? buffer : Buffer.from(buffer);
    return new NextResponse(body, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="double-visit-coaching-audit-${dateFrom}-to-${dateTo}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to export Double Visit Analytics." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: "double_visit_audit_export_failed",
        message: clientSafeErrorMessage(error, "Double Visit coaching audit export failed."),
      },
      { status: 500 },
    );
  }
}
