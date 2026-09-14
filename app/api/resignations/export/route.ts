import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { buildResignationHistoryWorkbook } from "@/lib/resignations/history-export";
import { loadResignationHistoryExport } from "@/lib/resignations/history-export-data";
import { isResignationsSchemaMissing, resignationErrorMessage } from "@/lib/resignations/service";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The Resignations "Export full history" workbook. Gated on resignations:export — not :read — so a
// role granted read-only sight of exits (the Finance Manager) is not handed the whole history as a
// file. The records come from the viewer's own scoped dashboard read, never from the browser.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "resignations", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:resignations:full-history",
    });

    const { lookups, payrollCandidates, records } = await loadResignationHistoryExport(access);
    const buffer = await buildResignationHistoryWorkbook({
      generatedAt: new Date().toISOString(),
      lookups,
      payrollCandidates,
      records,
    });

    // Written BEFORE the file is returned, and a failed write fails the export: a whole history of
    // leavers' salaries that nobody can account for later is worse than a refused download.
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityId: randomUUID(),
      entityType: "resignation_history_export",
      newValues: { payrollCandidates: payrollCandidates.length, records: records.length },
      summary: `Resignations full history exported (${records.length} records, ${payrollCandidates.length} payroll candidates) by ${access.hrId ?? "unknown"}.`,
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-resignations-full-history-${currentCairoDateOnlyIso()}.xlsx"`,
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
      return NextResponse.json({ error: "forbidden", message: resignationErrorMessage(error) }, { status: 403 });
    }
    if (isResignationsSchemaMissing(error)) {
      return NextResponse.json(
        { error: "resignations_schema_missing", message: "Resignations schema is not ready." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "resignations_export_failed", message: clientSafeErrorMessage(error, "Export failed.") },
      { status: 500 },
    );
  }
}
