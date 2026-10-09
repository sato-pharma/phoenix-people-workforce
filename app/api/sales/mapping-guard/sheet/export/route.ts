import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertGuardSheetOwner, guardSheetFailure } from "@/lib/sales/mapping-guard-sheet-access";
import { loadGuardSheetData } from "@/lib/sales/mapping-guard-sheet";
import { buildGuardWorkbook } from "@/lib/sales/mapping-guard-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The held mapping changes as a workbook: each customer's name, address, brick, area and governorate
 * as Phoenix holds them, as the distributor's own file filed them, and where the held change wanted
 * to put them — with three answer columns to fill in and upload back.
 *
 * Read-only. Super Admin only, server-side, before anything is read.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertGuardSheetOwner(access);
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:sales:mapping-guard" });

    const { bricks, rows } = await loadGuardSheetData();
    const buffer = await buildGuardWorkbook({ bricks, rows });

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-held-mapping-changes.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Held-Rows": String(rows.length),
      },
    });
  } catch (error) {
    return guardSheetFailure(error, "Could not export the held changes.");
  }
}
