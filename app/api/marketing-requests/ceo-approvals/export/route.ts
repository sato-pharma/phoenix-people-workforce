import { NextResponse } from "next/server";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { todayInCairo } from "@/lib/date-only";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { clientSafeErrorMessage, forbiddenError, toApiError, validationError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import {
  canViewMarketingCeoApprovals,
  resolveCeoApprovalsCarry,
  resolveCeoApprovalsRange,
} from "@/lib/marketing-requests/ceo-approvals";
import {
  buildCeoApprovalsWorkbook,
  ceoApprovalsExportFileName,
  parseCeoApprovalsExportFormat,
  pickCeoApprovalsExportRows,
  renderCeoApprovalsPdf,
  type CeoApprovalsExportRow,
} from "@/lib/marketing-requests/ceo-approvals-export";
import { getMarketingCeoApprovals } from "@/lib/marketing-requests/ceo-approvals-service";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * CEO Approvals — the ticked rows as a house-style XLSX or PDF (owner, 2026-11-15). The rows are
 * re-read for the posted range behind the page's own gate (`getMarketingCeoApprovals`); the body only
 * names which requests, and the note typed beside each.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertSignedIn(access); // REC-080: the caller is judged before the body.
    // The page's own reader roles (Marketing Manager, CEO, Super Admin), asked again by
    // getMarketingCeoApprovals below: any other role is refused before the body is read (REC-080).
    if (!canViewMarketingCeoApprovals(access.role)) throw forbiddenError("You do not have access to CEO Approvals.");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:marketing:ceo-approvals" });
    const body = ((await request.json().catch(() => null)) ?? {}) as {
      carry?: unknown;
      format?: unknown;
      from?: unknown;
      rows?: unknown;
      to?: unknown;
    };
    const format = parseCeoApprovalsExportFormat(body.format);
    if (!format) throw validationError("Choose XLSX or PDF.");

    const range = resolveCeoApprovalsRange(
      { from: typeof body.from === "string" ? body.from : null, to: typeof body.to === "string" ? body.to : null },
      todayInCairo(),
    );
    const includeCarriedOver = resolveCeoApprovalsCarry(typeof body.carry === "boolean" || typeof body.carry === "string" ? body.carry : null);
    const report = await getMarketingCeoApprovals(access, range, { includeCarriedOver });

    let picked: CeoApprovalsExportRow[];
    try {
      picked = pickCeoApprovalsExportRows(body.rows, report.rows);
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : "The ticked requests could not be read.");
    }

    const generatedAtIso = new Date().toISOString();
    const names = access.hrId ? await namesByHrId([access.hrId]) : new Map<string, string>();
    const exportedByName = (access.hrId && names.get(access.hrId)) || "Phoenix";
    const input = { exportedByName, generatedAtIso, picked, report };

    let bytes: Uint8Array;
    try {
      bytes = format === "xlsx" ? await buildCeoApprovalsWorkbook(input) : await renderCeoApprovalsPdf(input);
    } catch (error) {
      if (error instanceof ChromiumUnavailableError) {
        return NextResponse.json(
          { error: "pdf_unavailable", message: "The PDF could not be made just now. Try again in a minute, or export the XLSX." },
          { status: 503 },
        );
      }
      throw error;
    }

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId ?? null,
      entityId: `ceo-approvals:${range.from}:${range.to}`,
      entityType: "marketing_request",
      newValues: { carry: includeCarriedOver, format, range, requestIds: picked.map(({ row }) => row.requestId) },
      summary: `Exported CEO Approvals ${range.from} to ${range.to} as ${format.toUpperCase()} (${picked.length} requests)`,
    });

    const fileName = ceoApprovalsExportFileName(range, format);
    return new NextResponse(Buffer.from(bytes) as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Content-Type": format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf",
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
      return NextResponse.json({ error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    const apiError = toApiError(error, "The CEO Approvals export could not be made.");
    return NextResponse.json(
      { error: apiError.code === "internal_error" ? "ceo_approvals_export_failed" : apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
