import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { listCandidatesForMonth } from "@/lib/deductions/service.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import {
  deductionsOrgFilterSlug,
  filterCandidatesByOrg,
  orgFilterFromSearchParams,
} from "@/lib/deductions/org-filter.ts";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { buildDeductionsMasterWorkbook, type EmployeeOrgInfo } from "@/lib/deductions/exports/master-workbook.ts";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";
import { writeAuditLog } from "@/lib/admin/audit";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // Same two gates as the per-category export: this returns EVERY employee's
    // deduction amounts for the month, so "export" (not "read") plus the module's
    // own Super Admin / CEO / Finance Manager audience check.
    await assertPermission(access, "deductions", "export");
    assertDeductionsReadActor(access);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:deductions:master" });

    const url = new URL(request.url);
    const monthKey = url.searchParams.get("monthKey");
    if (!monthKey) {
      throw new Error("Validation: monthKey query parameter is required (YYYY-MM).");
    }
    // Optional narrowing: ?line=<line name>&region=<region name>, both matched
    // case-insensitively against the employee's own line and region. Absent (or
    // "all") means the whole company — see org-filter.ts, which is also what the
    // screen's dropdowns and its "N of M" preview are built from.
    const filter = orgFilterFromSearchParams(url.searchParams);

    const [allCandidates, directoryRows, names] = await Promise.all([
      listCandidatesForMonth({ monthKey }),
      // Leavers included: a deduction can belong to someone who has since left,
      // and their line + manager still belong on the sheet rather than a blank.
      getEmployeeDirectoryRows({ includeInactive: true }),
      namesByHrId([access.hrId]),
    ]);

    // compact HR id -> line + region + direct manager, keyed the same way
    // candidates are (employee_hr_id_compact), so the Detailed sheet's extra
    // columns resolve AND the Line/Region filter has something to match on.
    //
    // Region comes from `region_name`, never `region_code`: the code is null for
    // Head Office and for any field seat whose (line, area) pair does not resolve
    // to a sales region, and on production the same region name is carried both
    // with and without a code. Keying on the code would split one region in two
    // and put Head Office beyond the reach of the filter entirely.
    const orgByCompactHrId = new Map<string, EmployeeOrgInfo>();
    for (const row of directoryRows) {
      const compact = compactDeductionsHrId(row.hrId);
      if (!compact || orgByCompactHrId.has(compact)) continue;
      orgByCompactHrId.set(compact, {
        lineName: row.lineName,
        regionName: row.regionName,
        managerName: row.managerName,
      });
    }

    const candidates = filterCandidatesByOrg(allCandidates, orgByCompactHrId, filter);

    const workbook = buildDeductionsMasterWorkbook({
      meta: {
        monthKey,
        generatedAtIso: new Date().toISOString(),
        // A person is named, never coded, on the sheet.
        generatedByName: names.get(access.hrId ?? "") ?? access.hrId ?? access.loginId ?? "system",
        generatedByHrId: access.hrId ?? "",
        filter,
      },
      candidates,
      orgByCompactHrId,
    });

    const buffer = await workbook.xlsx.writeBuffer();
    // Every employee's amounts leaving the system as a file is recorded (access-registry: audit required).
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "deduction_export",
      entityId: null,
      newValues: { monthKey, filter, rows: candidates.length },
      summary: `Exported the master deductions workbook for ${monthKey} (${candidates.length} rows)`,
    });
    return new NextResponse(buffer as ArrayBuffer, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        // The filter is in the filename too: a filtered download must never land
        // in the same folder under the same name as the full month's workbook.
        "Content-Disposition": `attachment; filename="deductions-master-${monthKey}${deductionsOrgFilterSlug(filter)}.xlsx"`,
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return jsonError(error, "Failed to export the master deductions workbook.");
  }
}
