import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadExecutiveReport } from "@/lib/sales/executive-report";
import { buildExecutiveReportWorkbook } from "@/lib/sales/executive-report-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slug(value: string | null | undefined) {
  return (value ?? "all-time").toString().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "all-time";
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Executive Report export is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "export");

    const body = (await request.json().catch(() => ({}))) as { period?: string | null };
    // The body is only the period selection — never trusted for data or authorization. "all" /
    // empty → all-time (null).
    const period = !body.period || body.period === "all" ? null : body.period;

    const report = await loadExecutiveReport(period);
    const buffer = await buildExecutiveReportWorkbook(report);
    const fileName = `phoenix-executive-report-${slug(report.period)}.xlsx`;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to export Executive Report." },
      { status: 500 },
    );
  }
}
