import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SALES_LINES, loadTargetableAreas } from "@/lib/sales/monthly-targets";
import { generateTargetsTemplate } from "@/lib/sales/targets-template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sales/targets/template?line=cns -> downloadable xlsx template. When a line is given,
// its valid area codes are listed on a reference sheet. Edit access = sales:import (Super Admin + SFE).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const url = new URL(request.url);
    const lineCode = url.searchParams.get("line");
    const line = SALES_LINES.find((entry) => entry.code === lineCode) ?? null;
    const areas = line ? await loadTargetableAreas(line.code) : [];

    const buffer = await generateTargetsTemplate({ lineLabel: line?.label, areas });
    const fileName = `targets-template${line ? `-${line.code}` : ""}.xlsx`;
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to build the template." }, { status: 500 });
  }
}
