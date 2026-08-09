import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isMasterKey } from "@/lib/sales/master-data/definitions";
import { setMasterRowActive, updateSingleMasterRow } from "@/lib/sales/master-data/import-service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ master: string; key: string }>;
};

// PATCH edits the row's editable columns and/or reactivates it (`{ active: true }`); DELETE
// deactivates it. Both are soft — see setMasterRowActive's comment for why a hard delete isn't
// offered. Master-data mutation surface — restricted the same way as the add-row POST route.
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "update");

    const { master, key } = await context.params;
    if (!isMasterKey(master)) {
      return NextResponse.json({ success: false, error: "Unknown master table." }, { status: 404 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

    if (typeof body.active === "boolean") {
      const activeResult = await setMasterRowActive({ actorLoginId, master, key, active: body.active });
      if (!activeResult.success) {
        return NextResponse.json({ success: false, error: activeResult.error }, { status: 400 });
      }
    }

    const patch = { ...body } as Record<string, string>;
    delete patch.active;
    const hasPatch = Object.keys(patch).length > 0;

    if (hasPatch) {
      const editResult = await updateSingleMasterRow({ actorLoginId, master, key, patch });
      if (!editResult.success) {
        return NextResponse.json({ success: false, error: editResult.error }, { status: 400 });
      }
    } else if (typeof body.active !== "boolean") {
      return NextResponse.json({ success: false, error: "Nothing to update." }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: "Row updated successfully." });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to update row.") },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "delete");

    const { master, key } = await context.params;
    if (!isMasterKey(master)) {
      return NextResponse.json({ success: false, error: "Unknown master table." }, { status: 404 });
    }

    const actorLoginId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await setMasterRowActive({ actorLoginId, master, key, active: false });
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: "Row deactivated successfully." });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to deactivate row.") },
      { status: 500 },
    );
  }
}
