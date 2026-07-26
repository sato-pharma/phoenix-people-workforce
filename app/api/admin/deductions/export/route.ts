import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { listCandidatesForMonth } from "@/lib/deductions/service.ts";
import { deductionsCategories, type DeductionsCategory } from "@/lib/deductions/types.ts";
import { buildDeductionsCategoryWorkbook } from "@/lib/deductions/exports/category-workbook.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
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

    const candidates = await listCandidatesForMonth({ monthKey, category });
    const workbook = buildDeductionsCategoryWorkbook({
      meta: {
        category,
        monthKey,
        generatedAtIso: new Date().toISOString(),
        generatedByName: access.hrId ?? access.loginId ?? "system",
        generatedByHrId: access.hrId ?? "",
      },
      candidates,
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(buffer as ArrayBuffer, {
      headers: {
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
