import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { upsertLineAreaRegionMap } from "@/lib/sales/territory-mapping/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = await request.json();
    const lineId = Number(body?.lineId);
    const areaCode = typeof body?.areaCode === "string" ? body.areaCode : "";
    const regionCode = typeof body?.regionCode === "string" ? body.regionCode : "";

    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    await upsertLineAreaRegionMap({ actorLoginId, lineId, areaCode, regionCode });

    return NextResponse.json({ success: true, message: "Region saved." });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save the area/region mapping." },
      { status: 500 },
    );
  }
}
