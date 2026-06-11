import { NextResponse } from "next/server";

import { assertPermission, type PermissionAction } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { resolveSalesAccessScope, type SalesAccessScope } from "@/lib/sales/access-scope";
import type { SiDetailsFilters } from "@/lib/sales/intelligence/derive";

// The dashboard/details toolbar pushes these query params; lazy endpoints read the same names so a
// filtered page stays consistent. `product` is read from BOTH `product` and `productFilter` so the
// page-1 toolbar (which uses `productFilter` to avoid colliding with the drill deep-link `?product`)
// and page-2 (which uses `product`) both work.
export function parseSiFilters(url: URL): SiDetailsFilters {
  const get = (key: string) => {
    const value = url.searchParams.get(key);
    return value && value.trim() ? value : null;
  };
  return {
    distributorCode: get("distributor"),
    regionCode: get("region"),
    areaCode: get("area"),
    officialLine: get("line"),
    productCode: get("productFilter") ?? get("product"),
  };
}

// Shared resolver for every Sales Intelligence route: authenticate, enforce the sales
// permission, parse period + the (role-gated) restricted-products opt-in, and resolve the
// caller's access scope. `includeRestricted` is read from the query but the scope resolver
// IGNORES it for any role other than CEO/Super Admin — so tampering cannot reveal LA003/04.
export async function resolveSiContext(
  request: Request,
  opts?: { action?: PermissionAction },
): Promise<{ scope: SalesAccessScope; period: string | null; filters: SiDetailsFilters }> {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "sales", opts?.action ?? "read");

  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period");
  // "all" / empty → all-time (null). Any concrete YYYY-MM narrows to that month.
  const period = !periodParam || periodParam === "all" ? null : periodParam;
  const includeRestricted = url.searchParams.get("includeRestricted") === "1";

  const scope = await resolveSalesAccessScope(access, { includeRestricted });
  return { scope, period, filters: parseSiFilters(url) };
}

/** Thin wrapper: resolve scope, run the loader, map errors to the standard JSON envelope. */
export async function handleSiRequest<T>(
  request: Request,
  run: (scope: SalesAccessScope, period: string | null, filters: SiDetailsFilters) => Promise<T>,
): Promise<Response> {
  try {
    const { scope, period, filters } = await resolveSiContext(request);
    const data = await run(scope, period, filters);
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
