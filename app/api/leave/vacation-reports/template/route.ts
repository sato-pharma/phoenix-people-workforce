import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { exportVacationReportTemplateToExcel } from "@/lib/leave/service";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const buffer = await exportVacationReportTemplateToExcel(access);
    return new Response(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="phoenix-historical-vacation-template-${new Date().toISOString().slice(0, 10)}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to export vacation report template." }, { status: 400 });
  }
}
