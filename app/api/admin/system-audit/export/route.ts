import { PassThrough, Readable } from "node:stream";

import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext, resolveCurrentUserDisplay } from "@/lib/auth/server";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import {
  SYSTEM_AUDIT_XLSX_ROW_LIMIT,
  SystemAuditExportTooLargeError,
  createSystemAuditCsvStream,
  resumeBatches,
  systemAuditExportFilename,
  writeSystemAuditWorkbook,
  type ExportFinish,
} from "@/lib/system-audit/export";
import { describeSystemAuditFilters, isSystemAuditQueryError, parseSystemAuditQuery } from "@/lib/system-audit/page-query";
import { iterateSystemAuditExport, loadSystemAuditPage } from "@/lib/system-audit/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/admin/system-audit/export?format=csv|xlsx&<the same filters as the page>
 *
 * EVERY filtered row — the keyset walk of `iterateSystemAuditExport`, streamed as it arrives —
 * never the screen page and never PostgREST's 1,000-row cap. The first batch is read before the
 * response starts, so a database that cannot answer returns a plain error rather than a half file.
 *
 * CSV has no limit. XLSX refuses above 100,000 rows with a sentence pointing at the CSV, checked
 * against the screen total BEFORE the download starts. One audit_logs row per export: who, the
 * filters and the row count actually written (or how far it got before it failed).
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    const expired = unauthenticatedSessionResponse(access);
    if (expired) return expired;
    assertSystemAdministratorWorkspaceAccess(access, "the System Error & Data Integrity Audit export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:system-audit" });

    const params = new URL(request.url).searchParams;
    const format = (params.get("format") ?? "").toLowerCase();
    if (format !== "csv" && format !== "xlsx") {
      return NextResponse.json(
        { error: "invalid_query", message: "Choose the export format: csv or xlsx." },
        { status: 400 },
      );
    }
    const query = parseSystemAuditQuery(params);
    const filtersLine = describeSystemAuditFilters(query.filters);

    if (format === "xlsx") {
      // The export batches carry no total, so the screen's count decides the XLSX limit up front.
      const counted = await loadSystemAuditPage({ filters: query.filters, sort: "occurred_desc", limit: 1, offset: 0 });
      if (counted.total > SYSTEM_AUDIT_XLSX_ROW_LIMIT) {
        const refusal = new SystemAuditExportTooLargeError(counted.total);
        return NextResponse.json({ error: "too_large", message: refusal.message }, { status: 413 });
      }
    }

    const iterator = iterateSystemAuditExport(query.filters)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const batches = resumeBatches(first, iterator);

    const actorLoginId = access.loginId ?? null;
    const actorHrId = hrIdForStorage(access.hrId);
    const filename = systemAuditExportFilename(format);
    const recordExport = async ({ rows, error }: ExportFinish) => {
      const outcome = error
        ? `stopped after ${rows.toLocaleString("en-US")} rows: ${clientSafeErrorMessage(error, "the download did not finish")}`
        : `${rows.toLocaleString("en-US")} rows`;
      await writeAuditLog({
        actorLoginId,
        entityId: filename,
        entityType: "system_audit_export",
        newValues: { actorHrId, error: error ? clientSafeErrorMessage(error, "unknown") : null, filters: query.filters, format, rows },
        summary: `System audit ${format.toUpperCase()} export — ${outcome}. Filters: ${filtersLine}.`,
      });
    };

    if (format === "csv") {
      const body = createSystemAuditCsvStream(batches, recordExport);
      return new Response(body, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${filename}"`,
          "content-type": "text/csv; charset=utf-8",
        },
      });
    }

    const generatedBy = (await resolveCurrentUserDisplay(access.loginId)).name || actorHrId || "Super Admin";
    const pass = new PassThrough();
    // Written in the background; the response streams from `pass` as bytes are produced. A failure
    // destroys the stream so the browser reports a failed download instead of saving a cut file.
    const progress = { rows: 0 };
    void (async () => {
      try {
        const { rows } = await writeSystemAuditWorkbook(batches, pass, { filters: filtersLine, generatedBy, progress });
        await recordExport({ rows, error: null });
      } catch (error) {
        await recordExport({ rows: progress.rows, error }).catch(() => undefined);
        pass.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    return new Response(Readable.toWeb(pass) as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isSystemAuditQueryError(error)) {
      return NextResponse.json({ error: "invalid_query", message: error.message }, { status: 400 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    const reason = clientSafeErrorMessage(error, "the ledger did not answer");
    return NextResponse.json({ error: "unavailable", message: `Export unavailable — ${reason}` }, { status: 500 });
  }
}
