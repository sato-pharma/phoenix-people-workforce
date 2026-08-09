import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { relocateBrick } from "@/lib/sales/master-data/import-service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ key: string }>;
};

// Moves a brick to a different block by spawning a fresh "{block}-{n}" brick and deactivating the
// old one — see relocateBrick's comment for why this isn't a plain PATCH. Same permission tier as
// editing a row (this IS the brick-move UX), restricted the same way as the rest of this surface.
export async function POST(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "update");

    const { key } = await context.params;
    const body = (await request.json()) as { newBlockCode?: unknown; brickName?: unknown };
    if (typeof body.newBlockCode !== "string" || !body.newBlockCode.trim()) {
      return NextResponse.json({ success: false, error: "newBlockCode is required." }, { status: 400 });
    }

    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await relocateBrick({
      actorLoginId,
      brickId: key,
      newBlockCode: body.newBlockCode,
      newBrickName: typeof body.brickName === "string" ? body.brickName : undefined,
    });
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    const customerNote = result.customersCascadeError
      ? ` Customer mappings did NOT update automatically (${result.customersCascadeError}) — fix manually before the next import.`
      : result.customersCascaded
        ? ` ${result.customersCascaded} customer mapping${result.customersCascaded === 1 ? "" : "s"} moved to the new brick.`
        : "";
    return NextResponse.json({
      success: true,
      newBrickId: result.newBrickId,
      message: `Moved to block ${body.newBlockCode.trim().toUpperCase()} as new brick ${result.newBrickId} ("${key}" deactivated).${customerNote}`,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to relocate brick.") },
      { status: 500 },
    );
  }
}
