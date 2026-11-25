import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canReadValidationProgress, loadValidationProgress } from "@/lib/phoenix-crm/server/validation-progress";
import { buildValidationProgressWorkbook, validationProgressFileName } from "@/lib/phoenix-crm/server/validation-progress-workbook";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Doctor list validation as Excel (owner, 26 Nov 2026) — the Super Admin's and the SFE Manager's. Read live on every
 * press, so the file always carries the latest validations. Anyone else gets a 404, as on the refused-readings board:
 * the report is simply not a thing that is here for them. Rate-limited and audited.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    if (!(await canAccess(access, "phoenix_crm", "read"))) {
      return NextResponse.json({ error: "not_found", message: "Not found." }, { status: 404 });
    }
    const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
    if (!viewer || !canReadValidationProgress(viewer)) {
      return NextResponse.json({ error: "not_found", message: "Not found." }, { status: 404 });
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:phoenix-crm:validation-progress" });

    const generatedAt = new Date().toISOString();
    const report = await loadValidationProgress(viewer, { line: request.nextUrl.searchParams.get("line") });
    const buffer = await buildValidationProgressWorkbook(report, generatedAt);

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "phoenix_crm_validation_progress_export",
      entityId: null,
      summary: `Exported List Validation, ${report.line ?? "every line"} (${report.totals.reps} reps, ${report.totals.total} AM and PM customers, ${report.totals.notValidated} not validated)`,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${validationProgressFileName(generatedAt, report.line)}"`,
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
    return NextResponse.json({ error: "export_failed", message: clientSafeErrorMessage(error, "List Validation could not be exported.") }, { status: 500 });
  }
}
