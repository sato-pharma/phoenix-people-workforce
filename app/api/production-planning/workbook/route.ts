import { NextResponse } from "next/server";

import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { resolveAccessContext } from "@/lib/auth/server";
import { productionPlanningErrorResponse } from "@/lib/production-planning/http";
import { getProductionPlanningWorkspace } from "@/lib/production-planning/service";
import {
  buildProductionPlanningWorkbook,
  PRODUCTION_PLANNING_WORKBOOK_MEDIA_TYPE,
  productionPlanningWorkbookFilename,
} from "@/lib/production-planning/workbook";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — the plan as a working Excel model, built fresh on every request.
 *
 * The owner asked for the formulas, not the answers, so this is not a printout: the yellow cells are
 * his inputs and every other cell is a live formula over them (src/lib/production-planning/workbook.ts).
 *
 * The plan is recomputed here through the same service the screen reads, from the same four query
 * parameters, so the file cannot answer a different question from the page that offered it. The gate
 * is `resolveProductionPlanningLevel` inside the service — the module's five named people — and it
 * admits READ as well as full control: the Finance Manager's whole use of this module is to take the
 * cost away in a spreadsheet.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const workspace = await getProductionPlanningWorkspace(access, {
      productId: url.searchParams.get("productId"),
      mode: url.searchParams.get("mode") ?? undefined,
      requestedQty: url.searchParams.get("requestedQty") ?? undefined,
      sampleUnits: url.searchParams.get("sampleUnits") ?? undefined,
      overridePct: url.searchParams.get("overridePct") ?? undefined,
    });
    if (!workspace.plan) {
      return NextResponse.json({ message: "لا يوجد منتج لحساب احتياجه." }, { status: 400 });
    }
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:production-planning:workbook",
    });

    const { buffer, stats } = await buildProductionPlanningWorkbook(workspace, {
      actorName: access.loginId ?? access.hrId ?? null,
    });
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${productionPlanningWorkbookFilename(workspace.plan)}"`,
        "Content-Type": PRODUCTION_PLANNING_WORKBOOK_MEDIA_TYPE,
        "X-Phoenix-Materials": String(stats.materials),
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return productionPlanningErrorResponse(error, "Could not build the workbook.");
  }
}
