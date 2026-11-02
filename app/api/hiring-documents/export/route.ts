import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, isHiringPaperworkRole } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildHiringDocumentsWorkbook,
  hiringDocumentsExportFilename,
} from "@/lib/hiring-documents/export-workbook";
import {
  describeHiringDocumentFilters,
  filterHiringDocumentEmployees,
  readHiringDocumentFilters,
} from "@/lib/hiring-documents/filters";
import {
  filterHiringDocumentsForAccess,
  getHiringDocumentsDashboard,
  hiringDocumentsErrorMessage,
  isHiringDocumentsSchemaMissing,
} from "@/lib/hiring-documents/service";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Spelled here rather than imported from `download-xlsx-client`, which carries "use client": a
// route handler must not pull a client module into its graph for the sake of one string.
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * GET = the hiring documents readiness pack as one XLSX, in the house identity.
 *
 * THE FILTERS TRAVEL IN THE URL and are applied here with the SAME function the screen filters
 * with — `filterHiringDocumentEmployees`. An export that quietly carried the whole company while HR
 * was looking at one line would be worse than no export at all, and the only way screen and file
 * can be trusted to agree is for one predicate to serve both.
 *
 * THE ROLE GATE IS THE PAGE'S, repeated. `assertPermission` alone is not it: the page also requires
 * a hiring-paperwork role before it renders anything, and a route that asked for less would be a way
 * to download by URL what the screen refuses to show.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");
    if (!isHiringPaperworkRole(access.role)) {
      return NextResponse.json(
        { error: "forbidden", message: "Hiring documents are limited to the HR seats that receive them." },
        { status: 403 },
      );
    }
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:hiring-documents",
    });

    const dashboard = filterHiringDocumentsForAccess(await getHiringDocumentsDashboard(), access);
    const filters = readHiringDocumentFilters(new URL(request.url).searchParams);
    const employees = filterHiringDocumentEmployees(dashboard.employees, dashboard.documents, filters);

    // The exporter's own name comes out of the rows already loaded rather than a second query —
    // and it is a NAME on the cover, never an HR code, because a saved workbook outlives everyone
    // who could still decode the code.
    const exporter = dashboard.employees.find((employee) => employee.hrId === access.hrId);
    const generatedAtIso = new Date().toISOString();

    const buffer = await buildHiringDocumentsWorkbook({
      documents: dashboard.documents,
      employees,
      exportedByHrId: access.hrId,
      exportedByName: exporter?.fullName ?? access.loginId ?? "Phoenix user",
      filters,
      generatedAtIso,
      role: access.role,
    });

    // A file naming individual employees, their hire dates and their missing paperwork leaves the
    // building, so the fact that it was taken is on the record — with the filters, since those are
    // what decide who is in it.
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: null,
      entityType: "hiring_documents_export",
      summary:
        `Exported the hiring documents readiness workbook (${employees.length} employees, `
        + `${dashboard.documents.length} documents) — ${describeHiringDocumentFilters(filters)}`,
    });

    return new NextResponse(buffer as unknown as ArrayBuffer, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${hiringDocumentsExportFilename(generatedAtIso)}"`,
        "content-type": XLSX_MEDIA_TYPE,
      },
      status: 200,
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
        { error: "forbidden", message: hiringDocumentsErrorMessage(error) },
        { status: 403 },
      );
    }
    if (isHiringDocumentsSchemaMissing(error)) {
      return NextResponse.json(
        {
          error: "hiring_documents_schema_missing",
          message: "Hiring documents schema is not ready. Run the Supabase migration for hiring documents.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "hiring_documents_export_failed", message: hiringDocumentsErrorMessage(error) },
      { status: 500 },
    );
  }
}
