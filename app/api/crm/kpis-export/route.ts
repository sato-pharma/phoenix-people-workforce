import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { cairoTodayIso } from "@/lib/crm/dates";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { getKpisBoard } from "@/lib/crm/kpis-board";
import { buildKpisBoardWorkbook } from "@/lib/crm/kpis-board-workbook";
import { parseKpiFilters } from "@/lib/crm/kpis-filters";
import { resolveRepsPlansMonth } from "@/lib/crm/reps-plans";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The KPIs board as a premium XLSX (owner, 2026-10-25). The SAME gate both KPIs pages use — a field
 * seat with CRM access — and the SAME `getKpisBoard`, so the scope gate inside it decides whose rows
 * the file holds: a District Manager exports his own district and nothing wider. The query string is
 * the board's own (month, period and every advanced filter), so the file is what was on screen.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    if (!canSeeDoctorCoverage(access.role) || !(await canAccess(access, "crm_visits", "read"))) {
      return NextResponse.json(
        { error: "forbidden", message: "KPIs is available to field seats with CRM access." },
        { status: 403 },
      );
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:crm:kpis" });

    const searchParams = new URL(request.url).searchParams;
    const params: Record<string, string | string[]> = {};
    for (const key of new Set(searchParams.keys())) {
      const values = searchParams.getAll(key);
      params[key] = values.length > 1 ? values : (values[0] ?? "");
    }

    const today = cairoTodayIso();
    const month = resolveRepsPlansMonth(searchParams.get("month") ?? undefined, today);
    const board = await getKpisBoard({
      access,
      month,
      period: searchParams.get("period") ?? undefined,
      todayIso: today,
      filters: parseKpiFilters(params),
      coverageDoctors: null,
    });

    const buffer = await buildKpisBoardWorkbook(board, new Date().toISOString());

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "crm_kpis_export",
      entityId: null,
      summary: `Exported the KPIs board (${board.monthLabel}, ${board.range.periodLabel}, ${board.reps.length} reps, ${board.scopeLabel})`,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="kpis-${month}.xlsx"`,
        "cache-control": "no-store",
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
      return NextResponse.json({ error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden") }, { status: 403 });
    }
    return NextResponse.json(
      { error: "server_error", message: clientSafeErrorMessage(error, "The KPIs export could not be built.") },
      { status: 500 },
    );
  }
}
