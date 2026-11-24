import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { repVisitsExportFileName } from "@/lib/rep-visits-export/rules";
import { canExportRepVisits, loadRepVisitsExport } from "@/lib/rep-visits-export/server";
import { buildRepVisitsWorkbook } from "@/lib/rep-visits-export/workbook";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORBIDDEN = "The rep visits export is for the Super Admin.";

/**
 * Rep visits export as Excel (owner, 24 Nov 2026) — one rep, one range: the Cover, the visits day by day, the
 * area's bricks, repeats, every day's record, the doctor list by brick. The Super Admin's alone: it carries
 * salary, leave decisions and deductions. The gate is asked here before any read and again in the loader.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    if (!canExportRepVisits(access) || !(await canAccess(access, "phoenix_crm", "read"))) {
      return NextResponse.json({ error: "forbidden", message: FORBIDDEN }, { status: 403 });
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:rep-visits" });

    const params = request.nextUrl.searchParams;
    const data = await loadRepVisitsExport(access, { hrId: params.get("rep"), from: params.get("from"), to: params.get("to") });
    const buffer = await buildRepVisitsWorkbook(data);
    const fileName = repVisitsExportFileName(data.rep.name, data.from, data.to);

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "rep_visits_export",
      entityId: data.rep.hrId,
      summary: `Exported the visits, bricks and doctors of ${data.rep.name}, ${data.from} to ${data.to} (${data.visits.length} visits)`,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${fileName}"`,
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
    if (isForbiddenError(error) || (error instanceof ApiError && error.status === 403)) {
      return NextResponse.json({ error: "forbidden", message: clientSafeErrorMessage(error, FORBIDDEN) }, { status: 403 });
    }
    if (error instanceof ApiError && error.status === 400) {
      return NextResponse.json({ error: error.code, message: clientSafeErrorMessage(error, "Check the rep and the dates.") }, { status: 400 });
    }
    return NextResponse.json({ error: "export_failed", message: clientSafeErrorMessage(error, "The rep visits export could not be made.") }, { status: 500 });
  }
}
