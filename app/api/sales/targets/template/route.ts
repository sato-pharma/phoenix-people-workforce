import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SALES_LINES, loadTargetableAreas, loadTargetableProducts } from "@/lib/sales/monthly-targets";
import { generateTargetsTemplate } from "@/lib/sales/targets-template";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sales/targets/template?line=cns -> downloadable xlsx template. When a line is given,
// its valid area codes are listed on a reference sheet. Edit access = sales:import (Super Admin + SFE).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const url = new URL(request.url);
    const requested = url.searchParams.get("line");
    // The smart template is per-line (its dropdowns + auto-fill need that line's products
    // and areas), so resolve to a concrete line — defaulting to the first when none is given.
    const line = SALES_LINES.find((entry) => entry.code === requested) ?? SALES_LINES[0];
    const [areas, products] = await Promise.all([
      loadTargetableAreas(line.code),
      loadTargetableProducts(line.code),
    ]);

    const buffer = await generateTargetsTemplate({ lineLabel: line.label, areas, products });
    const fileName = `targets-template-${line.code}.xlsx`;
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
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to build the template.") }, { status: 500 });
  }
}
