import { NextResponse } from "next/server";

import { jsonError } from "@/app/api/territory-management/_lib/route-utils";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { saveBrickPin } from "@/lib/territory-management/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Move a brick's pin by hand. Super Admin ONLY: a manual pin becomes the authoritative coordinate
 * for that brick and outranks every geocode, so the ability to set one is deliberately narrow.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    if (access.role !== "Super Admin") {
      throw new Error("Forbidden: only a Super Admin can move a brick pin.");
    }

    const body = (await request.json()) as { brickId?: unknown; lat?: unknown; lng?: unknown };
    const saved = await saveBrickPin({
      brickId: typeof body.brickId === "string" ? body.brickId : "",
      lat: Number(body.lat),
      lng: Number(body.lng),
      placedByHrId: access.hrId ?? null,
    });

    return NextResponse.json({ ok: true, ...saved });
  } catch (error) {
    return jsonError(error, "Failed to save brick pin.");
  }
}
