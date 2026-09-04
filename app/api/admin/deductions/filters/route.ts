import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { listCandidatesForMonth } from "@/lib/deductions/service.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { buildDeductionsOrgGroups, type DeductionsOrgInfo } from "@/lib/deductions/org-filter.ts";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Line / Region buckets that exist in one month's deductions.
 *
 * Feeds the two dropdowns beside the Master XLSX button. It returns the (line,
 * region) PAIRS with their sizes rather than two independent lists, because the
 * screen has to answer a third question the lists cannot: how many deductions
 * the CURRENT combination will download. Summing the pairs client-side answers
 * all three from one payload, so the count promised beside the button and the
 * rows the workbook actually contains are derived from the same grouping.
 *
 * Deliberately month-scoped, not the master `lines`/`au_v_regions` tables: a
 * dropdown built from master data offers combinations that hold nothing, and
 * "0 rows" then looks identical to a broken export.
 *
 * Carries no names, no amounts and no HR ids — only org labels and counts.
 * Same gate as the sibling read routes all the same: this still describes where
 * a month's deductions fell.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    assertDeductionsReadActor(access);

    const url = new URL(request.url);
    const monthKey = url.searchParams.get("monthKey");
    if (!monthKey) {
      throw new Error("Validation: monthKey query parameter is required (YYYY-MM).");
    }

    const [candidates, directoryRows] = await Promise.all([
      listCandidatesForMonth({ monthKey }),
      // Leavers included, for the same reason the Master export includes them:
      // a deduction can belong to someone who has since left, and their line
      // and region are still where that deduction happened.
      getEmployeeDirectoryRows({ includeInactive: true }),
    ]);

    const orgByCompactHrId = new Map<string, DeductionsOrgInfo>();
    for (const row of directoryRows) {
      const compact = compactDeductionsHrId(row.hrId);
      if (!compact || orgByCompactHrId.has(compact)) continue;
      orgByCompactHrId.set(compact, {
        lineName: row.lineName,
        regionName: row.regionName,
        managerName: row.managerName,
      });
    }

    const groups = buildDeductionsOrgGroups(candidates, orgByCompactHrId);

    return NextResponse.json({
      success: true,
      monthKey,
      groups,
      totals: {
        candidates: candidates.length,
        employees: new Set(candidates.map((candidate) => candidate.employeeHrIdCompact)).size,
      },
    });
  } catch (error) {
    return jsonError(error, "Failed to load the deduction filter options.");
  }
}
