import { NextResponse } from "next/server";

import { jsonError } from "@/app/api/territory-management/_lib/route-utils";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { loadTerritoryMap } from "@/lib/territory-management/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    const params = new URL(request.url).searchParams;
    const lineCode = params.get("lineCode") ?? "";
    const areaCodes = (params.get("areaCodes") ?? "")
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean);

    if (!lineCode) throw new Error("Invalid request: lineCode is required.");
    if (areaCodes.length === 0) throw new Error("Invalid request: at least one area is required.");

    // The service re-checks every requested area against the line's own area map AND the caller's
    // own region scope, so a forged areaCode cannot widen scope beyond either.
    return NextResponse.json(await loadTerritoryMap({ access, areaCodes, lineCode }));
  } catch (error) {
    return jsonError(error, "Failed to load territory map.");
  }
}
