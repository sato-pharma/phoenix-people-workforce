import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { listCandidatesForMonth } from "@/lib/deductions/service.ts";
import { deductionsCategories, type DeductionsCategory } from "@/lib/deductions/types.ts";
import { buildDeductionsCategoryWorkbook } from "@/lib/deductions/exports/category-workbook.ts";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";
import { writeAuditLog } from "@/lib/admin/audit";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // This endpoint returns EVERY employee's deduction amounts for the month, company-wide.
    // Two gates, deliberately, because the first one alone was not enough:
    //   - "export", not "read": a role granted read-only (Regional Manager) must not be able to
    //     take the whole company's payroll data out of the system as a file.
    //   - assertDeductionsReadActor: the module's own stated audience (Super Admin / CEO /
    //     Finance Manager). The RBAC grant `deductions: ["read"]` exists on Regional Manager to
    //     describe their PORTAL subtree view, so the matrix alone is one role too wide here.
    await assertPermission(access, "deductions", "export");
    assertDeductionsReadActor(access);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:deductions:category" });

    const url = new URL(request.url);
    const monthKey = url.searchParams.get("monthKey");
    if (!monthKey) {
      throw new Error("Validation: monthKey query parameter is required (YYYY-MM).");
    }
    const categoryParam = url.searchParams.get("category");
    if (!categoryParam || !(deductionsCategories as readonly string[]).includes(categoryParam)) {
      throw new Error(`Validation: category query parameter must be one of ${deductionsCategories.join(", ")}.`);
    }
    const category = categoryParam as DeductionsCategory;

    const [candidates, names] = await Promise.all([
      listCandidatesForMonth({ monthKey, category }),
      namesByHrId([access.hrId]),
    ]);
    const workbook = buildDeductionsCategoryWorkbook({
      meta: {
        category,
        monthKey,
        generatedAtIso: new Date().toISOString(),
        // A person is named, never coded, on the sheet.
        generatedByName: names.get(access.hrId ?? "") ?? access.hrId ?? access.loginId ?? "system",
        generatedByHrId: access.hrId ?? "",
      },
      candidates,
    });

    const buffer = await workbook.xlsx.writeBuffer();
    // Every employee's amounts leaving the system as a file is recorded (access-registry: audit required).
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "deduction_export",
      entityId: null,
      newValues: { category, monthKey, rows: candidates.length },
      summary: `Exported ${category} deductions for ${monthKey} (${candidates.length} rows)`,
    });
    return new NextResponse(buffer as ArrayBuffer, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="deductions-${category}-${monthKey}.xlsx"`,
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return jsonError(error, "Failed to export deduction candidates.");
  }
}
