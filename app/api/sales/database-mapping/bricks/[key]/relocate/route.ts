import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { describeBrickRelocation } from "@/lib/sales/master-data/brick-move-result";
import { relocateBrick } from "@/lib/sales/master-data/import-service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The move is one database transaction with its own two-minute limit.
export const maxDuration = 150;

type RouteContext = {
  params: Promise<{ key: string }>;
};

// Moves a brick to the block it really belongs to ("Correct in database"): one database transaction
// makes the new brick, keeps the old one as history and carries its pharmacies and open-month sales
// (see relocateBrick). Super Admin only, like the rest of the Database Mapping screen.
export async function POST(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Only the Super Admin can move a brick." }, { status: 403 });
    }
    await assertPermission(access, "sales", "update");

    const { key } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { newBlockCode?: unknown; brickName?: unknown };
    if (typeof body.newBlockCode !== "string" || !body.newBlockCode.trim()) {
      return NextResponse.json({ success: false, error: "Pick the block the brick belongs to." }, { status: 400 });
    }

    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const outcome = await relocateBrick({
      actorLoginId,
      brickId: key,
      newBlockCode: body.newBlockCode,
      newBrickName: typeof body.brickName === "string" ? body.brickName : undefined,
    });
    if (!outcome.success) {
      return NextResponse.json({ success: false, error: outcome.error }, { status: 400 });
    }

    const lines = describeBrickRelocation(outcome.result);
    return NextResponse.json({
      lines,
      message: lines.join(" "),
      move: outcome.result,
      newBrickId: outcome.result.newBrickId,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "The brick could not be moved. Nothing was moved.") },
      { status: 500 },
    );
  }
}
