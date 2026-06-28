import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listUserScopeOverrides, updateUserScopeOverride } from "@/lib/auth/scope-visibility";

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
      { error: "scope_visibility_read_failed", message: String(error) },
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

    await updateUserScopeOverride({ loginId, lineNames, productCodes, salesScopeOverride });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.json(
      { error: "scope_visibility_update_failed", message: String(error) },
      { status: 500 },
    );
  }
}
