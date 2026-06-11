import { NextResponse } from "next/server";

import { assertPermission, type PermissionAction } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { resolveSalesAccessScope, type SalesAccessScope } from "@/lib/sales/access-scope";

// Shared resolver for every Sales Intelligence route: authenticate, enforce the sales
// permission, parse period + the (role-gated) restricted-products opt-in, and resolve the
// caller's access scope. `includeRestricted` is read from the query but the scope resolver
// IGNORES it for any role other than CEO/Super Admin — so tampering cannot reveal LA003/04.
export async function resolveSiContext(
  request: Request,
  opts?: { action?: PermissionAction },
): Promise<{ scope: SalesAccessScope; period: string | null }> {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "sales", opts?.action ?? "read");

  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period");
  // "all" / empty → all-time (null). Any concrete YYYY-MM narrows to that month.
  const period = !periodParam || periodParam === "all" ? null : periodParam;
  const includeRestricted = url.searchParams.get("includeRestricted") === "1";

  const scope = await resolveSalesAccessScope(access, { includeRestricted });
  return { scope, period };
}

/** Thin wrapper: resolve scope, run the loader, map errors to the standard JSON envelope. */
export async function handleSiRequest<T>(
  request: Request,
  run: (scope: SalesAccessScope, period: string | null) => Promise<T>,
): Promise<Response> {
  try {
    const { scope, period } = await resolveSiContext(request);
    const data = await run(scope, period);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load sales intelligence." },
      { status: 500 },
    );
  }
}
