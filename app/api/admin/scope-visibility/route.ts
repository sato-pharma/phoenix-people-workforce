import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listUserScopeOverrides } from "@/lib/auth/scope-visibility";
import { hrIdForStorage } from "@/lib/hr-id";
import { saveScopeVisibilityForLogin } from "@/lib/sales/product-scope-list";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

    const overrides = await listUserScopeOverrides();
    return NextResponse.json({ overrides });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.json(
      { error: "scope_visibility_read_failed", message: clientSafeErrorMessage(error, "The scope settings could not be read.") },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

    const body = await request.json();
    const { loginId, lineNames, productCodes, salesScopeOverride } = body as {
      loginId: string;
      lineNames: string[] | null;
      productCodes: string[] | null;
      salesScopeOverride: string | null;
    };

    if (!loginId) {
      return NextResponse.json({ error: "loginId is required" }, { status: 400 });
    }

    // The products are also the person's Weekly Sales list: both screens save one list (owner, 2026-09-18).
    const actorId = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    await saveScopeVisibilityForLogin({ loginId, lineNames, productCodes, salesScopeOverride }, actorId);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.json(
      { error: "scope_visibility_update_failed", message: clientSafeErrorMessage(error, "The scope settings could not be saved.") },
      { status: 500 },
    );
  }
}
