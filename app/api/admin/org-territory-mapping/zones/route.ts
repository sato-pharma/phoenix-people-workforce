import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { createLineZone, deleteLineZone, updateLineZone } from "@/lib/sales/territory-mapping/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toRegionCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = await request.json();
    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    await createLineZone({
      actorLoginId,
      zoneCode: typeof body?.zoneCode === "string" ? body.zoneCode : "",
      lineId: Number(body?.lineId),
      rmHrId: typeof body?.rmHrId === "string" ? body.rmHrId : null,
      label: typeof body?.label === "string" ? body.label : "",
      regionCodes: toRegionCodes(body?.regionCodes),
    });

    return NextResponse.json({ success: true, message: "Zone created." });
  } catch (error) {
    return mapZoneError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = await request.json();
    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    await updateLineZone({
      actorLoginId,
      zoneCode: typeof body?.zoneCode === "string" ? body.zoneCode : "",
      rmHrId: typeof body?.rmHrId === "string" ? body.rmHrId : null,
      label: typeof body?.label === "string" ? body.label : "",
      regionCodes: toRegionCodes(body?.regionCodes),
    });

    return NextResponse.json({ success: true, message: "Zone updated." });
  } catch (error) {
    return mapZoneError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = await request.json();
    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const zoneCode = typeof body?.zoneCode === "string" ? body.zoneCode : "";
    if (!zoneCode) {
      return NextResponse.json({ success: false, error: "Zone code is required." }, { status: 400 });
    }
    await deleteLineZone({ actorLoginId, zoneCode });

    return NextResponse.json({ success: true, message: "Zone deleted." });
  } catch (error) {
    return mapZoneError(error);
  }
}

function mapZoneError(error: unknown) {
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
    { success: false, error: error instanceof Error ? error.message : "Zone request failed." },
    { status: 500 },
  );
}
