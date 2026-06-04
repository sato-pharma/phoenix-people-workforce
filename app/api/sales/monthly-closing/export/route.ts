import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadMonthlyClosingComparison } from "@/lib/sales/monthly-closing-comparison";
import { buildMonthlyClosingWorkbook } from "@/lib/sales/monthly-closing-export";
import { loadMonthlyClosing } from "@/lib/sales/monthly-distributor-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slug(value: string | null | undefined) {
  return (value ?? "all").toString().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "all";
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Monthly Closing export is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "export");

    const body = (await request.json().catch(() => ({}))) as { line?: string | null; period?: string | null };

    // Server-load the full report (matrix + distributor comparison + insights). The body is
    // only the line/period selection — never trusted for data or authorization.
    const matrix = await loadMonthlyClosing({ line: body.line ?? null, period: body.period ?? null });
    const comparison = await loadMonthlyClosingComparison(matrix.line, matrix.period);

    const buffer = await buildMonthlyClosingWorkbook(matrix, comparison);
    const fileName = `phoenix-monthly-closing-${slug(matrix.line)}-${slug(matrix.period)}.xlsx`;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to export Monthly Closing." },
      { status: 500 },
    );
  }
}
